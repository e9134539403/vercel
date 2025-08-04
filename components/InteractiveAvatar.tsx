// --- InteractiveAvatar.tsx (stable recycle, 3‑min timer) ---

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

/* ---------- DEFAULT CONFIG ---------- */
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
  activityIdleTimeout: 900, // 15‑min peer‑conn timeout
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: { provider: STTProvider.DEEPGRAM },
};

function InteractiveAvatar() {
  const {
    initAvatar,
    startAvatar,
    stopAvatar,
    sessionState,
    stream,
  } = useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  const isVoiceChatRef = useRef(false);
  const recyclingRef = useRef(false); // <-- блокируем параллельные recycle

  const videoRef = useRef<HTMLVideoElement>(null);

  const fetchAccessToken = async () => {
    const res = await fetch("/api/get-access-token", { method: "POST" });
    return res.text();
  };

  /* ---------- timer: recycle каждые 3 мин ---------- */
  useEffect(() => {
    const THREE_MIN = 3 * 60 * 1000;
    const id = setInterval(() => recycleSession("timer"), THREE_MIN);
    return () => clearInterval(id);
  }, []);

  /* ---------- recycleSession ---------- */
  const recycleSession = useMemoizedFn(async (reason: string) => {
    if (recyclingRef.current) return;
    recyclingRef.current = true;
    console.warn(`♻️ recycle triggered (${reason})`);

    const hardStop = async () => {
      try { await stopAvatar(); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 600));
    };

    try {
      await hardStop();
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      wireDisconnect(avatar);

      const safeStart = async () => {
        try {
          await startAvatar(configRef.current);
        } catch (err: any) {
          if (err?.message?.includes("already an active session")) {
            console.warn("retry startAvatar after active-session error");
            await hardStop();
            await startAvatar(configRef.current);
          } else {
            throw err;
          }
        }
      };

      await safeStart();
      if (isVoiceChatRef.current) await startVoiceChat();
      console.info("✅ Avatar session recycled (forced)");
    } catch (e) {
      console.error("recycle failed", e);
    } finally {
      recyclingRef.current = false;
    }
  });

  /* ---------- manual start (Voice/Text) ---------- */
  const startSession = useMemoizedFn(async (needVoice: boolean) => {
    try {
      const tok = await fetchAccessToken();
      const avatar = initAvatar(tok);
      wireDisconnect(avatar);
      await startAvatar(configRef.current);
      if (needVoice) {
        await startVoiceChat();
        isVoiceChatRef.current = true;
      }
    } catch (e) {
      console.error("startSession error", e);
    }
  });

  useUnmount(() => stopAvatar());

  /* ---------- video binding ---------- */
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => videoRef.current?.play();
    }
  }, [stream]);

  /* ---------- JSX ---------- */
  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video flex items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={videoRef} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        <div className="flex flex-col items-center gap-3 p-4 border-t border-zinc-700">
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
