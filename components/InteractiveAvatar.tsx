// components/InteractiveAvatar.tsx
import {
  AvatarQuality,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
  StartAvatarRequest,
  STTProvider,
  ElevenLabsModel,
} from "@heygen/streaming-avatar";

import { useEffect, useRef, useState, useCallback } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { Button } from "./Button";
import { AvatarConfig } from "./AvatarConfig";
import { AvatarVideo } from "./AvatarSession/AvatarVideo";
import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { AvatarControls } from "./AvatarSession/AvatarControls";
import { useVoiceChat } from "./logic/useVoiceChat";
import {
  StreamingAvatarProvider,
  StreamingAvatarSessionState,
} from "./logic";
import { LoadingIcon } from "./Icons";
import { MessageHistory } from "./AvatarSession/MessageHistory";
import { AVATARS } from "@/app/lib/constants";

// ========== КОНФИГУРАЦИЯ ДЛЯ СЛАБОГО ИНТЕРНЕТА ==========
const PODCAST_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low, // Минимальное качество для экономии трафика
  avatarName: AVATARS[0].avatar_id,
  knowledgeId: undefined, // Отключаем Knowledge Base для локального контроля
  voice: {
    rate: 1.5,
    emotion: VoiceEmotion.EXCITED,
    model: ElevenLabsModel.eleven_flash_v2_5,
  },
  language: "ru", // Русский язык для подкаста
  activityIdleTimeout: 900, // 15 минут таймаут
  
  // КРИТИЧНО для мобильного интернета:
  iceTransportPolicy: "relay", // Форсируем TURN для обхода NAT
  turnServer: "turn:global.relay.heygen.com:443?transport=tcp", // TCP надежнее UDP
  video: true, // Можно отключить для экономии трафика: false
  
  voiceChatTransport: VoiceChatTransport.WEBSOCKET, // WebSocket надежнее
  sttSettings: { 
    provider: STTProvider.DEEPGRAM,
  },
};

// Ключевые слова для активации аватара
const TRIGGER_WORDS = ["влобстер", "лобстер", "в лобстер"];

// Проверка наличия ключевых слов
const containsTriggerWord = (text: string): boolean => {
  const lowerText = text.toLowerCase();
  return TRIGGER_WORDS.some(word => lowerText.includes(word));
};

function InteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(PODCAST_CONFIG);
  const [isListeningMode, setIsListeningMode] = useState(true); // Режим прослушивания по умолчанию
  const [connectionStatus, setConnectionStatus] = useState<string>("idle");
  const [lastUserMessage, setLastUserMessage] = useState<string>("");
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const avatarInstanceRef = useRef<any>(null);
  const configRef = useRef(config);
  const isVoiceChatRef = useRef(false);
  const freezeCountRef = useRef(0);
  const reconnectAttemptsRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 3;
  const MAX_FREEZE_COUNT = 2; // Уменьшаем для быстрого реагирования

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Функция получения токена с retry логикой
  const fetchAccessToken = async (retries = 3): Promise<string> => {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch("/api/get-access-token", {
          method: "POST",
          signal: AbortSignal.timeout(10000), // 10 секунд таймаут
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        console.error(`Token fetch attempt ${i + 1} failed:`, error);
        if (i === retries - 1) throw error;
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // Экспоненциальная задержка
      }
    }
    throw new Error("Failed to fetch token after retries");
  };

  // Мягкий рестарт только медиа-потоков
  const softRestartTracks = useMemoizedFn(async () => {
    if (sessionState !== StreamingAvatarSessionState.CONNECTED) return;
    
    try {
      console.info("🔄 Attempting soft restart...");
      setConnectionStatus("reconnecting");
      
      // Пробуем переподключить только голосовой чат
      if (isVoiceChatRef.current) {
        await startVoiceChat();
      }
      
      freezeCountRef.current = 0;
      setConnectionStatus("connected");
      console.info("✅ Soft restart successful");
    } catch (error: any) {
      console.error("❌ Soft restart failed:", error);
      setConnectionStatus("error");
      
      // Если мягкий рестарт не помог, пробуем жесткий
      if (freezeCountRef.current >= MAX_FREEZE_COUNT) {
        await hardReset();
      }
    }
  });

  // Жесткая перезагрузка всей сессии
  const hardReset = useMemoizedFn(async () => {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      console.error("🚫 Max reconnection attempts reached");
      setConnectionStatus("failed");
      return;
    }

    console.warn("🔴 Initiating hard reset...");
    reconnectAttemptsRef.current++;
    freezeCountRef.current = 0;

    try {
      // Полная остановка
      await stopAvatar();
      await new Promise(r => setTimeout(r, 2000)); // Даем время на очистку
      
      // Новая инициализация
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      
      // Переподключаем обработчики
      setupEventHandlers(avatar);
      
      // Запускаем с актуальной конфигурацией
      await startAvatar(configRef.current);
      
      if (isVoiceChatRef.current) {
        await startVoiceChat();
      }
      
      setConnectionStatus("connected");
      console.info("✅ Hard reset successful");
    } catch (error) {
      console.error("❌ Hard reset failed:", error);
      setConnectionStatus("failed");
    }
  });

  // Настройка обработчиков событий
  const setupEventHandlers = useCallback((avatar: any) => {
    avatarInstanceRef.current = avatar;

    // Обработка отключения
    avatar.on(StreamingEvents.STREAM_DISCONNECTED, async () => {
      console.warn("⚠️ Stream disconnected");
      setConnectionStatus("disconnected");
      await softRestartTracks();
    });

    // Перехват сообщений пользователя для локальной фильтрации
    avatar.on(StreamingEvents.USER_END_MESSAGE, (event: any) => {
      const message = event?.detail?.message || "";
      setLastUserMessage(message);
      
      // Локальная проверка ключевых слов
      if (!containsTriggerWord(message) && isListeningMode) {
        console.log("🔇 Ignoring message (no trigger word):", message);
        
        // Отправляем пустой ответ чтобы аватар молчал
        if (avatarInstanceRef.current) {
          avatarInstanceRef.current.speak({
            text: "ㅤ", // Невидимый символ
            taskType: "TALK",
            taskMode: "ASYNC",
          });
        }
        return false; // Блокируем дальнейшую обработку
      }
      
      console.log("🎯 Trigger word detected, processing:", message);
    });

    // Мониторинг качества соединения
    avatar.on(StreamingEvents.CONNECTION_QUALITY_CHANGED, (event: any) => {
      const quality = event?.detail;
      console.log("📶 Connection quality:", quality);
      
      if (quality === "poor" || quality === "disconnected") {
        setConnectionStatus("poor");
      }
    });

    // Остальные обработчики для логирования
    avatar.on(StreamingEvents.STREAM_READY, () => {
      console.log("✅ Stream ready");
      setConnectionStatus("connected");
      reconnectAttemptsRef.current = 0;
    });

    avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
      console.log("🗣️ Avatar speaking");
    });

    avatar.on(StreamingEvents.AVATAR_STOP_TALKING, () => {
      console.log("🤐 Avatar stopped");
    });
  }, [isListeningMode]);

  // Запуск сессии с оптимизациями
  const startSession = useMemoizedFn(async (enableVoice: boolean) => {
    try {
      setConnectionStatus("connecting");
      
      // Получаем токен с retry
      const token = await fetchAccessToken();
      
      // Инициализация
      const avatar = initAvatar(token);
      setupEventHandlers(avatar);
      
      // Запуск с настройками для слабого интернета
      await startAvatar(configRef.current);
      
      if (enableVoice) {
        await startVoiceChat();
        isVoiceChatRef.current = true;
      }
      
      setConnectionStatus("connected");
    } catch (error) {
      console.error("❌ Session start failed:", error);
      setConnectionStatus("error");
      
      // Автоматическая попытка переподключения
      setTimeout(() => {
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          hardReset();
        }
      }, 5000);
    }
  });

  // Мониторинг зависаний видео
  useEffect(() => {
    if (sessionState !== StreamingAvatarSessionState.CONNECTED) return;

    let prevTime = 0;
    const checkInterval = setInterval(async () => {
      const video = videoRef.current;
      if (!video || !video.srcObject) return;

      const currentTime = video.currentTime;
      
      if (currentTime === prevTime && !video.paused) {
        freezeCountRef.current++;
        console.warn(`⚠️ Video freeze detected (${freezeCountRef.current})`);
        
        if (freezeCountRef.current >= MAX_FREEZE_COUNT) {
          await softRestartTracks();
        }
      } else {
        freezeCountRef.current = 0;
      }
      
      prevTime = currentTime;
    }, 5000); // Проверяем каждые 5 секунд

    return () => clearInterval(checkInterval);
  }, [sessionState, softRestartTracks]);

  // Привязка видео потока
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(e => {
          console.error("Video play error:", e);
        });
      };
    }
  }, [stream]);

  // Очистка при размонтировании
  useUnmount(() => {
    stopAvatar();
  });

  return (
    <div className="w-full flex flex-col gap-4">
      {/* Статус соединения */}
      <div className="flex items-center gap-2 p-2 bg-zinc-800 rounded">
        <div className={`w-3 h-3 rounded-full ${
          connectionStatus === 'connected' ? 'bg-green-500' :
          connectionStatus === 'connecting' || connectionStatus === 'reconnecting' ? 'bg-yellow-500' :
          connectionStatus === 'error' || connectionStatus === 'failed' ? 'bg-red-500' :
          'bg-gray-500'
        }`} />
        <span className="text-sm text-zinc-300">
          Статус: {connectionStatus} | 
          Режим: {isListeningMode ? '🔇 Слушаю' : '🎙️ Активен'} |
          Последнее: {lastUserMessage.slice(0, 30)}...
        </span>
        <Button 
          className="ml-auto !py-1 !px-3 text-xs"
          onClick={() => setIsListeningMode(!isListeningMode)}
        >
          {isListeningMode ? 'Активировать' : 'В режим прослушивания'}
        </Button>
      </div>

      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video overflow-hidden flex flex-col items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={videoRef} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        
        <div className="flex flex-col gap-3 items-center justify-center p-4 border-t border-zinc-700 w-full">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex flex-col gap-3 items-center">
              <div className="flex flex-row gap-4">
                <Button onClick={() => startSession(true)}>
                  🎙️ Запустить для подкаста
                </Button>
                <Button onClick={() => startSession(false)}>
                  💬 Только текст
                </Button>
              </div>
              <div className="text-xs text-zinc-400 text-center">
                Рекомендуется: используйте проводной интернет или стабильный Wi-Fi
              </div>
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
