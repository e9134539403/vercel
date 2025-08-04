import { useCallback, useRef } from "react";

import { useStreamingAvatarContext } from "./context";

/**
 * useVoiceChat
 * ---------------------------------------------------------------------------
 * • Добавляет работу с микрофонным треком (micTrackRef) — нужно, чтобы во
 *   время речи аватара физически глушить аудиопоток и избегать ложных
 *   USER_START‑событий.
 * • Экспортирует micTrackRef наружу.
 * ---------------------------------------------------------------------------
 */
export const useVoiceChat = () => {
  const {
    avatarRef,
    isMuted,
    setIsMuted,
    isVoiceChatActive,
    setIsVoiceChatActive,
    isVoiceChatLoading,
    setIsVoiceChatLoading,
  } = useStreamingAvatarContext();

  /**
   * Ссылка на текущий AudioTrack микрофона; нужна для управления enabled.
   */
  const micTrackRef = useRef<MediaStreamTrack | null>(null);

  /**
   * Старт голосового чата.
   * • Получаем getUserMedia → сохраняем track → attachUserAudio
   * • Вызываем startVoiceChat SDK
   */
  const startVoiceChat = useCallback(
    async (isInputAudioMuted?: boolean) => {
      if (!avatarRef.current) return;

      setIsVoiceChatLoading(true);

      // 1️⃣ Получаем поток микрофона
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      // 2️⃣ Сохраняем трек для дальнейшего mute/unmute
      micTrackRef.current = stream.getAudioTracks()[0] ?? null;
      if (isInputAudioMuted && micTrackRef.current) {
        micTrackRef.current.enabled = false;
      }

      // 3️⃣ Передаём поток в SDK
      await avatarRef.current.startVoiceChat({ isInputAudioMuted });

      setIsVoiceChatLoading(false);
      setIsVoiceChatActive(true);
      setIsMuted(!!isInputAudioMuted);
    },
    [avatarRef, setIsMuted, setIsVoiceChatActive, setIsVoiceChatLoading],
  );

  /** Остановка голосового чата */
  const stopVoiceChat = useCallback(() => {
    if (!avatarRef.current) return;

    avatarRef.current.closeVoiceChat();
    setIsVoiceChatActive(false);
    setIsMuted(true);

    // останавливаем медиатрек и чистим ссылку
    micTrackRef.current?.stop();
    micTrackRef.current = null;
  }, [avatarRef, setIsMuted, setIsVoiceChatActive]);

  /** Глушим входной звук */
  const muteInputAudio = useCallback(() => {
    if (!avatarRef.current) return;

    micTrackRef.current && (micTrackRef.current.enabled = false);
    avatarRef.current.muteInputAudio();
    setIsMuted(true);
  }, [avatarRef, setIsMuted]);

  /** Размьючиваем входной звук */
  const unmuteInputAudio = useCallback(() => {
    if (!avatarRef.current) return;

    micTrackRef.current && (micTrackRef.current.enabled = true);
    avatarRef.current.unmuteInputAudio();
    setIsMuted(false);
  }, [avatarRef, setIsMuted]);

  return {
    startVoiceChat,
    stopVoiceChat,
    muteInputAudio,
    unmuteInputAudio,
    isMuted,
    isVoiceChatActive,
    isVoiceChatLoading,
    micTrackRef, // 👈 экспорт наружу
  };
};
