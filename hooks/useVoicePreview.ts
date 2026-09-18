import { useState, useEffect, useRef, useCallback } from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';

/**
 * Shared hook for voice preview playback — live TTS previews, URL-based
 * playback with caching, and preloading. Used by profile, settings, and
 * the onboarding voice-config modal.
 */
export function useVoicePreview() {
  const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const [sound, setSound] = useState<AudioPlayer | null>(null);
  const [cachedSounds, setCachedSounds] = useState<Record<string, AudioPlayer>>({});
  const livePreviewIdRef = useRef<string | null>(null);
  const soundRef = useRef<AudioPlayer | null>(null);
  const cachedSoundsRef = useRef<Record<string, AudioPlayer>>({});
  const previewVoiceAction = useAction(api.aiServices.previewVoice);

  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  useEffect(() => {
    cachedSoundsRef.current = cachedSounds;
  }, [cachedSounds]);

  const cleanupPlayer = useCallback((player: AudioPlayer | null) => {
    if (!player) return;
    try {
      player.removeAllListeners('playbackStatusUpdate');
      player.remove();
    } catch (e) {
      console.error('Error cleaning up player:', e);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (soundRef.current) cleanupPlayer(soundRef.current);
      Object.values(cachedSoundsRef.current).forEach(s => cleanupPlayer(s));
    };
  }, [cleanupPlayer]);

  const stopAllPreviews = async () => {
    livePreviewIdRef.current = null;
    setIsGeneratingPreview(false);
    if (sound) {
      try { sound.pause(); } catch (e) { console.error(e); }
      cleanupPlayer(sound);
      setSound(null);
    }
    for (const s of Object.values(cachedSounds)) {
      cleanupPlayer(s);
    }
    setCachedSounds({});
    setPlayingPreviewId(null);
  };

  const playVoicePreview = async (voiceId: string, previewUrl: string) => {
    livePreviewIdRef.current = null;
    setIsGeneratingPreview(false);
    if (sound) {
      try { sound.pause(); } catch (e) { console.error(e); }
    }

    if (playingPreviewId === voiceId) {
      setPlayingPreviewId(null);
      return;
    }

    setPlayingPreviewId(voiceId);

    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        shouldPlayInBackground: false,
      });

      const cachedPlayer = cachedSounds[voiceId];

      if (cachedPlayer) {
        cachedPlayer.seekTo(0);
        cachedPlayer.play();
        setSound(cachedPlayer);

        const listener = cachedPlayer.addListener('playbackStatusUpdate', (status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingPreviewId(null);
            cachedPlayer.seekTo(0);
          }
        });
      } else {
        const newPlayer = createAudioPlayer({ uri: previewUrl });

        setSound(newPlayer);
        setCachedSounds(prev => ({ ...prev, [voiceId]: newPlayer }));

        const listener = newPlayer.addListener('playbackStatusUpdate', (status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingPreviewId(null);
            newPlayer.seekTo(0);
          }
        });

        newPlayer.play();
      }
    } catch (error) {
      console.error('Error playing voice preview:', error);
      setPlayingPreviewId(null);
    }
  };

  const playLivePreview = async (voiceId: string) => {
    if (sound) {
      try { sound.pause(); } catch (e) { console.error(e); }
    }

    if (playingPreviewId === voiceId) {
      livePreviewIdRef.current = null;
      setPlayingPreviewId(null);
      return;
    }

    livePreviewIdRef.current = voiceId;
    setPlayingPreviewId(voiceId);
    setIsGeneratingPreview(true);
    try {
      const result = await previewVoiceAction({ voiceId });
      if (livePreviewIdRef.current !== voiceId) return;
      if (result.success && result.audioBase64) {
        const uri = `data:audio/mpeg;base64,${result.audioBase64}`;
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
          shouldPlayInBackground: false,
        });
        if (livePreviewIdRef.current !== voiceId) return;
        const newPlayer = createAudioPlayer({ uri });
        if (livePreviewIdRef.current !== voiceId) {
          cleanupPlayer(newPlayer);
          return;
        }
        setSound(newPlayer);
        newPlayer.addListener('playbackStatusUpdate', (status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingPreviewId(prev => prev === voiceId ? null : prev);
          }
        });
        newPlayer.play();
      } else {
        setPlayingPreviewId(prev => prev === voiceId ? null : prev);
      }
    } catch (error) {
      console.error('Live preview error:', error);
      setPlayingPreviewId(prev => prev === voiceId ? null : prev);
    } finally {
      if (livePreviewIdRef.current === voiceId) {
        setIsGeneratingPreview(false);
      }
    }
  };

  const preloadVoices = async (
    voices: Array<{ voiceId: string; previewUrl?: string; name?: string }>
  ) => {
    const loadPromises = voices
      .filter(v => v.previewUrl && !cachedSounds[v.voiceId])
      .map(async (voice) => {
        try {
          const preloadedPlayer = createAudioPlayer({ uri: voice.previewUrl! });
          return { voiceId: voice.voiceId, player: preloadedPlayer };
        } catch (error) {
          console.error(`Failed to preload audio for ${voice.name || voice.voiceId}:`, error);
          return null;
        }
      });

    const results = await Promise.all(loadPromises);
    const newPlayers: Record<string, AudioPlayer> = {};
    results.forEach(r => { if (r) newPlayers[r.voiceId] = r.player; });
    setCachedSounds(prev => ({ ...prev, ...newPlayers }));
  };

  return {
    playingPreviewId,
    setPlayingPreviewId,
    isGeneratingPreview,
    sound,
    setSound,
    cachedSounds,
    stopAllPreviews,
    playVoicePreview,
    playLivePreview,
    preloadVoices,
  };
}
