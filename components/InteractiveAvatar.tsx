import {
  AvatarQuality,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
  StartAvatarRequest,
  STTProvider,
  ElevenLabsModel,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { Button } from "./Button";
import { AvatarConfig } from "./AvatarConfig";
import { AvatarVideo } from "./AvatarSession/AvatarVideo";
import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { AvatarControls } from "./AvatarSession/AvatarControls";
import { useVoiceChat } from "./logic/useVoiceChat";
import { StreamingAvatarProvider, StreamingAvatarSessionState } from "./logic";
import { LoadingIcon } from "./Icons";
import { MessageHistory } from "./AvatarSession/MessageHistory";

import { AVATARS } from "@/app/lib/constants";

/**
 * ------------------------------------------------------------------------------------------------------------------
 * ⚙️  ️DEFAULT CONFIG
 * ------------------------------------------------------------------------------------------------------------------
 *  • Подняли provider до `GLADIA` — у него лучше шумодав.
 *  • Порог confidence 0.8 — игнорируем случайные выкрики/смех.
 * ------------------------------------------------------------------------------------------------------------------
 */
const DEFAULT_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low,
  avatarName: AVATARS[0].avatar_id,
  knowledgeId: undefined,
  voice: {
    rate: 1.5,
    emotion: VoiceEmotion.EXCITED,
    model: ElevenLabsModel.eleven_flash_v2_5,
  },
  language: "en",
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: {
    provider: STTProvider.GLADIA,
    confidence: 0.8,
  },
};

function InteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);

  const mediaStream = useRef<HTMLVideoElement>(null);

  /** Получаем access‑token с бэкенда */
  async function fetchAccessToken() {
    const response = await fetch("/api/get-access-token", { method: "POST" });
    if (!response.ok) throw new Error("Token request failed");
    return response.text();
  }

  /**
   * --------------------------------------------------------------------------------------------------------------
   * 🚀  startSessionV2
   * --------------------------------------------------------------------------------------------------------------
   *  • 1) создаём avatar
   *  • 2) сразу выключаем его "слух" (stopListening) — чтоб смех не прерывал речь
   *  • 3) навешиваем хендлеры start/stop talking → управляем очередностью речи
   * --------------------------------------------------------------------------------------------------------------
   */
  const startSessionV2 = useMemoizedFn(async (isVoiceChat: boolean) => {
    try {
      const newToken = await fetchAccessToken();

      // 1️⃣ инициализируем
      const avatar = initAvatar(newToken);

      // 2️⃣ (убрано: преждевременное stopListening вызывало 401)
//    Переключим слушание после успешного запуска сессии ниже

      // 3️⃣ управляем очередностью: когда аватар говорит → mute, когда закончил → unmute
      avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
        avatar.stopListening();
      });
      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, () => {
        avatar.startListening();
      });

      // ──────────────────────────────────────────────────────────────────────────
      // DEBUG‑hендлеры (оставил как были)
      // ──────────────────────────────────────────────────────────────────────────
      avatar.on(StreamingEvents.AVATAR_START_TALKING, (e) =>
        console.log("Avatar started talking", e)
      );
      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, (e) =>
        console.log("Avatar stopped talking", e)
      );
      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () =>
        console.log("Stream disconnected")
      );
      avatar.on(StreamingEvents.STREAM_READY, (event) =>
        console.log(">>>>> Stream ready:", event.detail)
      );
      avatar.on(StreamingEvents.USER_START, (event) =>
        console.log(">>>>> User started talking:", event)
      );
      avatar.on(StreamingEvents.USER_STOP, (event) =>
        console.log(">>>>> User stopped talking:", event)
      );
      avatar.on(StreamingEvents.USER_END_MESSAGE, (event) =>
        console.log(">>>>> User end message:", event)
      );
      avatar.on(StreamingEvents.USER_TALKING_MESSAGE, (event) =>
        console.log(">>>>> User talking message:", event)
      );
      avatar.on(StreamingEvents.AVATAR_TALKING_MESSAGE, (event) =>
        console.log(">>>>> Avatar talking message:", event)
      );
      avatar.on(StreamingEvents.AVATAR_END_MESSAGE, (event) =>
        console.log(">>>>> Avatar end message:", event)
      );

      // 4️⃣ стартуем сессию
      await startAvatar(config);

      // после успешного запуска сразу выключаем слух,
      // чтобы случайные звуки не прервали первую реплику
      await avatar.stopListening();

      if (isVoiceChat) {
        await startVoiceChat();
      }
    } catch (error) {
      console.error("Error starting avatar session:", error);
    }
  });

  // Очищаем сессию при размонтировании компонента
  useUnmount(() => {
    stopAvatar();
  });

  // Подключаем медиапоток к <video>
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream;
      mediaStream.current.onloadedmetadata = () => {
        mediaStream.current!.play();
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
              <Button onClick={() => startSessionV2(true)}>
                Start Voice Chat
              </Button>
              <Button onClick={() => startSessionV2(false)}>
                Start Text Chat
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
