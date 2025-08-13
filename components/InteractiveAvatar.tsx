import {
  AvatarQuality,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
  StartAvatarRequest,
  STTProvider,
  ElevenLabsModel,
  TaskType,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { Button } from "./Button";
import { AvatarConfig } from "./AvatarConfig";
import { AvatarVideo } from "./AvatarSession/AvatarVideo";
import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { AvatarControls } from "./AvatarSession/AvatarControls";
import { StreamingAvatarProvider, StreamingAvatarSessionState } from "./logic";
import { LoadingIcon } from "./Icons";
import { MessageHistory } from "./AvatarSession/MessageHistory";

import { AVATARS } from "@/app/lib/constants";

/** === КЛЮЧЕВЫЕ СЛОВА-ТРИГГЕРЫ ===
 * ловим все варианты: "влобстер", "лобстер", "в лобстер" (регистр неважен)
 */
const TRIGGER_RE = /(в\s*лобстер|влобстер|лобстер)/i;

/** Режим транспорта для голоса: WebSocket обычно проще и устойчивее в "жёстких" сетях */
const PREFERRED_TRANSPORT = VoiceChatTransport.WEBSOCKET;

/** Интервал keep-alive (сек) — безопасно <= таймаута бездействия */
const KEEP_ALIVE_EVERY_SEC = 60;

/** Базовая конфигурация старта сессии */
const DEFAULT_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low,                // экономим трафик (360p)
  avatarName: AVATARS[0].avatar_id,
  knowledgeId: undefined,                    // при желании подставь свой ID базы знаний
  voice: {
    rate: 1.3,
    emotion: VoiceEmotion.FRIENDLY,
    model: ElevenLabsModel.eleven_flash_v2_5,
  },
  language: "ru",                            // стт и ответы в России — пусть сразу RU
  voiceChatTransport: PREFERRED_TRANSPORT,
  sttSettings: {
    provider: STTProvider.DEEPGRAM,
    confidence: 0.8,                         // порог уверенности, уменьшит ложные срабатывания
  },
  activityIdleTimeout: 900,                  // 15 минут «жизни» без активности
};

function InteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);

  // DOM-видео для стрима
  const mediaStream = useRef<HTMLVideoElement>(null);

  // Ссылка на инстанс аватара из SDK, чтобы вызывать speak/keepAlive/startListening и т.п.
  const avatarRef = useRef<any>(null);

  // Буфер транскрипции текущей реплики пользователя
  const userUtteranceRef = useRef<string>("");

  // Таймеры
  const keepAliveTimerRef = useRef<any>(null);
  const reconnectTimerRef = useRef<any>(null);
  const reconnectBackoffRef = useRef<number>(2000); // стартовый бэкофф 2с

  async function fetchAccessToken() {
    const resp = await fetch("/api/get-access-token", { method: "POST" });
    if (!resp.ok) throw new Error("Failed to get access token");
    const token = await resp.text();
    return token.trim();
  }

  // ——— Хелперы ———
  const clearTimers = () => {
    if (keepAliveTimerRef.current) {
      clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const scheduleReconnect = useMemoizedFn((reason?: string) => {
    if (reconnectTimerRef.current) return; // уже запланировано
    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null;
      try {
        await startSession(false); // «тихий» перезапуск: слушаем, но не авто-чатим
        reconnectBackoffRef.current = Math.min(
          reconnectBackoffRef.current * 2,
          20000
        ); // до 20с максимум
      } catch (e) {
        // если опять не смогли — запланируем ещё
        scheduleReconnect("retry-error");
      }
    }, reconnectBackoffRef.current);
  });

  const startKeepAlive = useMemoizedFn(() => {
    if (keepAliveTimerRef.current) return;
    keepAliveTimerRef.current = setInterval(async () => {
      try {
        await avatarRef.current?.keepAlive?.(); // метод SDK (обёртка над /v1/streaming.keep_alive)
      } catch {
        // молча — если не вышло, полезно только при живой сессии
      }
    }, KEEP_ALIVE_EVERY_SEC * 1000);
  });

  const resetTranscript = () => {
    userUtteranceRef.current = "";
  };

  const onUserTalkingChunk = (event: any) => {
    // у разных версий SDK поле может называться по-разному:
    const text =
      event?.detail?.text ??
      event?.text ??
      event?.message ??
      (typeof event === "string" ? event : "");
    if (text) userUtteranceRef.current += (userUtteranceRef.current ? " " : "") + text;
  };

  const onUserEndMessage = async () => {
    const phrase = userUtteranceRef.current.trim();
    if (!phrase) return;

    // Триггер?
    const isTriggered = TRIGGER_RE.test(phrase);
    if (isTriggered) {
      try {
        // Даем аватару задачу «поговорить» по содержанию фразы пользователя
        await avatarRef.current?.speak?.({
          text: phrase,
          task_type: TaskType.TALK, // LLM с учётом knowledgeId/knowledgeBase
          // task_mode по умолчанию, можно SYNC/ASYNC; оставим стандарт
        });
      } catch (e) {
        // можно показать тост/лог
      }
    }
    // Важно очищать буфер после каждой завершенной пользовательской реплики
    resetTranscript();
  };

  // ——— Основной запуск сессии ———
  const startSession = useMemoizedFn(async (showUI: boolean) => {
    clearTimers(); // чистим возможные хвосты

    const token = await fetchAccessToken();
    const avatar = initAvatar(token);
    avatarRef.current = avatar;

    // Подписки на события
    avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
      // можно подсветить «говорит»
    });
    avatar.on(StreamingEvents.AVATAR_STOP_TALKING, () => {
      // снять подсветку
    });
    avatar.on(StreamingEvents.STREAM_READY, (e: any) => {
      // стрим готов — можно показывать видео
      startKeepAlive();
      reconnectBackoffRef.current = 2000; // сброс бэкоффа
    });
    avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
      scheduleReconnect("stream-disconnected");
    });

    // Пользователь говорит — копим транскрипт
    avatar.on(StreamingEvents.USER_TALKING_MESSAGE, onUserTalkingChunk);
    avatar.on(StreamingEvents.USER_END_MESSAGE, onUserEndMessage);

    // Стартуем видео-аватар (всегда в эфире)
    await startAvatar({
      ...config,
      activityIdleTimeout: 900,
      voiceChatTransport: PREFERRED_TRANSPORT,
      quality: AvatarQuality.Low,
    });

    // ВАЖНО: не включаем встроенный «voice chat» (он сам отвечает),
    // вместо этого только слушаем микрофон и сами решаем, когда говорить.
    await avatar.startListening();

    // При необходимости, можно показать UI чата. Аргументом управляем отображением/логикой.
    if (showUI) {
      // сейчас не требуется ничего спец.
    }
  });

  useUnmount(() => {
    clearTimers();
    stopAvatar();
  });

  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream;
      mediaStream.current.onloadedmetadata = () => {
        mediaStream.current!.play().catch(() => {});
      };
    }
  }, [mediaStream, stream]);

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video overflow-hidden flex flex-col items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={mediaStream} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>

        <div className="flex flex-col gap-3 items-center justify-center p-4 border-t border-zinc-700 w-full">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex flex-row gap-4">
              <Button onClick={() => startSession(false)}>
                Start (listen-only, gated by trigger)
              </Button>
            </div>
          ) : (
            <LoadingIcon />
          )}
        </div>
      </div>

      {sessionState === StreamingAvatarSessionState.CONNECTED && (
        <MessageHistory />
      )}
    </div>
  );
}

export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
