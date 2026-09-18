import { useLocalSearchParams, useRouter } from 'expo-router';
import { X, Download, Mic, Music, Subtitles, MessageSquare, Loader2, Play, Pause, Info, Scissors, Clapperboard } from 'lucide-react-native';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
// Lazy-load native-only modules to prevent web crashes
let FileSystem: any = null;
let MediaLibrary: any = null;
if (Platform.OS !== 'web') {
  // These imports are native-only and will crash on web
  FileSystem = require('expo-file-system/legacy');
  MediaLibrary = require('expo-media-library/legacy');
}
import AsyncStorage from '@react-native-async-storage/async-storage';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEvent } from 'expo';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';

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

// ─── Sequence Preview Types & Helpers ──────────────────────────────────────

interface SeqSegment {
  id: string;
  file: string;
  startFrom: number;
  duration: number;
}

interface SeqCaption {
  startTime: number;
  endTime: number;
  text: string;
}

function getSeqCacheDir(projectId?: string): string {
  const base = `${FileSystem.cacheDirectory}seq-preview/`;
  return projectId ? `${base}${projectId}/` : base;
}

async function cacheSeqAsset(remoteUrl: string, key: string, projectId?: string): Promise<string> {
  // Extract extension from key (e.g. "video1.mp4"), not remoteUrl (Convex URLs have no extension)
  // If key has no extension, infer: audio files from MiniMax are MP3, videos are MP4
  let ext: string;
  if (key.includes('.')) {
    ext = key.split('.').pop()!;
  } else if (key.includes('voice') || key.includes('music') || key.includes('audio')) {
    ext = 'mp3';
  } else {
    ext = 'mp4';
  }
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseName = safeKey.replace(/\.[^.]+$/, '');
  const filename = `${baseName}.${ext}`;

  const dir = getSeqCacheDir(projectId);
  const target = `${dir}${filename}`;

  const info = await FileSystem.getInfoAsync(target);
  if (info.exists) return target;

  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const downloaded = await FileSystem.downloadAsync(remoteUrl, target);
  if (downloaded.status !== 200) {
    throw new Error(`Download failed with status: ${downloaded.status}`);
  }
  return downloaded.uri;
}

