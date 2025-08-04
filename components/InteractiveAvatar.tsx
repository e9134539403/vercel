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
 * DEFAULT_CONFIG — можно поменять avatarName / knowledgeId при желании.
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

  // ⬇️  вытаскиваем micTrackRef для физического mute / unmute
  const { startVoiceChat, micTrackRef } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);
  const mediaStream = useRef<HTMLVideoElement>(null);

  /** Получаем access‑token с бэкенда */
  async function fetchAccessToken() {
    const res = await fetch("/api/get-access-token", { method: "POST" });
    if (!res.ok) throw new Error("Token request failed");
    return res.text();
  }

  /** Запустить сессию */
  const startSession = useMemoizedFn(async (withVoice: boolean) => {
    try {
      const token = await fetchAccessToken();

      /** 1️⃣ создаём avatar */
      const avatar = initAvatar(token);

      /** 2️⃣ управляем очередностью речи и микрофоном */
      avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
        avatar.stopListening();
        micTrackRef.current && (micTrackRef.current.enabled = false); // 🔇 mute
      });

      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, () => {
        micTrackRef.current && (micTrackRef.current.enabled = true);  // 🔊 unmute
        avatar.startListening();
      });

      /** 3️⃣ запускаем сессию */
      await startAvatar(config);

      // первая реплика — отключаем слух, чтобы шум не прерывал
      await avatar.stopListening();

      /** 4️⃣ голосовой чат, если выбран */
      if (withVoice) await startVoiceChat();
    } catch (e) {
      console.error("Error starting session", e);
    }
  });

  /** Чистим сессию при размонтировании */
  useUnmount(stopAvatar);

  /** Подключаем медиапоток к <video> */
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream;
      mediaStream.current.onloadedmetadata = () => mediaStream.current!.play();
    }
  }, [stream]);

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col bg-zinc-900 rounded-xl overflow-hidden">
        <div className="relative w-full aspect-video flex items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={mediaStream} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        <div className="p-4 border-t border-zinc-700 flex flex-col items-center gap-3">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex gap-4">
              <Button onClick={() => startSession(true)}>Start Voice Chat</Button>
              <Button onClick={() => startSession(false)}>Start Text Chat</Button>
            </div>
          ) : (
            <LoadingIcon />
          )}
        </div>
      </div>

      {sessionState === StreamingAvatarSessionState.CONNECTED && <MessageHistory />}
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
