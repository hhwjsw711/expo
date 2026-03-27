import { useState, useEffect, useRef } from 'react';
import { Audio } from 'expo-av';
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
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [cachedSounds, setCachedSounds] = useState<Record<string, Audio.Sound>>({});
  const livePreviewIdRef = useRef<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const cachedSoundsRef = useRef<Record<string, Audio.Sound>>({});
  const previewVoiceAction = useAction(api.aiServices.previewVoice);

  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  useEffect(() => {
    cachedSoundsRef.current = cachedSounds;
  }, [cachedSounds]);

  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(console.error);
      Object.values(cachedSoundsRef.current).forEach(s => s.unloadAsync().catch(console.error));
    };
  }, []);

  const stopAllPreviews = async () => {
    livePreviewIdRef.current = null;
    setIsGeneratingPreview(false);
    if (sound) {
      await sound.stopAsync().catch(console.error);
      await sound.unloadAsync().catch(console.error);
      setSound(null);
    }
    for (const s of Object.values(cachedSounds)) {
      await s.unloadAsync().catch(console.error);
    }
    setCachedSounds({});
    setPlayingPreviewId(null);
  };

  const playVoicePreview = async (voiceId: string, previewUrl: string) => {
    livePreviewIdRef.current = null;
    setIsGeneratingPreview(false);
    if (sound) {
      await sound.stopAsync().catch(console.error);
    }

    if (playingPreviewId === voiceId) {
      setPlayingPreviewId(null);
      return;
    }

    setPlayingPreviewId(voiceId);

    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        allowsRecordingIOS: false,
        staysActiveInBackground: false,
      });

      const cachedSound = cachedSounds[voiceId];

      if (cachedSound) {
        await cachedSound.setPositionAsync(0);
        await cachedSound.playAsync();
        setSound(cachedSound);

        cachedSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingPreviewId(null);
          }
        });
      } else {
        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: previewUrl },
          { shouldPlay: true }
        );

        setSound(newSound);
        setCachedSounds(prev => ({ ...prev, [voiceId]: newSound }));

        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingPreviewId(null);
          }
        });
      }
    } catch (error) {
      console.error('Error playing voice preview:', error);
      setPlayingPreviewId(null);
    }
  };

  const playLivePreview = async (voiceId: string) => {
    if (sound) {
      await sound.stopAsync().catch(console.error);
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
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
        });
        if (livePreviewIdRef.current !== voiceId) return;
        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true }
        );
        if (livePreviewIdRef.current !== voiceId) {
          newSound.unloadAsync().catch(console.error);
          return;
        }
        setSound(newSound);
        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingPreviewId(prev => prev === voiceId ? null : prev);
          }
        });
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
          const { sound: preloadedSound } = await Audio.Sound.createAsync(
            { uri: voice.previewUrl! },
            { shouldPlay: false }
          );
          return { voiceId: voice.voiceId, sound: preloadedSound };
        } catch (error) {
          console.error(`Failed to preload audio for ${voice.name || voice.voiceId}:`, error);
          return null;
        }
      });

    const results = await Promise.all(loadPromises);
    const newSounds: Record<string, Audio.Sound> = {};
    results.forEach(r => { if (r) newSounds[r.voiceId] = r.sound; });
    setCachedSounds(prev => ({ ...prev, ...newSounds }));
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
