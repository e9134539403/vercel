import {
  StreamingEvents,
  StartAvatarRequest,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState, useCallback } from "react";
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

// Импортируем конфигурации
import { 
  getOptimalConfig, 
  testConnectionSpeed, 
  checkTriggerWords,
  TRIGGER_CONFIG,
  logPerformanceStats,
  AUDIO_ONLY_CONFIG 
} from "../utils/lowBandwidthConfig";

interface ConnectionInfo {
  speed: number;
  quality: 'poor' | 'moderate' | 'good';
  recommendation: string;
}

function SmartInteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(getOptimalConfig());
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  const [filterActive, setFilterActive] = useState(true);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const avatarRef = useRef<any>(null);
  const isProcessingRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);

  // Тестирование соединения при загрузке
  useEffect(() => {
    const checkConnection = async () => {
      console.log("🔍 Testing connection speed...");
      const speed = await testConnectionSpeed();
      
      let quality: ConnectionInfo['quality'] = 'good';
      let recommendation = 'Стандартное качество видео';
      
      if (speed < 50) {
        quality = 'poor';
        recommendation = 'Рекомендуется режим "только аудио"';
        setIsAudioOnly(true);
      } else if (speed < 100) {
        quality = 'moderate';
        recommendation = 'Низкое качество видео для стабильности';
      }
      
      setConnectionInfo({ speed, quality, recommendation });
      
      // Автоматически выбираем оптимальную конфигурацию
      const optimalConfig = getOptimalConfig(speed);
      setConfig(optimalConfig);
      
      logPerformanceStats();
    };

    checkConnection();
  }, []);

  // Получение токена доступа
  const fetchAccessToken = async () => {
    try {
      const response = await fetch("/api/get-access-token", {
        method: "POST",
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const token = await response.text();
      console.log("✅ Access token obtained");
      return token;
    } catch (error) {
      console.error("❌ Error fetching access token:", error);
      throw error;
    }
  };

  // Умная обработка пользовательских сообщений
  const handleUserMessage = useCallback((event: any) => {
    const userMessage = event.detail?.message || "";
    console.log("👤 User said:", userMessage);

    // Если фильтр отключен - пропускаем все
    if (!filterActive) {
      console.log("🔓 Filter disabled - message passed");
      return;
    }

    // Проверяем триггерные слова
    const hasTrigger = checkTriggerWords(userMessage);
    
    if (!hasTrigger) {
      console.log("🚫 Message blocked - no trigger words found");
      
      // Быстро прерываем аватара
      if (avatarRef.current) {
        try {
          avatarRef.current.interrupt();
        } catch (error) {
          console.warn("⚠️ Could not interrupt avatar:", error);
        }
      }
      return;
    }

    console.log("✅ Message approved - trigger words detected");
  }, [filterActive]);

  // Умное переподключение с экспоненциальной задержкой
  const handleReconnect = useCallback(async () => {
    const maxAttempts = 3;
    reconnectAttemptsRef.current += 1;
    
    console.log(`🔄 Reconnect attempt ${reconnectAttemptsRef.current}/${maxAttempts}`);
    
    if (reconnectAttemptsRef.current > maxAttempts) {
      console.error("❌ Max reconnection attempts reached");
      return;
    }

    // Экспоненциальная задержка: 2s, 4s, 8s
    const delay = Math.pow(2, reconnectAttemptsRef.current) * 1000;
    
    setTimeout(async () => {
      try {
        if (sessionState === StreamingAvatarSessionState.CONNECTED) {
          await startVoiceChat();
          console.log("✅ Reconnected successfully");
          reconnectAttemptsRef.current = 0; // Сброс счетчика при успехе
        }
      } catch (error) {
        console.error("❌ Reconnection failed:", error);
        handleReconnect(); // Повторная попытка
      }
    }, delay);
  }, [sessionState, startVoiceChat]);

  // Запуск сессии с обработкой ошибок
  const startSession = useMemoizedFn(async (needVoice: boolean) => {
    if (isProcessingRef.current) {
      console.log("⏳ Session start already in progress");
      return;
    }
    
    isProcessingRef.current = true;
    reconnectAttemptsRef.current = 0;

    try {
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      avatarRef.current = avatar;

      // Подписываемся только на необходимые события
      avatar.on(StreamingEvents.USER_TALKING_MESSAGE, handleUserMessage);
      avatar.on(StreamingEvents.STREAM_DISCONNECTED, handleReconnect);
      
      // Опциональные события для мониторинга
      avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
        console.log("🗣️ Avatar speaking");
      });
      
      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, () => {
        console.log("🤐 Avatar silent");
      });

      // Используем актуальную конфигурацию
      const currentConfig = isAudioOnly ? AUDIO_ONLY_CONFIG : config;
      await startAvatar(currentConfig);
      
      if (needVoice) {
        await startVoiceChat();
      }

      console.log("🎉 Avatar session started successfully");
    } catch (error) {
      console.error("❌ Failed to start session:", error);
      
      // Показываем пользователю понятную ошибку
      alert(`Не удалось запустить аватара: ${error.message}. Проверьте интернет соединение.`);
    } finally {
      isProcessingRef.current = false;
    }
  });

  // Переключение режима аудио/видео
  const toggleAudioOnly = useCallback(() => {
    setIsAudioOnly(!isAudioOnly);
    console.log(`🔄 Switched to ${!isAudioOnly ? 'audio-only' : 'video'} mode`);
  }, [isAudioOnly]);

  // Переключение фильтра
  const toggleFilter = useCallback(() => {
    setFilterActive(!filterActive);
    console.log(`🔄 Message filter ${!filterActive ? 'enabled' : 'disabled'}`);
  }, [filterActive]);

  // Очистка при размонтировании
  useUnmount(() => {
    if (avatarRef.current) {
      avatarRef.current.off(StreamingEvents.USER_TALKING_MESSAGE, handleUserMessage);
      avatarRef.current.off(StreamingEvents.STREAM_DISCONNECTED, handleReconnect);
    }
    stopAvatar();
    console.log("🧹 Avatar cleaned up");
  });

  // Привязка видео потока
  useEffect(() => {
    if (stream && videoRef.current && !isAudioOnly) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(console.error);
      };
    }
  }, [stream, isAudioOnly]);

  return (
    <div className="w-full flex flex-col gap-4">
      {/* Панель статуса соединения */}
      {connectionInfo && (
        <div className={`p-3 rounded-lg text-sm ${
          connectionInfo.quality === 'poor' 
            ? 'bg-red-900 text-red-200' 
            : connectionInfo.quality === 'moderate'
            ? 'bg-yellow-900 text-yellow-200'
            : 'bg-green-900 text-green-200'
        }`}>
          <div className="flex justify-between items-center">
            <span>
              📡 Соединение: {connectionInfo.speed.toFixed(1)} Мбит/с 
              ({connectionInfo.quality === 'poor' ? 'Слабое' : 
                connectionInfo.quality === 'moderate' ? 'Умеренное' : 'Хорошее'})
            </span>
            <span className="text-xs">{connectionInfo.recommendation}</span>
          </div>
        </div>
      )}

      {/* Основной интерфейс */}
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video overflow-hidden flex flex-col items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            isAudioOnly ? (
              <div className="w-full h-full bg-gradient-to-b from-zinc-800 to-zinc-900 flex items-center justify-center">
                <div className="text-center">
                  <div className="text-6xl mb-4">🎵</div>
                  <div className="text-xl text-zinc-300">Режим "только аудио"</div>
                  <div className="text-sm text-zinc-500 mt-2">Видео отключено для экономии трафика</div>
                </div>
              </div>
            ) : (
              <AvatarVideo ref={videoRef} />
            )
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        
        <div className="flex flex-col gap-3 items-center justify-center p-4 border-t border-zinc-700">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex flex-col gap-3 items-center">
              <div className="flex flex-row gap-4">
                <Button onClick={() => startSession(true)}>
                  🎤 Голосовой режим
                </Button>
                <Button onClick={() => startSession(false)}>
                  ⌨️ Текстовый режим
                </Button>
              </div>
              
              {/* Дополнительные настройки */}
              <div className="flex gap-2">
                <Button 
                  className={`!text-xs !py-1 !px-3 ${isAudioOnly ? '!bg-blue-600' : '!bg-zinc-600'}`}
                  onClick={toggleAudioOnly}
                >
                  {isAudioOnly ? '🔊 Аудио' : '📹 Видео'}
                </Button>
                
                <Button 
                  className={`!text-xs !py-1 !px-3 ${filterActive ? '!bg-green-600' : '!bg-red-600'}`}
                  onClick={toggleFilter}
                >
                  {filterActive ? '🛡️ Фильтр ВКЛ' : '🔓 Фильтр ВЫКЛ'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <LoadingIcon />
              <span className="text-sm text-zinc-400">
                {reconnectAttemptsRef.current > 0 
                  ? `Переподключение... (${reconnectAttemptsRef.current}/3)`
                  : 'Подключение...'
                }
              </span>
            </div>
          )}
        </div>
      </div>
      
      {/* Панель управления и статистики */}
      {sessionState === StreamingAvatarSessionState.CONNECTED && (
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="text-sm">
              <div className="text-zinc-300 font-medium mb-1">🎯 Триггерные слова:</div>
              <div className="text-zinc-400 text-xs">
                {TRIGGER_CONFIG.words.join(", ")}
              </div>
            </div>
            
            <div className="text-sm">
              <div className="text-zinc-300 font-medium mb-1">📊 Статус:</div>
              <div className="text-zinc-400 text-xs">
                Режим: {isAudioOnly ? 'Аудио' : 'Видео'} | 
                Фильтр: {filterActive ? 'Активен' : 'Отключен'}
              </div>
            </div>
          </div>
          
          <MessageHistory />
        </div>
      )}
    </div>
  );
}

export default function SmartInteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <SmartInteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
