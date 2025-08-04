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

/* ---------------- DEFAULT CONFIG ---------------- */
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
  activityIdleTimeout: 900, // 15‑minute session timeout
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: {
    provider: STTProvider.DEEPGRAM,
  },
};

function InteractiveAvatar() {
  /* ---------- hooks from SDK wrappers ---------- */
  const {
    initAvatar,
    startAvatar,
    stopAvatar,
    sessionState,
    stream,
  } = useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  /* ---------- CONFIG STATE ---------- */
  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);

  /* always‑fresh config reference (avoids stale closure) */
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  /* ---------- VIDEO ELEMENT REF ---------- */
  const mediaStream = useRef<HTMLVideoElement>(null);

  /* ---------- TOKEN FETCH ---------- */
  const fetchAccessToken = async () => {
    const response = await fetch("/api/get-access-token", { method: "POST" });
    const token = await response.text();
    console.log("Access Token:", token);
    return token;
  };

  /* ---------- SOFT RECYCLE EACH 10 MIN ---------- */
  useEffect(() => {
    const TEN_MIN = 10 * 60 * 1000; // production: 10 мин; уменьшите на dev

    const id = setInterval(async () => {
      try {
        // 1) корректно остановить текущую сессию (ждём полного закрытия)
        await stopAvatar(); // корректно остановить текущую сессию
        // небольшой буфер, чтобы сервер закрыл соединение
        await new Promise((r) => setTimeout(r, 500));

        // 2) новый токен + ре‑инициализация SDK
        const token = await fetchAccessToken();
        await initAvatar(token);

        // 3) запуск с актуальным конфигом
        await startAvatar(configRef.current);
        console.info("✅ Avatar session recycled");
      } catch (e) {
        console.error("♻️ Recycle failed", e);
      }
    }, TEN_MIN);

    return () => clearInterval(id); // cleanup on unmount
  }, []); // deps intentionally empty – таймер один на жизнь компонента

  /* ---------- START SESSION (VOICE / TEXT) ---------- */
  const startSessionV2 = useMemoizedFn(async (isVoiceChat: boolean) => {
    try {
      const newToken = await fetchAccessToken();
      const avatar = initAvatar(newToken);

      /* -------- debug events (optional) -------- */
      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () =>
        console.log("Stream disconnected")
      );
      avatar.on(StreamingEvents.STREAM_READY, (event) =>
        console.log(">>>>> Stream ready:", event.detail)
      );

      /* ---------- START AVATAR ---------- */
      await startAvatar(configRef.current);

      /* ---------- START VOICE‑CHAT if requested ---------- */
      if (isVoiceChat) {
        await startVoiceChat({
          ...configRef.current,
          voiceChatIdleTimeout: 900, // 15‑minute Mic timeout
        });
      }
    } catch (error) {
      console.error("Error starting avatar session:", error);
    }
  });

  /* ---------- CLEANUP ON UNMOUNT ---------- */
  useUnmount(() => {
    stopAvatar();
  });

  /* ---------- STREAM TO VIDEO TAG ---------- */
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream;
      mediaStream.current.onloadedmetadata = () => {
        mediaStream.current!.play();
      };
    }
  }, [stream]);

  /* ---------------- RENDER ---------------- */
  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        {/* Video / Config switch */}
        <div className="relative w-full aspect-video overflow-hidden flex flex-col items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={mediaStream} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        {/* Controls */}
        <div className="flex flex-col gap-3 items-center justify-center p-4 border-t border-zinc-700 w-full">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex flex-row gap-4">
              <Button onClick={() => startSessionV2(true)}>Start Voice Chat</Button>
              <Button onClick={() => startSessionV2(false)}>Start Text Chat</Button>
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

/* ---------- PROVIDER WRAPPER ---------- */
export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