function parseSrtToCaptions(srtContent: string): SeqCaption[] {
  const caps: SeqCaption[] = [];
  const lines = srtContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const timeLine = lines[i];
    if (timeLine.includes('-->')) {
      const [startStr, endStr] = timeLine.split('-->').map(t => t.trim());
      const parseTime = (t: string) => {
        const [h, m, rest] = t.split(':');
        const [s, ms] = rest.split(',');
        return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
      };
      const text = lines[i + 1]?.trim() || '';
      if (text) {
        caps.push({ startTime: parseTime(startStr), endTime: parseTime(endStr), text });
      }
    }
  }
  return caps;
}

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
  // Music is optional — generation may fail, but we can still render without it
  const hasMediaAssets = project.audioUrl && project.videoUrls && project.videoUrls.length > 0;
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
  // NOTE: "rendering" status covers BOTH createSequence AND renderFinalVideo.
  // If timelineJson + sandboxId already exist, createSequence is done —
  // that's not "generating", it's "ready for preview/render".
  const hasSequenceReady = !!(project?.timelineJson && project?.sandboxId);
  const isGenerating = isGeneratingParam && !project?.renderedVideoUrl && !hasSequenceReady && project?.status !== 'completed';
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

  // Render hooks — declared early so handleRender can reference them
  const renderFinalVideo = useAction(api.render.renderFinalVideo);
  const [renderState, setRenderState] = useState<'idle' | 'rendering' | null>(null);
  const renderTriggeredRef = useRef(false);

  // Manage render state based on project data
  useEffect(() => {
    if (!project) return;

    // If video is already rendered, clear render state
    if (project.renderedVideoUrl) {
      setRenderState(null);
      return;
    }

    // If currently rendering the FINAL video (user tapped Render), show rendering state.
    // We detect this by renderProgress.step NOT being "sequence created" —
    // because "sequence created" means createSequence just finished and we're idle.
    // Also require that we're NOT in the idle state already (don't override user's Render tap).
    if (project.status === 'rendering' && project.sandboxId && renderState === 'rendering') {
      return;
    }

    // If sequence is ready (timelineJson + sandboxId) but not yet rendered, show idle render state.
    // This applies regardless of status — createSequence sets status to "rendering" but sequence is ready.
    if (project.timelineJson && project.sandboxId && project.status !== 'failed') {
      setRenderState('idle');
      return;
    }

    // Otherwise, not applicable
    setRenderState(null);
  }, [project?.renderedVideoUrl, project?.status, project?.sandboxId, project?.timelineJson]);

  // Handle render button tap
  const handleRender = useCallback(() => {
    if (!projectId || renderTriggeredRef.current) return;

    renderTriggeredRef.current = true;
    setRenderState('rendering');

    console.log('[video-preview] Starting final render for project:', projectId);
    renderFinalVideo({ projectId })
      .then((result) => {
        if (!result?.success) {
          console.error('[video-preview] Render failed:', result?.error);
          Alert.alert('Render Failed', result?.error || 'Please try again.');
          setRenderState('idle');
          renderTriggeredRef.current = false;
        } else {
          console.log('[video-preview] Render completed:', result.renderedVideoUrl);
        }
      })
      .catch((error) => {
        console.error('[video-preview] Render error:', error);
        Alert.alert('Render Error', `${error}`);
        setRenderState('idle');
        renderTriggeredRef.current = false;
      });
  }, [projectId, renderFinalVideo]);

  // ─── Shared state (moved early for sequence preview references) ──────────
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [showControls, setShowControls] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [voiceoverEnabled, setVoiceoverEnabled] = useState(true);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);

  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  }, []);

  // ─── Sequence Preview State ───────────────────────────────────────────────
  // When sequence is ready (timelineJson + sandboxId) but not yet rendered,
  // we play a client-side preview using the original video clips + audio tracks.

  const getEditorData = useAction(api.tasks.getProjectEditorData);

  // Sequence preview data
  const [seqSegments, setSeqSegments] = useState<SeqSegment[]>([]);
  const [seqClipUrls, setSeqClipUrls] = useState<Record<string, string>>({});
  const [seqCaptions, setSeqCaptions] = useState<SeqCaption[]>([]);
  const [seqTotalDuration, setSeqTotalDuration] = useState(0);
  const [seqAudioSettings, setSeqAudioSettings] = useState<{
    voiceVolume: number;
    musicVolume: number;
    originalSoundVolume: number;
    includeVoice: boolean;
    includeMusic: boolean;
    includeCaptions: boolean;
    includeOriginalSound: boolean;
    voiceSpeed: number;
  } | null>(null);
  const [seqVoiceUrl, setSeqVoiceUrl] = useState<string | null>(null);
  const [seqMusicUrl, setSeqMusicUrl] = useState<string | null>(null);
  const [seqSrtContent, setSeqSrtContent] = useState<string | null>(null);

  // Sequence playback state
  const [seqPlayheadTime, setSeqPlayheadTime] = useState(0);
  const [seqIsPlaying, setSeqIsPlaying] = useState(false);
  const [seqIsReady, setSeqIsReady] = useState(false);
  const seqPlayheadRef = useRef(0);
  seqPlayheadRef.current = seqPlayheadTime;
  const seqIsPlayingRef = useRef(false);
  seqIsPlayingRef.current = seqIsPlaying;

  // Sequence audio refs
  const seqVoiceRef = useRef<AudioPlayer | null>(null);
  const seqMusicRef = useRef<AudioPlayer | null>(null);

  // Sequence video player
  const seqLoadedUrlRef = useRef<string | null>(null);
  const seqActiveSegIdRef = useRef<string | null>(null);
  const seqAutoPlayedRef = useRef(false);

  const isSequencePreview = !isGenerating && !videoUri && renderState === 'idle';

  // Load editor data for sequence preview
  useEffect(() => {
    if (!isSequencePreview || !projectId) return;
    let cancelled = false;

    (async () => {
      try {
        const data = await getEditorData({ projectId });
        if (cancelled) return;

        console.log('[seq-preview] Editor data loaded:', {
          hasTimeline: !!data.timeline,
          segmentCount: data.timeline?.segments?.length ?? 0,
          videoUrlCount: data.videoUrls?.length ?? 0,
          hasSrt: !!data.srtContent,
          hasVoice: !!data.voiceAudioUrl,
          hasMusic: !!data.musicAudioUrl,
        });

        if (!data.timeline?.segments || data.timeline.segments.length === 0) {
          console.warn('[seq-preview] No segments in timeline');
          return;
        }

        // Parse segments
        const parsed: SeqSegment[] = data.timeline.segments.map((s: any, i: number) => ({
          id: `seg_${i}`,
          file: s.file,
          startFrom: s.startFrom || 0,
          duration: s.duration,
        }));

        // Build clip URL map: video0.mp4 → videoUrls[0], video1.mp4 → videoUrls[1], etc.
        // Also includes original uploaded videos appended after animated ones.
        const urlMap: Record<string, string> = {};
        const videoUrls = data.videoUrls || [];
        // Build combined list: animated videoUrls first, then original video fileUrls
        const allVideoUrls: string[] = [...videoUrls];
        const fileUrls = (data as any).fileUrls || [];
        const fileMetadata = (data as any).fileMetadata || [];
        for (let i = 0; i < fileMetadata.length; i++) {
          const meta = fileMetadata[i];
          if (meta && fileUrls[i] && meta.contentType?.startsWith("video/")) {
            allVideoUrls.push(fileUrls[i]);
          }
        }
        for (let i = 0; i < parsed.length; i++) {
          const seg = parsed[i];
          if (!urlMap[seg.file]) {
            // Extract index from "videoN.mp4" pattern
            const match = seg.file.match(/^video(\d+)\./);
            const idx = match ? parseInt(match[1]) : i;
            if (allVideoUrls[idx]) {
              urlMap[seg.file] = allVideoUrls[idx];
            }
          }
        }

        // Cache all unique clip URLs locally for smooth playback
        const uniqueUrls = new Map<string, string[]>();
        for (const [file, url] of Object.entries(urlMap)) {
          if (!uniqueUrls.has(url)) uniqueUrls.set(url, []);
          uniqueUrls.get(url)!.push(file);
        }

        const localUrlMap: Record<string, string> = {};
        await Promise.all(
          Array.from(uniqueUrls.entries()).map(async ([url, files]) => {
            try {
              const localUri = await cacheSeqAsset(url, files[0], projectId);
              for (const f of files) localUrlMap[f] = localUri;
            } catch (e) {
              console.warn('[seq-preview] Failed to cache clip:', files[0], e);
              for (const f of files) localUrlMap[f] = url;
            }
          })
        );

        if (cancelled) return;

        let localVoiceUrl: string | null = null;
        if (data.voiceAudioUrl) {
          try { localVoiceUrl = await cacheSeqAsset(data.voiceAudioUrl, 'voice_audio', projectId); }
          catch (e) { console.warn('[seq-audio] Voice cache failed, using remote:', e); localVoiceUrl = data.voiceAudioUrl; }
        }
        let localMusicUrl: string | null = null;
        if (data.musicAudioUrl) {
          try { localMusicUrl = await cacheSeqAsset(data.musicAudioUrl, 'music_audio', projectId); }
          catch (e) { console.warn('[seq-audio] Music cache failed, using remote:', e); localMusicUrl = data.musicAudioUrl; }
        }

        if (cancelled) return;

        const total = parsed.reduce((sum, s) => sum + s.duration, 0);

        setSeqSegments(parsed);
        setSeqClipUrls(localUrlMap);
        setSeqTotalDuration(total);
        setSeqVoiceUrl(localVoiceUrl);
        setSeqMusicUrl(localMusicUrl);
        setSeqSrtContent(data.srtContent || null);

        // Parse captions from SRT
        if (data.srtContent) {
          setSeqCaptions(parseSrtToCaptions(data.srtContent));
        }

        // Audio settings from timeline
        const tl = data.timeline;
        setSeqAudioSettings({
          voiceVolume: tl?.audio?.voiceVolume ?? data.voiceVolume ?? 1.0,
          musicVolume: tl?.audio?.musicVolume ?? data.musicVolume ?? 0.1,
          originalSoundVolume: tl?.audio?.originalSoundVolume ?? data.originalSoundVolume ?? 0.0,
          includeVoice: tl?.audio?.includeVoice ?? data.includeVoice ?? true,
          includeMusic: tl?.audio?.includeMusic ?? data.includeMusic ?? true,
          includeCaptions: tl?.subtitles?.includeCaptions ?? data.includeCaptions ?? true,
          includeOriginalSound: tl?.audio?.includeOriginalSound ?? data.includeOriginalSound ?? false,
          voiceSpeed: tl?.audio?.playbackRate ?? data.voiceSpeed ?? 1.0,
        });

        // Initialize toggle states
        setVoiceoverEnabled(tl?.audio?.includeVoice ?? data.includeVoice ?? true);
        setMusicEnabled(tl?.audio?.includeMusic ?? data.includeMusic ?? true);
        setCaptionsEnabled(tl?.subtitles?.includeCaptions ?? data.includeCaptions ?? true);

        // Load audio players
        await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });

        if (localVoiceUrl) {
          try {
            const player = createAudioPlayer({ uri: localVoiceUrl });
            player.volume = tl?.audio?.voiceVolume ?? data.voiceVolume ?? 1.0;
            const speed = tl?.audio?.playbackRate ?? data.voiceSpeed ?? 1.0;
            if (speed !== 1.0) {
              try { player.playbackRate = speed; player.shouldCorrectPitch = true; }
              catch (_) { console.warn('[seq-preview] playbackRate failed'); }
            }
            player.pause();
            if (!cancelled) {
              seqVoiceRef.current = player;
            } else {
              player.remove();
            }
          } catch (e) { console.warn('[seq-preview] Failed to load voice:', e); }
        }

        if (localMusicUrl) {
          try {
            const player = createAudioPlayer({ uri: localMusicUrl });
            player.volume = tl?.audio?.musicVolume ?? data.musicVolume ?? 0.1;
            player.pause();
            if (!cancelled) {
              seqMusicRef.current = player;
            } else {
              player.remove();
            }
          } catch (e) { console.warn('[seq-preview] Failed to load music:', e); }
        }

        if (!cancelled) {
          setSeqIsReady(true);
          console.log('[seq-preview] Ready, total duration:', total);
        }
      } catch (e) {
        console.error('[seq-preview] Failed to load editor data:', e);
      }
    })();

    return () => {
      cancelled = true;
      seqVoiceRef.current?.remove();
      seqMusicRef.current?.remove();
      seqVoiceRef.current = null;
      seqMusicRef.current = null;
      setSeqIsReady(false);
      setSeqIsPlaying(false);
    };
  }, [isSequencePreview, projectId, getEditorData]);

  // Sequence preview: compute current segment from playhead time
  const seqCurrentInfo = useMemo(() => {
    let elapsed = 0;
    for (let i = 0; i < seqSegments.length; i++) {
      const seg = seqSegments[i];
      const segEnd = elapsed + seg.duration;
      const isLast = i === seqSegments.length - 1;
      if (seqPlayheadTime >= elapsed && (isLast ? seqPlayheadTime <= segEnd : seqPlayheadTime < segEnd)) {
        return {
          segId: seg.id,
          seekTime: seqPlayheadTime - elapsed + seg.startFrom,
          url: seqClipUrls[seg.file] || null,
        };
      }
      elapsed += seg.duration;
    }
    if (seqSegments.length > 0) {
      const last = seqSegments[seqSegments.length - 1];
      return { segId: last.id, seekTime: last.startFrom + last.duration, url: seqClipUrls[last.file] || null };
    }
    return null;
  }, [seqSegments, seqPlayheadTime, seqClipUrls]);

  // Sequence preview: current caption
  const seqCurrentCaption = useMemo(() => {
    return seqCaptions.find(c => seqPlayheadTime >= c.startTime && seqPlayheadTime <= c.endTime);
  }, [seqCaptions, seqPlayheadTime]);

  // Sequence video player (created once, source swapped via replaceAsync)
  const seqInitialUrl = seqSegments.length > 0 ? (seqClipUrls[seqSegments[0].file] || null) : null;
  const seqVideoPlayer = useVideoPlayer(
    isSequencePreview ? seqInitialUrl : null,
    (player) => {
      if (player && seqInitialUrl) {
        player.loop = false;
        player.muted = !(seqAudioSettings?.includeOriginalSound);
        seqLoadedUrlRef.current = seqInitialUrl;
      }
    }
  );
  const { status: seqPlayerStatus } = useEvent(seqVideoPlayer, 'statusChange', { status: seqVideoPlayer.status });

  // Segment switching: when segment changes, seek or replace video source
  useEffect(() => {
    if (!isSequencePreview || !seqCurrentInfo || !seqVideoPlayer) return;
    if (seqActiveSegIdRef.current === seqCurrentInfo.segId) return;

    const targetUrl = seqCurrentInfo.url;
    const needsSwitch = targetUrl && targetUrl !== seqLoadedUrlRef.current;

    if (needsSwitch && targetUrl) {
      seqActiveSegIdRef.current = seqCurrentInfo.segId;
      seqLoadedUrlRef.current = targetUrl;
      seqVideoPlayer.replaceAsync({ uri: targetUrl });
    } else {
      seqActiveSegIdRef.current = seqCurrentInfo.segId;
      try {
        seqVideoPlayer.currentTime = seqCurrentInfo.seekTime;
        if (seqIsPlayingRef.current) seqVideoPlayer.play();
      } catch {}
    }
  }, [seqCurrentInfo?.segId, seqVideoPlayer, isSequencePreview]);

  // After source switch (replace), seek to correct position
  useEffect(() => {
    if (!isSequencePreview || !seqCurrentInfo || !seqVideoPlayer) return;
    if (seqPlayerStatus !== 'readyToPlay') return;
    try {
      seqVideoPlayer.currentTime = seqCurrentInfo.seekTime;
      if (seqIsPlayingRef.current) seqVideoPlayer.play();
    } catch {}
  }, [isSequencePreview, seqPlayerStatus]);

  // Wall-clock playhead timer
  useEffect(() => {
    if (!isSequencePreview || !seqIsPlaying) {
      seqIsPlayingRef.current = false;
      return;
    }
    seqIsPlayingRef.current = true;

    const startWall = Date.now();
    const startPos = seqPlayheadRef.current;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startWall) / 1000;
      const newTime = Math.min(startPos + elapsed, seqTotalDuration);
      seqPlayheadRef.current = newTime;
      setSeqPlayheadTime(newTime);
    }, 50);

    return () => clearInterval(interval);
  }, [isSequencePreview, seqIsPlaying, seqTotalDuration]);

  // Stop at end of timeline
  useEffect(() => {
    if (isSequencePreview && seqIsPlaying && seqPlayheadTime >= seqTotalDuration && seqTotalDuration > 0) {
      try { seqVideoPlayer?.pause(); } catch {}
      seqVoiceRef.current?.pause();
      seqMusicRef.current?.pause();
      setSeqIsPlaying(false);
      seqIsPlayingRef.current = false;
    }
  }, [isSequencePreview, seqPlayheadTime, seqIsPlaying, seqTotalDuration, seqVideoPlayer]);

  // Sync audio toggle volumes
  useEffect(() => {
    if (seqVoiceRef.current) {
      seqVoiceRef.current.volume = voiceoverEnabled ? (seqAudioSettings?.voiceVolume ?? 1.0) : 0;
    }
  }, [voiceoverEnabled, seqAudioSettings]);

  useEffect(() => {
    if (seqMusicRef.current) {
      seqMusicRef.current.volume = musicEnabled ? (seqAudioSettings?.musicVolume ?? 0.1) : 0;
    }
  }, [musicEnabled, seqAudioSettings]);

  // Sync video player mute based on original sound setting
  useEffect(() => {
    if (seqVideoPlayer && seqAudioSettings) {
      try {
        seqVideoPlayer.muted = !(seqAudioSettings.includeOriginalSound);
        seqVideoPlayer.volume = seqAudioSettings.includeOriginalSound ? seqAudioSettings.originalSoundVolume : 0;
      } catch {}
    }
  }, [seqVideoPlayer, seqAudioSettings]);

  // Sequence play/pause handler
  const handleSeqPlayPause = useCallback(() => {
    if (!seqVideoPlayer) return;

    // Toggle controls visibility
    setShowControls(true);
    resetControlsTimeout();

    if (seqIsPlaying) {
      setSeqIsPlaying(false);
      seqIsPlayingRef.current = false;
      try { seqVideoPlayer.pause(); } catch {}
      seqVoiceRef.current?.pause();
      seqMusicRef.current?.pause();
    } else {
      let startTime = seqPlayheadRef.current;
      let seekTime = seqCurrentInfo?.seekTime ?? 0;

      if (startTime >= seqTotalDuration - 0.05) {
        startTime = 0;
        seqPlayheadRef.current = 0;
        setSeqPlayheadTime(0);
        seqActiveSegIdRef.current = null; // force re-evaluation
        seekTime = seqSegments.length > 0 ? seqSegments[0].startFrom : 0;
      }

      setSeqIsPlaying(true);
      seqIsPlayingRef.current = true;

      if (seqCurrentInfo) {
        try {
          seqVideoPlayer.currentTime = seekTime;
          seqVideoPlayer.play();
        } catch {}
      }

      const posSec = seqPlayheadRef.current;
      const speed = seqAudioSettings?.voiceSpeed ?? 1.0;
      if (seqVoiceRef.current && voiceoverEnabled) {
        seqVoiceRef.current.seekTo(posSec * speed).catch(() => {});
        seqVoiceRef.current.play();
      }
      if (seqMusicRef.current && musicEnabled) {
        seqMusicRef.current.seekTo(posSec).catch(() => {});
        seqMusicRef.current.play();
      }
    }
  }, [seqVideoPlayer, seqIsPlaying, seqTotalDuration, seqCurrentInfo, seqSegments, voiceoverEnabled, musicEnabled, seqAudioSettings, resetControlsTimeout]);

  // Auto-play the sequence preview once, when the sequence is ready and the video player is ready
  useEffect(() => {
    if (!isSequencePreview || !seqIsReady || seqAutoPlayedRef.current) return;
    if (seqPlayerStatus !== 'readyToPlay') return;
    // Skip if the user already started/stopped playback manually before auto-play fired
    if (seqIsPlayingRef.current) return;
    seqAutoPlayedRef.current = true;
    // Small delay so the player fully settles before starting playback
    const t = setTimeout(() => {
      handleSeqPlayPause();
    }, 150);
    return () => clearTimeout(t);
  }, [isSequencePreview, seqIsReady, seqPlayerStatus, handleSeqPlayPause]);

  // Render + download handler for sequence mode
  const handleSeqDownload = useCallback(async () => {
    if (!projectId) return;

    // If not yet rendered, trigger render first
    if (!project?.renderedVideoUrl) {
      console.log('[seq-preview] Starting render before download');
      setRenderState('rendering');
      renderTriggeredRef.current = true;

      try {
        const result = await renderFinalVideo({ projectId });
        if (!result?.success) {
          console.error('[seq-preview] Render failed:', result?.error);
          Alert.alert('Render Failed', result?.error || 'Please try again.');
          setRenderState('idle');
          renderTriggeredRef.current = false;
          return;
        }
        console.log('[seq-preview] Render completed:', result.renderedVideoUrl);
        // Now project.renderedVideoUrl will be available via the live query
      } catch (error) {
        console.error('[seq-preview] Render error:', error);
        Alert.alert('Render Error', `${error}`);
        setRenderState('idle');
        renderTriggeredRef.current = false;
        return;
      }
      // Wait for project query to update with renderedVideoUrl, then download
      // The actual download happens in a separate effect when renderedVideoUrl appears
      return;
    }

    // If already rendered, download directly
    // This will be handled by the existing download flow when videoUri is set
  }, [projectId, project?.renderedVideoUrl, renderFinalVideo]);

  // When render completes in sequence mode, auto-download the video
  useEffect(() => {
    if (!isSequencePreview) return;
    if (project?.renderedVideoUrl && renderTriggeredRef.current && renderState === null) {
      // Render just completed, trigger download
      console.log('[seq-preview] Render completed, starting download');
      const doDownload = async () => {
        try {
          const url = project.renderedVideoUrl!;
          const { status } = await MediaLibrary.requestPermissionsAsync();
          if (status !== 'granted') {
            Alert.alert('Permission Required', 'Please grant permission to save videos to your library.');
            return;
          }

          setIsDownloading(true);
          setDownloadProgress(0);

          const fileUri = `${FileSystem.documentDirectory}wordream_${Date.now()}.mp4`;
          const downloadResumable = FileSystem.createDownloadResumable(
            url, fileUri, {},
            (progress) => {
              if (progress.totalBytesExpectedToWrite > 0) {
                setDownloadProgress(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
              }
            }
          );
          const result = await downloadResumable.downloadAsync();
          if (!result || result.status !== 200) {
            throw new Error(`Download failed with status: ${result?.status}`);
          }

          let fileUriToSave = result.uri;
          if (fileUriToSave.startsWith('file://')) {
            const safePath = `${FileSystem.documentDirectory}wordream_${Date.now()}.mp4`;
            await FileSystem.copyAsync({ from: fileUriToSave, to: safePath });
            fileUriToSave = safePath;
          }

          await MediaLibrary.saveToLibraryAsync(fileUriToSave);
          try { await FileSystem.deleteAsync(fileUriToSave, { idempotent: true }); } catch {}
          setDownloadSuccess(true);
        } catch (error) {
          console.error('[seq-preview] Download error:', error);
          Alert.alert('Error', 'Failed to download video. Please try again.');
        } finally {
          setIsDownloading(false);
          renderTriggeredRef.current = false;
        }
      };
      doDownload();
    }
  }, [isSequencePreview, project?.renderedVideoUrl, renderState]);

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

  // Timeline scrubbing state
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubProgress, setScrubProgress] = useState(0);
  const timelineWidthRef = useRef(0);
  const timelineLeftRef = useRef(0);
  const wasPlayingBeforeScrub = useRef(false);

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
  const voiceSoundRef = useRef<AudioPlayer | null>(null);
  const musicSoundRef = useRef<AudioPlayer | null>(null);
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
  // Skip in sequence preview mode — it has its own audio loading logic
  useEffect(() => {
    if (!previewAssets || isSequencePreview) return;
    let cancelled = false;

    const loadAudio = async () => {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });

      if (previewAssets.voiceAudioUrl && !audioLoadedRef.current.voice) {
        try {
          const player = createAudioPlayer({ uri: previewAssets.voiceAudioUrl });
          player.volume = previewAssets.voiceVolume ?? 1.0;
          // playbackRate is read-only on iOS native; only set when non-default
          // and wrap in try-catch so the player is still assigned even if it fails
          const speed = previewAssets.voiceSpeed ?? 1.0;
          if (speed !== 1.0) {
            try {
              player.playbackRate = speed;
              player.shouldCorrectPitch = true;
            } catch (_) {
              console.warn('[video-preview] playbackRate assignment failed, using default 1.0');
            }
          }
          player.pause();
          if (!cancelled) {
            voiceSoundRef.current = player;
            audioLoadedRef.current.voice = true;
            console.log('[video-preview] Voice audio loaded');
          } else {
            player.remove();
          }
        } catch (e) {
          console.warn('[video-preview] Failed to load voice audio:', e);
        }
      }

      if (previewAssets.musicAudioUrl && !audioLoadedRef.current.music) {
        try {
          const player = createAudioPlayer({ uri: previewAssets.musicAudioUrl });
          player.volume = previewAssets.musicVolume ?? 0.1;
          player.pause();
          if (!cancelled) {
            musicSoundRef.current = player;
            audioLoadedRef.current.music = true;
            console.log('[video-preview] Music audio loaded');
          } else {
            player.remove();
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
      voiceSoundRef.current?.remove();
      musicSoundRef.current?.remove();
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
    AsyncStorage.getItem('@wordream_videoPreviewTipsCompleted').then((value) => {
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
    const currentTimeSec = videoPlayer?.currentTime || 0;

    if (voiceoverEnabled && voiceSoundRef.current) {
      try {
        voiceSoundRef.current.seekTo(currentTimeSec);
        if (playing) voiceSoundRef.current.play();
        else voiceSoundRef.current.pause();
      } catch (_) {}
    } else {
      try { voiceSoundRef.current?.pause(); } catch (_) {}
    }

    if (musicEnabled && musicSoundRef.current) {
      try {
        musicSoundRef.current.volume = previewAssets?.musicVolume ?? 0.1;
        musicSoundRef.current.seekTo(currentTimeSec);
        if (playing) musicSoundRef.current.play();
        else musicSoundRef.current.pause();
      } catch (_) {}
    } else {
      try { musicSoundRef.current?.pause(); } catch (_) {}
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
      voiceSoundRef.current?.pause();
      musicSoundRef.current?.pause();
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
      const videoSec = videoPlayer.currentTime;

      const drift = async (player: AudioPlayer | null) => {
        if (!player) return;
        try {
          if (player.playing && Math.abs(player.currentTime - videoSec) > 0.4) {
            player.seekTo(videoSec);
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
      AsyncStorage.setItem('@wordream_videoPreviewTipsCompleted', 'true').catch(() => {});
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
    voiceSoundRef.current?.pause();
    musicSoundRef.current?.pause();
    seqVoiceRef.current?.pause();
    seqMusicRef.current?.pause();
    try { seqVideoPlayer?.pause(); } catch {}
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
        link.download = `wordream_${Date.now()}.mp4`;
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
          const fileUri = `${FileSystem.documentDirectory}wordream_${Date.now()}.mp4`;
          
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
        console.log('[Download] File URI:', fileUriToSave);
        console.log('[Download] File URI starts with file://:', fileUriToSave.startsWith('file://'));

        // The cache directory may have restricted permissions on iOS.
        // Copy to documentDirectory first for a reliable, accessible file path.
        if (fileUriToSave.startsWith('file://')) {
          const safePath = `${FileSystem.documentDirectory}wordream_${Date.now()}.mp4`;
          console.log('[Download] Copying from cache to:', safePath);
          await FileSystem.copyAsync({ from: fileUriToSave, to: safePath });
          fileUriToSave = safePath;
          console.log('[Download] Copy complete, file ready at:', fileUriToSave);
        }

        // Use saveToLibraryAsync — simpler than createAssetAsync, doesn't require
        // the asset to remain accessible after saving.
        console.log('[Download] Calling saveToLibraryAsync...');
        await MediaLibrary.saveToLibraryAsync(fileUriToSave);
        console.log('[Download] saveToLibraryAsync completed!');

        // Clean up the temp copy
        try { await FileSystem.deleteAsync(fileUriToSave, { idempotent: true }); } catch (_) {}

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
      voiceSoundRef.current?.pause();
      musicSoundRef.current?.pause();
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
      voiceSoundRef.current?.pause();
      musicSoundRef.current?.pause();
      try { seqVideoPlayer?.pause(); } catch {}
      seqVoiceRef.current?.pause();
      seqMusicRef.current?.pause();
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

  // If no video URI and not generating, show render-ready or loading state
  if (!videoUri && !isGenerating) {
    // ── Sequence preview state: client-side playback of original clips ──
    if (renderState === 'idle') {
      return (
        <View style={styles.container}>
          <View style={styles.fullscreenVideo}>
            {seqIsReady && seqCurrentInfo?.url ? (
              <TouchableWithoutFeedback onPress={handleSeqPlayPause}>
                <View style={StyleSheet.absoluteFill}>
                  <VideoView
                    player={seqVideoPlayer}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    nativeControls={false}
                  />
                  {/* Caption overlay */}
                  {captionsEnabled && seqCurrentCaption && (
                    <View style={styles.seqCaptionOverlay}>
                      <Text style={styles.seqCaptionText}>
                        {seqCurrentCaption.text}
                      </Text>
                    </View>
                  )}
                  {/* Play/Pause indicator */}
                  {showControls && (
                    <View style={styles.playPauseOverlay} pointerEvents="none">
                      <View style={styles.playPauseIcon}>
                        {seqIsPlaying ? (
                          <Pause size={48} color={Colors.white} strokeWidth={2} fill={Colors.white} />
                        ) : (
                          <Play size={48} color={Colors.white} strokeWidth={2} fill={Colors.white} />
                        )}
                      </View>
                    </View>
                  )}
                  {/* Loading indicator while assets are loading or segment is switching */}
                  {seqPlayerStatus !== 'readyToPlay' && (
                    <View style={styles.seqLoadingOverlay} pointerEvents="none">
                      <ActivityIndicator size="large" color={Colors.white} />
                    </View>
                  )}
                </View>
              </TouchableWithoutFeedback>
            ) : (
              <>
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
                  <Text style={styles.generatingPhaseText}>Loading Preview</Text>
                  <Text style={styles.generatingSubtitleText}>Preparing your video clips for preview...</Text>
                </View>
              </>
            )}
          </View>

          {/* Top controls */}
          <View style={[styles.topControls, { paddingTop: insets.top + 16 }]}>
            <IconButton onPress={handleClose}>
              <X size={28} color={Colors.white} strokeWidth={2.5} />
            </IconButton>
          </View>

          {/* Right sidebar - Download and Edit buttons */}
          {seqIsReady && (
            <View style={[styles.rightSidebar, { bottom: insets.bottom + 120 }]}>
              {/* Download button (triggers render + download) */}
              <View ref={downloadButtonRef} collapsable={false}>
                <SidebarButton
                  onPress={handleSeqDownload}
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

              {/* Toggle group */}
              <View ref={togglesGroupRef} collapsable={false} style={styles.togglesGroup}>
                <SidebarButton
                  onPress={() => setVoiceoverEnabled(!voiceoverEnabled)}
                >
                  <Mic
                    size={26}
                    color={voiceoverEnabled ? Colors.white : "rgba(255,255,255,0.5)"}
                    strokeWidth={2}
                  />
                </SidebarButton>
                <SidebarButton
                  onPress={() => setMusicEnabled(!musicEnabled)}
                >
                  <Music
                    size={26}
                    color={musicEnabled ? Colors.white : "rgba(255,255,255,0.5)"}
                    strokeWidth={2}
                  />
                </SidebarButton>
                <SidebarButton
                  onPress={() => setCaptionsEnabled(!captionsEnabled)}
                >
                  <Subtitles
                    size={26}
                    color={captionsEnabled ? Colors.white : "rgba(255,255,255,0.5)"}
                    strokeWidth={2}
                  />
                </SidebarButton>
              </View>

              {/* Edit button */}
              {projectId && (
                <SidebarButton onPress={handleOpenEditor}>
                  <Scissors size={26} color={Colors.white} strokeWidth={2} />
                </SidebarButton>
              )}
            </View>
          )}

          {/* Progress bar */}
          {seqIsReady && showControls && (
            <View
              style={[styles.timelineContainer, { bottom: insets.bottom + 40 }]}
            >
              <View style={styles.timelineTouchArea}>
                <View style={styles.timelineTrack}>
                  <View
                    style={[
                      styles.timelineProgress,
                      { width: `${seqTotalDuration > 0 ? (seqPlayheadTime / seqTotalDuration) * 100 : 0}%` }
                    ]}
                  />
                </View>
              </View>
            </View>
          )}

          {/* Download success toast */}
          <Animated.View
            style={[
              styles.toast,
              { opacity: toastOpacity, top: insets.top + 60 }
            ]}
            pointerEvents="none"
          >
            <BlurView intensity={40} tint="dark" style={styles.toastBlur}>
              <Text style={styles.toastText}>This video was saved to camera roll</Text>
            </BlurView>
          </Animated.View>
        </View>
      );
    }

    // ── Rendering state: renderFinalVideo in progress ──
    if (renderState === 'rendering') {
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
            <View style={styles.generatingOverlay}>
              <Animated.View style={{ transform: [{ rotate: spin }] }}>
                <Loader2 size={48} color={Colors.ember} strokeWidth={2} />
              </Animated.View>
              <Text style={styles.generatingPhaseText}>Rendering Video</Text>
              <Text style={styles.generatingSubtitleText}>{project?.renderProgress?.step || 'Rendering your video...'}{"\n"}This takes a few minutes. You can leave the app.</Text>
              <Text style={styles.generatingHintText}>Video takes a couple of minutes to render.{'\n'}You can leave the app.</Text>
            </View>
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

    // ── Default: loading state (Convex query may still resolve) ──
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
              <View style={styles.playPauseOverlay} pointerEvents="none">
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
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
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
  renderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 100,
  },
  renderButtonText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  // ─── Sequence Preview Styles ──────────────────────────────────────────
  seqCaptionOverlay: {
    position: 'absolute',
    bottom: 120,
    left: 20,
    right: 20,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  seqCaptionText: {
    color: Colors.white,
    fontSize: 17,
    fontFamily: Fonts.interSemiBold,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
    letterSpacing: -0.5,
  },
  seqLoadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
});
