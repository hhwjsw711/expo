import { useLocalSearchParams, useRouter } from 'expo-router';
import { X, Download, Mic, Music, Subtitles, MessageSquare, Loader2, Play, Pause, Info, Scissors } from 'lucide-react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Alert,
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  Animated,
  Image,
  Dimensions,
  GestureResponderEvent,
  InteractionManager,
  LayoutChangeEvent,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEvent } from 'expo';
import { Audio } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { Fonts } from '@/constants/typography';
import { GenerationPhase } from '@/types';
import { getCachedVideoPath, preCacheVideo } from '@/lib/videoCache';
import VideoPreviewOnboarding, { SpotlightRect } from '@/components/VideoPreviewOnboarding';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';
import { getScreenDimensions } from '@/lib/dimensions';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenDimensions();

// Match client-side watermark position to FFmpeg's `overlay=W-w-160:114` on a 1080×1920 canvas
// by accounting for contentFit="cover" scaling and crop offset.
const VIDEO_W = 1080;
const VIDEO_H = 1920;
const COVER_SCALE = Math.max(SCREEN_WIDTH / VIDEO_W, SCREEN_HEIGHT / VIDEO_H);
const CROP_X = (VIDEO_W * COVER_SCALE - SCREEN_WIDTH) / 2;
const CROP_Y = (VIDEO_H * COVER_SCALE - SCREEN_HEIGHT) / 2;

// Icon shadow style for visibility on light/dark videos
const ICON_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.6,
  shadowRadius: 4,
  elevation: 8,
};

// Helper function to calculate generation phase from project data
const getGenerationPhase = (project: any): GenerationPhase => {
  if (!project) return null;
  
  // If video is completed, no phase
  if (project.status === 'completed' && project.renderedVideoUrl) {
    return null;
  }
  
  // Priority 1: Check render progress step
  const step = project.renderProgress?.step?.toLowerCase() || '';
  if (step) {
    
    // Media preparation steps (voiceover, music, animations, loading) = preparing_media
    if (step.includes('voiceover') || step.includes('music') || step.includes('animat') || step.includes('loading')) {
      return 'preparing_media';
    }
    if (step.includes('claude') || step.includes('editing')) {
      return 'video_agent';
    }
    if (step.includes('finaliz') || step.includes('download') || step.includes('saving')) {
      return 'finalizing';
    }
    // Any other render step (sandbox, upload, environment, render, preparing) = composing
    if (step.includes('render') || step.includes('sandbox') || step.includes('upload') || 
        step.includes('environment') || step.includes('preparing')) {
      return 'composing';
    }
  }
  
  // Priority 2: Check if still preparing media assets (FAL animations, TTS, music)
  const hasMediaAssets = project.audioUrl && project.musicUrl;
  if (project.animationStatus === 'in_progress' || !hasMediaAssets) {
    return 'preparing_media';
  }
  
  // Priority 3: If we have media assets but no render progress yet, still preparing
  // (waiting for render to start)
  if (hasMediaAssets && !project.renderProgress) {
    return 'preparing_media';
  }
  
  // Default during processing
  return 'preparing_media';
};

// Get user-friendly phase text
const getPhaseText = (phase: GenerationPhase, renderProgress?: { step?: string; details?: string }): { title: string; subtitle: string } => {
  switch (phase) {
    case 'preparing_media':
      // Show specific step if available from renderProgress
      const step = renderProgress?.step?.toLowerCase() || '';
      if (step.includes('voiceover')) {
        return { title: 'Preparing Media', subtitle: 'Creating AI voiceover...' };
      }
      if (step.includes('music')) {
        return { title: 'Preparing Media', subtitle: 'Generating background music...' };
      }
      if (step.includes('animat')) {
        return { title: 'Preparing Media', subtitle: 'Animating your images...' };
      }
      if (step.includes('loading')) {
        return { title: 'Preparing Media', subtitle: 'Loading animated clips...' };
      }
      return { title: 'Preparing Media', subtitle: 'Creating voiceover, music, and animations...' };
    case 'video_agent':
      return { title: 'Running Video Agent', subtitle: 'AI is editing your video sequence...' };
    case 'composing':
      // Show specific step if available
      const composeStep = renderProgress?.step?.toLowerCase() || '';
      if (composeStep.includes('starting')) {
        return { title: 'Composing', subtitle: 'Initializing video composition...' };
      }
      if (composeStep.includes('sandbox')) {
        return { title: 'Composing', subtitle: 'Setting up render environment...' };
      }
      if (composeStep.includes('upload')) {
        return { title: 'Composing', subtitle: 'Uploading media files...' };
      }
      return { title: 'Composing', subtitle: 'Rendering your video...' };
    case 'finalizing':
      return { title: 'Finalizing', subtitle: 'Almost done! Preparing your video...' };
    default:
      return { title: 'Generating', subtitle: 'Creating your video...' };
  }
};

// Icon button wrapper with shadow for visibility on any video background
const IconButton = ({ 
  onPress, 
  children, 
  style,
  disabled,
  testID,
}: { 
  onPress: () => void; 
  children: React.ReactNode;
  style?: any;
  disabled?: boolean;
  testID?: string;
}) => (
  <TouchableOpacity
    testID={testID}
    style={[styles.iconButton, ICON_SHADOW, style]}
    onPress={onPress}
    activeOpacity={0.7}
    disabled={disabled}
  >
    {children}
  </TouchableOpacity>
);

// Sidebar icon button for right side controls (no background, just shadow like top icons)
const SidebarButton = ({ 
  onPress, 
  children, 
  disabled,
}: { 
  onPress: () => void; 
  children: React.ReactNode;
  disabled?: boolean;
}) => (
  <TouchableOpacity
    style={[styles.sidebarButton, ICON_SHADOW]}
    onPress={onPress}
    activeOpacity={0.7}
    disabled={disabled}
  >
    {children}
  </TouchableOpacity>
);

export default function VideoPreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ 
    videoId: string;
    videoUri: string;
    prompt: string;
    script?: string;
    projectId?: string;
    thumbnailUrl?: string;
    testMode?: string;
    isGenerating?: string;
  }>();
  
  const { updateVideoStatus, userId } = useApp();
  
  // Parse params
  const videoId = params.videoId;
  const initialVideoUri = params.videoUri;
  const prompt = params.prompt || '';
  const script = params.script || '';
  const projectId = params.projectId as any;
  const thumbnailUrl = params.thumbnailUrl;
  const isTestMode = params.testMode === 'true';
  const isGeneratingParam = params.isGenerating === 'true';
  
  // Track current video URI (can be updated when generation completes)
  const [videoUri, setVideoUri] = useState(initialVideoUri);
  
  // Track the resolved video URI (cached local path or remote URL)
  const [resolvedVideoUri, setResolvedVideoUri] = useState<string | null>(null);
  
  // Spinner animation
  const spinAnim = useRef(new Animated.Value(0)).current;
  
  // Toast animation
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const composingToastOpacity = useRef(new Animated.Value(0)).current;
  
  // Query project status when generating
  const project = useQuery(
    api.tasks.getProject,
    projectId ? { id: projectId } : "skip"
  );
  
  // Calculate if we're still generating based on live project data
  const isGenerating = isGeneratingParam && (!project?.renderedVideoUrl || project?.status !== 'completed');
  const generationPhase = isGenerating ? getGenerationPhase(project) : null;
  const phaseText = getPhaseText(generationPhase, project?.renderProgress);
  
  // Use live project thumbnail if available, fallback to params
  const effectiveThumbnailUrl = project?.thumbnailUrl || thumbnailUrl;
  
  // Update video URI when generation completes or when opened with only projectId (e.g. from notification tap)
  useEffect(() => {
    if (project?.status === 'completed' && project?.renderedVideoUrl) {
      // Set videoUri from project data when:
      // 1. Generation just completed (isGeneratingParam), OR
      // 2. Navigated with only projectId and no initial videoUri (e.g. notification tap)
      if (isGeneratingParam || !initialVideoUri) {
        console.log('[video-preview] Setting video URI from project data');
        setVideoUri(project.renderedVideoUrl);
        if (videoId) {
          updateVideoStatus(videoId, 'ready', project.renderedVideoUrl, undefined, project.thumbnailUrl);
        }
      }
    }
  }, [project?.status, project?.renderedVideoUrl, isGeneratingParam, initialVideoUri, videoId, updateVideoStatus, project?.thumbnailUrl]);
  
  // Animate spinner when generating
  useEffect(() => {
    if (isGenerating) {
      spinAnim.setValue(0);
      const animation = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
          isInteraction: false,
        })
      );
      animation.start();
      return () => animation.stop();
    }
  }, [isGenerating, spinAnim]);
  
  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Check for cached video and start pre-caching when video URI changes
  useEffect(() => {
    if (!videoUri || isGenerating) {
      setResolvedVideoUri(null);
      return;
    }

    // Skip if already a local file
    if (videoUri.startsWith('file://')) {
      setResolvedVideoUri(videoUri);
      return;
    }

    let isMounted = true;

    const resolveVideoUri = async () => {
      // Check if we have a cached version
      const cachedPath = await getCachedVideoPath(videoUri, projectId);
      
      if (!isMounted) return;

      if (cachedPath) {
        console.log('[video-preview] Using cached video:', cachedPath);
        setResolvedVideoUri(cachedPath);
      } else {
        // Use remote URL and start caching in background
        console.log('[video-preview] No cache, using remote URL and starting pre-cache');
        setResolvedVideoUri(videoUri);
        preCacheVideo(videoUri, projectId);
      }
    };

    resolveVideoUri();

    return () => {
      isMounted = false;
    };
  }, [videoUri, projectId, isGenerating]);

  // Local state
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  
  // Video playback state
  const [isPlaying, setIsPlaying] = useState(true);
  const [showControls, setShowControls] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Timeline scrubbing state
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubProgress, setScrubProgress] = useState(0);
  const timelineWidthRef = useRef(0);
  const timelineLeftRef = useRef(0);
  const wasPlayingBeforeScrub = useRef(false);
  
  // Video option toggles
  const [voiceoverEnabled, setVoiceoverEnabled] = useState(true);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);

  // Client-side preview: resolved URLs for base video, voice audio, music audio
  const [previewAssets, setPreviewAssets] = useState<{
    baseVideoUrl: string | null;
    voiceAudioUrl: string | null;
    musicAudioUrl: string | null;
    watermarkUrl: string | null;
    voiceSpeed: number;
    includeVoice?: boolean;
    includeMusic?: boolean;
    includeCaptions?: boolean;
    includeOriginalSound?: boolean;
    musicVolume?: number;
    voiceVolume?: number;
    originalSoundVolume?: number;
  } | null>(null);

  // Track which features are available in the rendered video
  const [voiceAvailable, setVoiceAvailable] = useState(true);
  const [musicAvailable, setMusicAvailable] = useState(true);
  const [captionsAvailable, setCaptionsAvailable] = useState(true);
  const voiceSoundRef = useRef<Audio.Sound | null>(null);
  const musicSoundRef = useRef<Audio.Sound | null>(null);
  const audioLoadedRef = useRef({ voice: false, music: false });
  const [audioReady, setAudioReady] = useState(false);
  // One-time source switch: rendered video → base video (during initial load)
  const pendingSeekAfterSourceSwitch = useRef<{ time: number; wasPlaying: boolean } | null>(null);
  const [isSourceSwitching, setIsSourceSwitching] = useState(false);
  const isSourceSwitchingRef = useRef(false);
  const switchedToBaseRef = useRef(false);

  // Default variant = current toggles match what was baked into the rendered video
  const renderIncludesVoice = previewAssets?.includeVoice !== false;
  const renderIncludesMusic = previewAssets?.includeMusic !== false;
  const renderIncludesCaptions = previewAssets?.includeCaptions !== false;
  const isDefaultVariant =
    voiceoverEnabled === renderIncludesVoice &&
    musicEnabled === renderIncludesMusic &&
    captionsEnabled === renderIncludesCaptions;
  const useSeparateAudio = switchedToBaseRef.current || !isDefaultVariant;

  // Convex hooks
  const getFreshVideoUrl = useAction(api.tasks.getFreshProjectVideoUrl);
  const getVideoVariant = useAction(api.tasks.getVideoVariant);
  const getPreviewAssets = useAction(api.tasks.getProjectPreviewAssets);
  const completeVideoPreviewTips = useMutation(api.users.completeVideoPreviewTips);

  // Fetch preview assets (base video, voice audio, music audio URLs) for client-side preview
  useEffect(() => {
    if (!projectId || isGenerating) return;
    let cancelled = false;
    getPreviewAssets({ projectId }).then((assets) => {
      if (!cancelled) {
        console.log('[video-preview] Preview assets loaded:', {
          hasBaseVideo: !!assets.baseVideoUrl,
          hasVoice: !!assets.voiceAudioUrl,
          hasMusic: !!assets.musicAudioUrl,
          hasWatermark: !!assets.watermarkUrl,
          voiceSpeed: assets.voiceSpeed,
          includeVoice: assets.includeVoice,
          includeMusic: assets.includeMusic,
          includeCaptions: assets.includeCaptions,
        });
        setPreviewAssets(assets);

        // Disable toggles and mark features as unavailable if they were
        // excluded during rendering (the rendered video simply doesn't have them)
        if (assets.includeVoice === false) {
          setVoiceAvailable(false);
          setVoiceoverEnabled(false);
        }
        if (assets.includeMusic === false) {
          setMusicAvailable(false);
          setMusicEnabled(false);
        }
        if (assets.includeCaptions === false) {
          setCaptionsAvailable(false);
          setCaptionsEnabled(false);
        }
      }
    }).catch((err) => {
      console.warn('[video-preview] Failed to load preview assets:', err);
    });
    return () => { cancelled = true; };
  }, [projectId, isGenerating]);

  // Load separate audio tracks for client-side preview mixing
  useEffect(() => {
    if (!previewAssets) return;
    let cancelled = false;

    const loadAudio = async () => {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      if (previewAssets.voiceAudioUrl && !audioLoadedRef.current.voice) {
        try {
          const { sound } = await Audio.Sound.createAsync(
            { uri: previewAssets.voiceAudioUrl },
            { shouldPlay: false, volume: previewAssets.voiceVolume ?? 1.0, rate: previewAssets.voiceSpeed, shouldCorrectPitch: true }
          );
          if (!cancelled) {
            voiceSoundRef.current = sound;
            audioLoadedRef.current.voice = true;
            console.log('[video-preview] Voice audio loaded');
          } else {
            sound.unloadAsync();
          }
        } catch (e) {
          console.warn('[video-preview] Failed to load voice audio:', e);
        }
      }

      if (previewAssets.musicAudioUrl && !audioLoadedRef.current.music) {
        try {
          const { sound } = await Audio.Sound.createAsync(
            { uri: previewAssets.musicAudioUrl },
            { shouldPlay: false, volume: previewAssets.musicVolume ?? 0.1 }
          );
          if (!cancelled) {
            musicSoundRef.current = sound;
            audioLoadedRef.current.music = true;
            console.log('[video-preview] Music audio loaded');
          } else {
            sound.unloadAsync();
          }
        } catch (e) {
          console.warn('[video-preview] Failed to load music audio:', e);
        }
      }
    };

    loadAudio().then(() => {
      if (!cancelled) setAudioReady(true);
    });

    return () => {
      cancelled = true;
      setAudioReady(false);
      voiceSoundRef.current?.unloadAsync();
      musicSoundRef.current?.unloadAsync();
      voiceSoundRef.current = null;
      musicSoundRef.current = null;
      audioLoadedRef.current = { voice: false, music: false };
    };
  }, [previewAssets]);

  // Fetch backend user for onboarding tips check
  const backendUser = useQuery(
    api.users.getCurrentUser,
    userId ? { userId } : "skip"
  );
  
  // Video preview onboarding tips state
  const [showVideoPreviewOnboarding, setShowVideoPreviewOnboarding] = useState(false);
  const [onboardingSpotlightRects, setOnboardingSpotlightRects] = useState<(SpotlightRect | null)[]>([null, null]);
  const onboardingTriggeredRef = useRef(false);
  const [videoTipsCompletedLocally, setVideoTipsCompletedLocally] = useState(false);
  const downloadButtonRef = useRef<View>(null);
  const togglesGroupRef = useRef<View>(null);
  
  // Load local video tips completion flag on mount
  useEffect(() => {
    AsyncStorage.getItem('@reelfull_videoPreviewTipsCompleted').then((value) => {
      if (value === 'true') setVideoTipsCompletedLocally(true);
    });
  }, []);

  // Video player - uses resolved (cached) URI when available
  // Note: playback is NOT started here; it's gated by the onboarding check effect below
  const videoPlayer = useVideoPlayer(
    resolvedVideoUri || null,
    (player) => {
      if (player && resolvedVideoUri) {
        player.loop = true;
        player.muted = false;
      }
    }
  );
  
  // Subscribe to player status changes
  const { isPlaying: playerIsPlaying } = useEvent(videoPlayer, 'playingChange', { isPlaying: videoPlayer.playing });
  const { status: playerStatus } = useEvent(videoPlayer, 'statusChange', { status: videoPlayer.status });
  
  // Track if video is ready to play (loaded enough to display)
  const isVideoReady = playerStatus === 'readyToPlay';

  // Second player: rendered video with baked captions (shown via opacity when captions enabled)
  const captionPlayer = useVideoPlayer(
    resolvedVideoUri || null,
    (player) => {
      if (player && resolvedVideoUri) {
        player.loop = true;
        player.muted = true;
      }
    }
  );
  const { status: captionPlayerStatus } = useEvent(captionPlayer, 'statusChange', { status: captionPlayer.status });
  const isCaptionPlayerReady = captionPlayerStatus === 'readyToPlay';

  // Keep caption player in sync with primary player (skip when captions disabled)
  useEffect(() => {
    if (!isCaptionPlayerReady || !videoPlayer || !captionPlayer || !captionsEnabled) return;

    const syncCaption = () => {
      if (!videoPlayer.playing) return;
      const drift = Math.abs(videoPlayer.currentTime - captionPlayer.currentTime);
      if (drift > 0.3) {
        captionPlayer.currentTime = videoPlayer.currentTime;
      }
    };

    const interval = setInterval(syncCaption, 1000);
    return () => clearInterval(interval);
  }, [isCaptionPlayerReady, videoPlayer, captionPlayer, captionsEnabled]);

  // Mirror play/pause state to caption player (pause when captions disabled to save GPU)
  useEffect(() => {
    if (!captionPlayer || !isCaptionPlayerReady) return;
    if (captionsEnabled && playerIsPlaying) {
      captionPlayer.currentTime = videoPlayer.currentTime;
      captionPlayer.play();
    } else {
      captionPlayer.pause();
    }
  }, [playerIsPlaying, captionPlayer, isCaptionPlayerReady, videoPlayer, captionsEnabled]);

  // Sync separate audio tracks with the video player
  const syncAudioPlayState = useCallback(async (playing: boolean) => {
    const currentTimeMs = (videoPlayer?.currentTime || 0) * 1000;

    if (voiceoverEnabled && voiceSoundRef.current) {
      try {
        await voiceSoundRef.current.setPositionAsync(currentTimeMs);
        if (playing) await voiceSoundRef.current.playAsync();
        else await voiceSoundRef.current.pauseAsync();
      } catch (_) {}
    } else {
      try { await voiceSoundRef.current?.pauseAsync(); } catch (_) {}
    }

    if (musicEnabled && musicSoundRef.current) {
      try {
        await musicSoundRef.current.setVolumeAsync(previewAssets?.musicVolume ?? 0.1);
        await musicSoundRef.current.setPositionAsync(currentTimeMs);
        if (playing) await musicSoundRef.current.playAsync();
        else await musicSoundRef.current.pauseAsync();
      } catch (_) {}
    } else {
      try { await musicSoundRef.current?.pauseAsync(); } catch (_) {}
    }
  }, [voiceoverEnabled, musicEnabled, videoPlayer, previewAssets?.musicVolume]);

  // One-time switch: swap rendered video → base video while thumbnail is still visible.
  // Waits for audioReady so everything starts together after the switch.
  useEffect(() => {
    if (!previewAssets?.baseVideoUrl || !audioReady || !videoPlayer || switchedToBaseRef.current || isGenerating) return;
    switchedToBaseRef.current = true;
    const currentTime = videoPlayer.currentTime;
    const wasPlaying = videoPlayer.playing;
    videoPlayer.pause();
    const origVol = previewAssets.originalSoundVolume ?? 0;
    videoPlayer.muted = !previewAssets.includeOriginalSound || origVol === 0;
    try { videoPlayer.volume = origVol; } catch (_) {}
    pendingSeekAfterSourceSwitch.current = { time: currentTime, wasPlaying };
    isSourceSwitchingRef.current = true;
    setIsSourceSwitching(true);
    videoPlayer.replaceAsync({ uri: previewAssets.baseVideoUrl });
  }, [previewAssets?.baseVideoUrl, audioReady, videoPlayer, isGenerating]);

  // After the one-time source switch completes, restore position (auto-play effect handles starting)
  useEffect(() => {
    if (isVideoReady && pendingSeekAfterSourceSwitch.current && videoPlayer) {
      const { time } = pendingSeekAfterSourceSwitch.current;
      pendingSeekAfterSourceSwitch.current = null;
      videoPlayer.currentTime = time;
      isSourceSwitchingRef.current = false;
      setIsSourceSwitching(false);
    }
  }, [isVideoReady, videoPlayer]);

  // When any toggle changes, manage audio (no source switching)
  useEffect(() => {
    if (!videoPlayer || isGenerating) return;

    if (switchedToBaseRef.current) {
      const origVol = previewAssets?.originalSoundVolume ?? 0;
      videoPlayer.muted = !previewAssets?.includeOriginalSound || origVol === 0;
      try { videoPlayer.volume = origVol; } catch (_) {}
      syncAudioPlayState(videoPlayer.playing);
    } else if (isDefaultVariant) {
      // Still on rendered video, all defaults — use baked audio
      videoPlayer.muted = false;
      voiceSoundRef.current?.pauseAsync().catch(() => {});
      musicSoundRef.current?.pauseAsync().catch(() => {});
    } else {
      // Still on rendered video but user toggled before base loaded — mute & use separate audio
      // Must stay muted because the rendered video's audio is a pre-mixed composite (voice + music + original sound)
      // that cannot be decomposed; unmuting would cause double audio with the separate tracks
      videoPlayer.muted = true;
      syncAudioPlayState(videoPlayer.playing);
    }
  }, [voiceoverEnabled, musicEnabled, captionsEnabled, isGenerating, syncAudioPlayState, audioReady, previewAssets?.includeOriginalSound]);

  // Periodic audio sync: keep separate tracks in time with the video
  useEffect(() => {
    if (!useSeparateAudio || isGenerating || !videoPlayer) return;

    const interval = setInterval(async () => {
      if (!videoPlayer.playing) return;
      const videoMs = videoPlayer.currentTime * 1000;

      const drift = async (sound: Audio.Sound | null) => {
        if (!sound) return;
        try {
          const s = await sound.getStatusAsync();
          if (s.isLoaded && s.isPlaying && Math.abs(s.positionMillis - videoMs) > 400) {
            await sound.setPositionAsync(videoMs);
          }
        } catch (_) {}
      };

      if (voiceoverEnabled) await drift(voiceSoundRef.current);
      if (musicEnabled) await drift(musicSoundRef.current);
    }, 2000);

    return () => clearInterval(interval);
  }, [useSeparateAudio, isGenerating, voiceoverEnabled, musicEnabled, videoPlayer]);

  // Update local isPlaying state when player state changes
  useEffect(() => {
    setIsPlaying(playerIsPlaying);
  }, [playerIsPlaying]);
  
  // Track video progress, detect loop restarts, and update caption overlay
  const prevVideoTimeRef = useRef(0);
  const showControlsRef = useRef(false);
  showControlsRef.current = showControls;
  const isScrubbingRef = useRef(false);
  isScrubbingRef.current = isScrubbing;
  const durationSetRef = useRef(false);

  useEffect(() => {
    if (!videoPlayer || isGenerating) return;
    durationSetRef.current = false;
    
    const interval = setInterval(() => {
      if (videoPlayer.duration > 0) {
        if (!durationSetRef.current) {
          durationSetRef.current = true;
          setDuration(videoPlayer.duration);
        }
        const currentTime = videoPlayer.currentTime;

        // Detect loop restart: video jumped backwards by a large amount
        if (useSeparateAudio && videoPlayer.playing && prevVideoTimeRef.current - currentTime > 1) {
          syncAudioPlayState(true);
        }
        prevVideoTimeRef.current = currentTime;

        // Only update progress state when timeline is visible to avoid unnecessary re-renders
        if (showControlsRef.current && !isScrubbingRef.current) {
          setProgress(currentTime / videoPlayer.duration);
        }
      }
    }, 250);
    
    return () => clearInterval(interval);
  }, [videoPlayer, isGenerating, useSeparateAudio, syncAudioPlayState]);

  // Immediately update progress when controls become visible so the timeline is accurate
  useEffect(() => {
    if (showControls && videoPlayer && videoPlayer.duration > 0 && !isScrubbing) {
      setProgress(videoPlayer.currentTime / videoPlayer.duration);
    }
  }, [showControls, videoPlayer, isScrubbing]);
  
  // Auto-hide controls after 3 seconds
  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  }, []);
  
  // Handle tap on video: toggle play/pause and sync separate audio tracks
  const handleVideoTap = useCallback(() => {
    if (isGenerating) return;
    
    if (videoPlayer) {
      if (isPlaying) {
        videoPlayer.pause();
        if (useSeparateAudio) syncAudioPlayState(false);
      } else {
        videoPlayer.play();
        if (useSeparateAudio) syncAudioPlayState(true);
      }
    }
    
    // Show controls and reset timeout
    setShowControls(true);
    resetControlsTimeout();
  }, [videoPlayer, isPlaying, isGenerating, resetControlsTimeout, useSeparateAudio, syncAudioPlayState]);
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, []);
  
  // Timeline layout handler
  const handleTimelineLayout = useCallback((event: LayoutChangeEvent) => {
    timelineWidthRef.current = event.nativeEvent.layout.width;
    // Store the x position using pageX from measure
    event.target.measure?.((x, y, width, height, pageX, pageY) => {
      timelineLeftRef.current = pageX;
    });
  }, []);
  
  // Calculate progress from touch position
  const getProgressFromPageX = useCallback((pageX: number) => {
    const touchX = pageX - timelineLeftRef.current;
    const width = timelineWidthRef.current;
    if (width <= 0) return progress;
    return Math.max(0, Math.min(1, touchX / width));
  }, [progress]);
  
  // Timeline touch handlers
  const handleTimelineTouchStart = useCallback((event: GestureResponderEvent) => {
    if (!videoPlayer || !duration) return;
    
    // Update layout position on touch start for accuracy
    const { pageX, locationX } = event.nativeEvent;
    timelineLeftRef.current = pageX - locationX;
    
    // Pause video while scrubbing
    wasPlayingBeforeScrub.current = isPlaying;
    if (isPlaying) {
      videoPlayer.pause();
      if (useSeparateAudio) syncAudioPlayState(false);
    }
    
    setIsScrubbing(true);
    setShowControls(true);
    
    // Clear any hide timeout while scrubbing
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    
    // Calculate and apply initial scrub position
    const newProgress = getProgressFromPageX(pageX);
    setScrubProgress(newProgress);
  }, [videoPlayer, duration, isPlaying, getProgressFromPageX, useSeparateAudio, syncAudioPlayState]);
  
  const handleTimelineTouchMove = useCallback((event: GestureResponderEvent) => {
    if (!isScrubbing || !videoPlayer || !duration) return;
    
    const { pageX } = event.nativeEvent;
    const newProgress = getProgressFromPageX(pageX);
    setScrubProgress(newProgress);
  }, [isScrubbing, videoPlayer, duration, getProgressFromPageX]);
  
  const handleTimelineTouchEnd = useCallback(() => {
    if (!isScrubbing || !videoPlayer || !duration) return;
    
    // Seek to the final scrub position
    const seekTime = scrubProgress * duration;
    videoPlayer.currentTime = seekTime;
    if (captionPlayer) captionPlayer.currentTime = seekTime;
    setProgress(scrubProgress);
    
    setIsScrubbing(false);
    
    // Resume playing if it was playing before
    if (wasPlayingBeforeScrub.current) {
      videoPlayer.play();
      if (useSeparateAudio) syncAudioPlayState(true);
    }
    
    // Reset controls hide timeout
    resetControlsTimeout();
  }, [isScrubbing, videoPlayer, duration, scrubProgress, resetControlsTimeout, useSeparateAudio, syncAudioPlayState]);

  // Animate composing toast - stays visible during entire composing process
  useEffect(() => {
    if (isComposing) {
      Animated.timing(composingToastOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(composingToastOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [isComposing, composingToastOpacity]);

  // Animate toast when download succeeds
  useEffect(() => {
    if (downloadSuccess) {
      // Fade in
      Animated.sequence([
        Animated.timing(toastOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.delay(2500),
        Animated.timing(toastOpacity, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setDownloadSuccess(false);
      });
    }
  }, [downloadSuccess, toastOpacity]);

  // Measure onboarding spotlight rects for the sidebar buttons
  const measureOnboardingRects = useCallback(() => {
    const refs = [togglesGroupRef, downloadButtonRef];
    const measured: (SpotlightRect | null)[] = [null, null];
    let remaining = refs.length;
    
    refs.forEach((ref, index) => {
      if (ref.current) {
        ref.current.measureInWindow((x: number, y: number, width: number, height: number) => {
          measured[index] = { x, y, width, height };
          remaining--;
          if (remaining === 0) {
            setOnboardingSpotlightRects([...measured]);
          }
        });
      } else {
        measured[index] = null;
        remaining--;
        if (remaining === 0) {
          setOnboardingSpotlightRects([...measured]);
        }
      }
    });
  }, []);

  // Trigger video preview onboarding overlay (caller already decided tips should show)
  const triggerVideoPreviewOnboarding = useCallback(() => {
    // Ensure video is paused (should already be, but safety net)
    if (videoPlayer) {
      videoPlayer.pause();
    }
    InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => {
        measureOnboardingRects();
        setShowVideoPreviewOnboarding(true);
      });
    });
  }, [measureOnboardingRects, videoPlayer]);

  // Auto-trigger onboarding (or auto-play) once when video, audio, and base-video switch are all ready.
  // Keeps thumbnail visible until everything is loaded so playback starts with sound.
  useEffect(() => {
    if (!isVideoReady || isGenerating || onboardingTriggeredRef.current) return;

    // Wait for audio tracks to finish loading
    if (!audioReady && projectId) return;

    // Wait for the base-video switch to finish (isSourceSwitching goes true → false)
    // Check both the ref (for synchronous updates within same effect batch) and state (for re-renders)
    if (isSourceSwitching || isSourceSwitchingRef.current) return;

    // Wait for backendUser query to finish loading (undefined = still loading)
    const backendUserLoaded = backendUser !== undefined || !userId;
    if (!backendUserLoaded) return;

    onboardingTriggeredRef.current = true;

    const shouldShowTips = ENABLE_TEST_RUN_MODE || (!backendUser?.videoPreviewTipsCompleted && !videoTipsCompletedLocally);

    if (shouldShowTips) {
      const timer = setTimeout(() => {
        triggerVideoPreviewOnboarding();
      }, 500);
      return () => clearTimeout(timer);
    } else {
      if (videoPlayer) {
        videoPlayer.play();
        syncAudioPlayState(true);
      }
    }
  }, [isVideoReady, isGenerating, isSourceSwitching, backendUser, userId, videoTipsCompletedLocally, triggerVideoPreviewOnboarding, videoPlayer, audioReady, projectId, syncAudioPlayState]);

  // Handle onboarding completion
  const handleVideoPreviewOnboardingComplete = useCallback(async () => {
    setShowVideoPreviewOnboarding(false);
    if (videoPlayer) {
      videoPlayer.play();
    }
    // Read ref directly to avoid stale closure (switchedToBaseRef may have changed
    // after this callback was memoized)
    if (switchedToBaseRef.current || !isDefaultVariant) {
      syncAudioPlayState(true);
    }
    if (!ENABLE_TEST_RUN_MODE) {
      // Save locally first (guaranteed to persist)
      setVideoTipsCompletedLocally(true);
      AsyncStorage.setItem('@reelfull_videoPreviewTipsCompleted', 'true').catch(() => {});
      // Also save to backend (best-effort)
      if (userId) {
        try {
          await completeVideoPreviewTips({ userId });
        } catch (e) {
          console.error('Failed to save video preview tips completion:', e);
        }
      }
    }
  }, [userId, completeVideoPreviewTips, videoPlayer, isDefaultVariant, syncAudioPlayState]);

  const handleClose = () => {
    voiceSoundRef.current?.stopAsync().catch(() => {});
    musicSoundRef.current?.stopAsync().catch(() => {});
    if (isTestMode) {
      router.replace('/(tabs)');
    } else {
      router.back();
    }
  };

  const handleDownload = async () => {
    if (!videoUri || isDownloading) return;

    try {
      setIsDownloading(true);
      setDownloadSuccess(false);
      setDownloadProgress(0);
      
      let downloadUrl = videoUri;
      let isLocalFile = false;
      
      if (projectId) {
        if (!isDefaultVariant) {
          // User wants a custom variant - call getVideoVariant to compose it
          console.log('[download] Getting custom variant:', { voice: voiceoverEnabled, music: musicEnabled, captions: captionsEnabled });
          setIsComposing(true);
          try {
            const variantResult = await getVideoVariant({
              projectId: projectId,
              includeVoice: voiceoverEnabled,
              includeMusic: musicEnabled,
              includeCaptions: captionsEnabled,
            });
            
            if (variantResult.success && variantResult.url) {
              downloadUrl = variantResult.url;
              console.log('[download] Got variant URL:', variantResult.cached ? '(cached)' : '(newly composed)');
            } else {
              throw new Error('Failed to get video variant');
            }
          } catch (error) {
            console.error('[download] Failed to get variant:', error);
            Alert.alert(
              'Variant Not Available', 
              'Custom video options require the video to be re-processed. This feature may not be available for older videos. Downloading the default version instead.'
            );
            // Fall back to default URL
            const freshUrl = await getFreshVideoUrl({ projectId });
            if (freshUrl) {
              downloadUrl = freshUrl;
            }
          } finally {
            setIsComposing(false);
          }
        } else {
          // Default variant - try to use cached/existing URL to avoid round-trips
          
          // 1. Re-check cache first - pre-cache may have completed while user was watching
          const cachedPath = projectId ? await getCachedVideoPath(videoUri, projectId) : null;
          
          if (cachedPath) {
            console.log('[download] Pre-cache completed! Using cached local file');
            downloadUrl = cachedPath;
            isLocalFile = true;
          } else if (resolvedVideoUri && resolvedVideoUri.startsWith('file://')) {
            // 2. resolvedVideoUri is already a local file
            console.log('[download] Using cached local file for download');
            downloadUrl = resolvedVideoUri;
            isLocalFile = true;
          } else if (resolvedVideoUri) {
            // 3. We have a working remote URL (video is playing from it) - use it directly
            //    Skip the Convex action round-trip since this URL is already working
            console.log('[download] Using existing remote URL (skipping fresh URL fetch)');
            downloadUrl = resolvedVideoUri;
          } else {
            // 4. Last resort - fetch fresh URL from backend
            try {
              const freshUrl = await getFreshVideoUrl({ projectId });
              if (freshUrl) {
                downloadUrl = freshUrl;
                console.log('[download] Using fresh URL for download');
              }
            } catch (error) {
              console.error('[download] Failed to fetch fresh URL, using existing:', error);
            }
          }
        }
      }

      // Request permissions
      const { status, accessPrivileges } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Permission Required',
          'Please grant permission to save videos to your library.'
        );
        return;
      }

      if (Platform.OS === 'web') {
        // Web: trigger browser download
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = `reelfull_${Date.now()}.mp4`;
        link.click();
        setDownloadSuccess(true);
      } else {
        // Mobile: save to media library
        let fileUriToSave: string;
        
        if (isLocalFile && downloadUrl.startsWith('file://')) {
          // Use cached file directly - no download needed!
          console.log('[Download] Using cached file directly:', downloadUrl);
          fileUriToSave = downloadUrl;
        } else {
          // Download to local file first with progress tracking
          const fileUri = `${FileSystem.documentDirectory}reelfull_${Date.now()}.mp4`;
          
          console.log('[Download] Downloading video from:', downloadUrl);
          console.log('[Download] To local path:', fileUri);
          console.log('[Download] Access privileges:', accessPrivileges);
          
          setDownloadProgress(0);
          const downloadResumable = FileSystem.createDownloadResumable(
            downloadUrl,
            fileUri,
            {},
            (progress) => {
              if (progress.totalBytesExpectedToWrite > 0) {
                const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
                setDownloadProgress(pct);
              }
            }
          );
          
          const downloadResult = await downloadResumable.downloadAsync();
          
          if (!downloadResult || downloadResult.status !== 200) {
            throw new Error(`Download failed with status: ${downloadResult?.status}`);
          }
          
          fileUriToSave = downloadResult.uri;
        }
        
        console.log('[Download] Saving to media library...');
        const asset = await MediaLibrary.createAssetAsync(fileUriToSave);
        
        // Try to create album, but don't fail if it doesn't work (e.g., limited access)
        try {
          await MediaLibrary.createAlbumAsync('Reelful', asset, false);
        } catch (albumError) {
          // Album creation can fail with limited access, but the asset is still saved
          console.log('[Download] Album creation skipped (limited access):', albumError);
        }
        
        setDownloadSuccess(true);
      }
    } catch (error) {
      console.error('Error downloading video:', error);
      Alert.alert('Error', 'Failed to download video. Please try again.');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleShowOnboarding = useCallback(() => {
    if (videoPlayer) {
      videoPlayer.pause();
    }
    if (useSeparateAudio) syncAudioPlayState(false);
    measureOnboardingRects();
    setShowVideoPreviewOnboarding(true);
  }, [videoPlayer, measureOnboardingRects, useSeparateAudio, syncAudioPlayState]);

  const handleChatHistory = () => {
    if (projectId) {
      if (videoPlayer) {
        videoPlayer.pause();
      }
      if (captionPlayer) {
        captionPlayer.pause();
      }
      voiceSoundRef.current?.pauseAsync().catch(() => {});
      musicSoundRef.current?.pauseAsync().catch(() => {});
      router.push({
        pathname: '/chat-composer',
        params: { projectId, fromVideo: 'true' },
      });
    }
  };

  const handleOpenEditor = () => {
    if (projectId) {
      if (videoPlayer) {
        videoPlayer.pause();
      }
      if (captionPlayer) {
        captionPlayer.pause();
      }
      voiceSoundRef.current?.pauseAsync().catch(() => {});
      musicSoundRef.current?.pauseAsync().catch(() => {});
      router.push({
        pathname: '/video-editor' as any,
        params: { projectId },
      });
    }
  };

  // Determine if we're in a loading/transition state where video is becoming ready
  // This happens when project query is still loading or video URI is being resolved
  const isLoadingVideo = !videoUri && projectId && project === undefined;
  const isVideoTransitioning = !videoUri && !isGenerating && project?.renderedVideoUrl;
  const showLoadingState = isLoadingVideo || isVideoTransitioning;
  
  // Show loading state with thumbnail while video is loading/transitioning
  if (showLoadingState) {
    return (
      <View style={styles.container}>
        {/* Show thumbnail while loading */}
        <View style={styles.fullscreenVideo}>
          {effectiveThumbnailUrl ? (
            <Image
              source={{ uri: effectiveThumbnailUrl }}
              style={styles.generatingThumbnail}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.generatingPlaceholder} />
          )}
        </View>
        
        {/* Top controls */}
        <View style={[styles.topControls, { paddingTop: insets.top + 16 }]}>
          <IconButton onPress={handleClose}>
            <X size={28} color={Colors.white} strokeWidth={2.5} />
          </IconButton>
          <View style={styles.topControlsRight} />
        </View>
      </View>
    );
  }

  // If no video URI and not generating, show loading state (thumbnail + close)
  // instead of an error — the Convex query may still resolve the video URL
  if (!videoUri && !isGenerating) {
    return (
      <View style={styles.container}>
        <View style={styles.fullscreenVideo}>
          {effectiveThumbnailUrl ? (
            <Image
              source={{ uri: effectiveThumbnailUrl }}
              style={styles.generatingThumbnail}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.generatingPlaceholder} />
          )}
        </View>
        
        {/* Top controls */}
        <View style={[styles.topControls, { paddingTop: insets.top + 16 }]}>
          <IconButton onPress={handleClose}>
            <X size={28} color={Colors.white} strokeWidth={2.5} />
          </IconButton>
          <View style={styles.topControlsRight} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Full-screen video or generating state */}
      {isGenerating ? (
        // Generating state - show thumbnail with spinner overlay
        <View style={styles.fullscreenVideo}>
          {effectiveThumbnailUrl ? (
            <Image
              source={{ uri: effectiveThumbnailUrl }}
              style={styles.generatingThumbnail}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.generatingPlaceholder} />
          )}
          <View style={styles.generatingOverlay}>
            <Animated.View style={{ transform: [{ rotate: spin }] }}>
              <Loader2 size={48} color={Colors.ember} strokeWidth={2} />
            </Animated.View>
            <Text style={styles.generatingPhaseText}>{phaseText.title}</Text>
            <Text style={styles.generatingSubtitleText}>{phaseText.subtitle}</Text>
            <Text style={styles.generatingHintText}>Video takes a couple of minutes to generate.{'\n'}You can leave the app.</Text>
          </View>
        </View>
      ) : (
        // Ready state - show full-screen video player with tap-to-pause
        <TouchableWithoutFeedback onPress={handleVideoTap}>
          <View style={styles.fullscreenVideo}>
            {/* Base layer: primary video (base video after switch, rendered before) */}
            <VideoView
              player={videoPlayer}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              nativeControls={false}
            />

            {/* Caption layer: rendered video with baked captions, toggled via opacity */}
            {switchedToBaseRef.current && (
              <VideoView
                player={captionPlayer}
                style={[StyleSheet.absoluteFill, { opacity: captionsEnabled ? 1 : 0 }]}
                contentFit="cover"
                nativeControls={false}
              />
            )}

            {/* Watermark overlay: visible when on base video and captions are off
                (when captions are on, the caption player layer already includes the watermark) */}
            {switchedToBaseRef.current && !captionsEnabled && previewAssets?.watermarkUrl && (
              <Image
                source={{ uri: previewAssets.watermarkUrl }}
                style={styles.watermarkOverlay}
                resizeMode="contain"
              />
            )}
            
            {/* Thumbnail overlay while video is loading or source is switching */}
            {(!isVideoReady || isSourceSwitching) && effectiveThumbnailUrl && (
              <Image
                source={{ uri: effectiveThumbnailUrl }}
                style={[StyleSheet.absoluteFill, styles.generatingThumbnail]}
                resizeMode="cover"
              />
            )}
            
            {/* Play/Pause indicator overlay - shows briefly when toggling */}
            {showControls && isVideoReady && (
              <View style={styles.playPauseOverlay}>
                <View style={styles.playPauseIcon}>
                  {isPlaying ? (
                    <Pause size={48} color={Colors.white} strokeWidth={2} fill={Colors.white} />
                  ) : (
                    <Play size={48} color={Colors.white} strokeWidth={2} fill={Colors.white} />
                  )}
                </View>
              </View>
            )}
          </View>
        </TouchableWithoutFeedback>
      )}
      
      {/* Top controls overlay */}
      <View style={[styles.topControls, { paddingTop: insets.top + 16 }]}>
        <IconButton 
          testID="closeVideoPreviewButton"
          onPress={handleClose}
        >
          <X size={28} color={Colors.white} strokeWidth={2.5} />
        </IconButton>
        
        <View style={styles.topControlsRight}>
          {!isGenerating && (
            <IconButton onPress={handleShowOnboarding}>
              <Info size={24} color={Colors.white} strokeWidth={2} />
            </IconButton>
          )}
          {projectId && !isTestMode && (
            <IconButton onPress={handleChatHistory}>
              <MessageSquare size={26} color={Colors.white} strokeWidth={2} />
            </IconButton>
          )}
        </View>
      </View>
      
      {/* Right sidebar controls - hidden during generation */}
      {!isGenerating && (
        <View style={[styles.rightSidebar, { bottom: insets.bottom + 120 }]}>
          {/* Download button */}
          <View ref={downloadButtonRef} collapsable={false}>
            <SidebarButton 
              onPress={handleDownload}
              disabled={isDownloading}
            >
              {isDownloading ? (
                <View style={{ alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={Colors.white} />
                  {downloadProgress > 0 && downloadProgress < 1 && (
                    <Text style={{ color: Colors.white, fontSize: 10, marginTop: 2, fontFamily: Fonts.medium }}>
                      {Math.round(downloadProgress * 100)}%
                    </Text>
                  )}
                </View>
              ) : (
                <Download size={26} color={Colors.white} strokeWidth={2} />
              )}
            </SidebarButton>
          </View>
          
          {/* Toggle group (voice, music, captions) */}
          <View ref={togglesGroupRef} collapsable={false} style={styles.togglesGroup}>
            {/* Voice toggle */}
            <SidebarButton 
              onPress={() => voiceAvailable && setVoiceoverEnabled(!voiceoverEnabled)}
              disabled={!voiceAvailable}
            >
              <Mic 
                size={26} 
                color={!voiceAvailable ? "rgba(255,255,255,0.2)" : voiceoverEnabled ? Colors.white : "rgba(255,255,255,0.5)"} 
                strokeWidth={2} 
              />
            </SidebarButton>
            
            {/* Music toggle */}
            <SidebarButton 
              onPress={() => musicAvailable && setMusicEnabled(!musicEnabled)}
              disabled={!musicAvailable}
            >
              <Music 
                size={26} 
                color={!musicAvailable ? "rgba(255,255,255,0.2)" : musicEnabled ? Colors.white : "rgba(255,255,255,0.5)"} 
                strokeWidth={2} 
              />
            </SidebarButton>
            
            {/* Captions toggle */}
            <SidebarButton 
              onPress={() => captionsAvailable && setCaptionsEnabled(!captionsEnabled)}
              disabled={!captionsAvailable}
            >
              <Subtitles 
                size={26} 
                color={!captionsAvailable ? "rgba(255,255,255,0.2)" : captionsEnabled ? Colors.white : "rgba(255,255,255,0.5)"} 
                strokeWidth={2} 
              />
            </SidebarButton>
          </View>

          {/* Video editor (scissors) button */}
          {projectId && (
            <SidebarButton onPress={handleOpenEditor}>
              <Scissors size={26} color={Colors.white} strokeWidth={2} />
            </SidebarButton>
          )}
        </View>
      )}
      
      {/* Video timeline progress bar - shows when controls are visible */}
      {!isGenerating && showControls && (
        <View 
          style={[styles.timelineContainer, { bottom: insets.bottom + 40 }]}
          onLayout={handleTimelineLayout}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={handleTimelineTouchStart}
          onResponderMove={handleTimelineTouchMove}
          onResponderRelease={handleTimelineTouchEnd}
          onResponderTerminate={handleTimelineTouchEnd}
        >
          {/* Larger touch target area */}
          <View style={styles.timelineTouchArea}>
            <View style={[styles.timelineTrack, isScrubbing && styles.timelineTrackActive]}>
              <View 
                style={[
                  styles.timelineProgress, 
                  { width: `${(isScrubbing ? scrubProgress : progress) * 100}%` }
                ]} 
              />
            </View>
          </View>
        </View>
      )}
      
      {/* Composing toast - visible during entire variant composing process */}
      <Animated.View 
        style={[
          styles.toast, 
          { 
            opacity: composingToastOpacity,
            top: insets.top + 60,
          }
        ]}
        pointerEvents="none"
      >
        <BlurView intensity={40} tint="dark" style={styles.toastBlur}>
          <View style={styles.composingToastRow}>
            <ActivityIndicator size="small" color={Colors.white} />
            <Text style={styles.toastText}>Composing your video...</Text>
          </View>
        </BlurView>
      </Animated.View>

      {/* Download success toast */}
      <Animated.View 
        style={[
          styles.toast, 
          { 
            opacity: toastOpacity,
            top: insets.top + 60,
          }
        ]}
        pointerEvents="none"
      >
        <BlurView intensity={40} tint="dark" style={styles.toastBlur}>
          <Text style={styles.toastText}>This video was saved to camera roll</Text>
        </BlurView>
      </Animated.View>

      {/* Video preview onboarding overlay */}
      <VideoPreviewOnboarding
        visible={showVideoPreviewOnboarding}
        onComplete={handleVideoPreviewOnboardingComplete}
        spotlightRects={onboardingSpotlightRects}
        safeAreaTop={insets.top}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.black,
  },
  fullscreenVideo: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  topControls: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  topControlsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 22,
  },
  rightSidebar: {
    position: 'absolute',
    right: 12,
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    zIndex: 10,
  },
  togglesGroup: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  sidebarButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 24,
  },
  watermarkOverlay: {
    position: 'absolute',
    top: 40 * COVER_SCALE - CROP_Y,
    right: 160 * COVER_SCALE - CROP_X,
    width: 200 * COVER_SCALE,
    height: 200 * COVER_SCALE,
    opacity: 0.7,
  },
  playPauseOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playPauseIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  timelineContainer: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
  },
  timelineTouchArea: {
    height: 40,
    justifyContent: 'center',
    paddingVertical: 16,
  },
  timelineTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 1.5,
    overflow: 'visible',
  },
  timelineTrackActive: {
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
  timelineProgress: {
    height: '100%',
    backgroundColor: Colors.white,
    borderRadius: 1.5,
  },
  generatingThumbnail: {
    width: '100%',
    height: '100%',
  },
  generatingPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: Colors.dark,
  },
  generatingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  generatingPhaseText: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.ember,
    textAlign: 'center',
  },
  generatingSubtitleText: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  generatingHintText: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    paddingHorizontal: 40,
    marginTop: 8,
  },
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    borderRadius: 24,
    overflow: 'hidden',
    zIndex: 20,
  },
  toastBlur: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 0,
    borderColor: 'transparent',
  },
  toastText: {
    fontSize: 15,
    fontFamily: Fonts.medium,
    color: Colors.white,
    textAlign: 'center',
  },
  composingToastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
});
