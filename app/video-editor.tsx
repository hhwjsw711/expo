import { useLocalSearchParams, useRouter } from 'expo-router';
import { X, Play, Pause, Scissors, Volume2, VolumeX, Eye, EyeOff, ChevronLeft, ZoomIn, ZoomOut } from 'lucide-react-native';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Alert,
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
  Image,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  type TextStyle,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEvent } from 'expo';
import { Audio } from 'expo-av';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Paths, File as FSFile, Directory as FSDirectory } from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { Fonts } from '@/constants/typography';
import { getScreenDimensions } from '@/lib/dimensions';
import { useApp } from '@/contexts/AppContext';

const { width: SCREEN_WIDTH } = getScreenDimensions();

const DEFAULT_PIXELS_PER_SECOND = 80;
const MIN_PIXELS_PER_SECOND = 20;
const MAX_PIXELS_PER_SECOND = 500;
const ZOOM_STEP_FACTOR = 1.4;
const CLIP_TRACK_HEIGHT = 48;
const AUDIO_TRACK_HEIGHT = 40;
const TIMELINE_PADDING = 40;
const PLAYHEAD_OFFSET = SCREEN_WIDTH / 2;
const MIN_CLIP_DURATION = 0.3;
const PREVIEW_HEIGHT = 400;
const ASS_RES_Y = 1920;
const THUMB_WIDTH = 40;

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

// ─── Types ───────────────────────────────────────────────────────────

interface TimelineSegment {
  id: string;
  file: string;
  startFrom: number;
  duration: number;
  originalClipDuration: number;
  comment?: string;
}

interface Caption {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  style?: string;
}

interface EditorState {
  segments: TimelineSegment[];
  voiceoverEnabled: boolean;
  musicEnabled: boolean;
  originalSoundEnabled: boolean;
  captionsEnabled: boolean;
  musicVolume: number;
  voiceoverVolume: number;
  originalSoundVolume: number;
  captions: Caption[];
  playheadTime: number;
  totalDuration: number;
}

interface AssStyle {
  fontName: string;
  fontSize: number;
  primaryColor: string;
  primaryAlpha: number;
  outlineColor: string;
  backColor: string;
  backAlpha: number;
  bold: boolean;
  italic: boolean;
  scaleX: number;
  scaleY: number;
  spacing: number;
  outline: number;
  shadow: number;
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

// ─── ASS Parsing Helpers ─────────────────────────────────────────────

function parseAssTime(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const secParts = parts[2].split('.');
  const seconds = parseInt(secParts[0], 10);
  const centiseconds = parseInt(secParts[1], 10);
  return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
}

function formatAssTime(totalSeconds: number): string {
  const totalCs = Math.round(totalSeconds * 100);
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function parseAssColor(color: string): { hex: string; alpha: number } {
  const raw = color.replace(/^&[Hh]/, '');
  const padded = raw.padStart(8, '0');
  const a = parseInt(padded.substring(0, 2), 16);
  const b = parseInt(padded.substring(2, 4), 16);
  const g = parseInt(padded.substring(4, 6), 16);
  const r = parseInt(padded.substring(6, 8), 16);
  const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  return { hex, alpha: (255 - a) / 255 };
}

function parseAssStyles(assContent: string): AssStyle | null {
  const lines = assContent.split('\n');
  let inStyles = false;
  let formatFields: string[] = [];

  for (const line of lines) {
    if (line.trim() === '[V4+ Styles]') { inStyles = true; continue; }
    if (line.startsWith('[') && !line.includes('V4+ Styles')) { inStyles = false; continue; }
    if (inStyles && line.startsWith('Format:')) {
      formatFields = line.substring('Format:'.length).split(',').map(f => f.trim());
      continue;
    }
    if (inStyles && line.startsWith('Style:')) {
      const styleFields = line.substring('Style:'.length).split(',').map(f => f.trim());
      const get = (name: string) => {
        const idx = formatFields.indexOf(name);
        return idx >= 0 && idx < styleFields.length ? styleFields[idx] : '';
      };
      const primary = parseAssColor(get('PrimaryColour') || '&H00FFFFFF');
      const outline = parseAssColor(get('OutlineColour') || '&H00000000');
      const back = parseAssColor(get('BackColour') || '&H00000000');
      return {
        fontName: get('Fontname') || 'Inter Semi Bold',
        fontSize: parseInt(get('Fontsize')) || 65,
        primaryColor: primary.hex,
        primaryAlpha: primary.alpha,
        outlineColor: outline.hex,
        backColor: back.hex,
        backAlpha: back.alpha,
        bold: parseInt(get('Bold')) !== 0,
        italic: parseInt(get('Italic')) !== 0,
        scaleX: (parseInt(get('ScaleX')) || 100) / 100,
        scaleY: (parseInt(get('ScaleY')) || 100) / 100,
        spacing: parseInt(get('Spacing')) || 0,
        outline: parseFloat(get('Outline')) || 0,
        shadow: parseFloat(get('Shadow')) || 0,
        alignment: parseInt(get('Alignment')) || 2,
        marginL: parseInt(get('MarginL')) || 0,
        marginR: parseInt(get('MarginR')) || 0,
        marginV: parseInt(get('MarginV')) || 0,
      };
    }
  }
  return null;
}

function mapAssFontToRN(fontName: string): string {
  const lower = fontName.toLowerCase();
  if (lower.includes('inter')) {
    if (lower.includes('semi bold') || lower.includes('semibold')) return Fonts.interSemiBold;
    if (lower.includes('bold')) return Fonts.interBold;
    return Fonts.interRegular;
  }
  return Fonts.title;
}

function buildCaptionTextStyle(style: AssStyle): TextStyle {
  const scale = PREVIEW_HEIGHT / ASS_RES_Y;
  const fontScale = scale * 1.25;
  const fontFamily = mapAssFontToRN(style.fontName);
  const isSemiBoldFont = fontFamily === Fonts.interSemiBold;
  const hasShadow = style.shadow > 0 || style.outline > 0;

  return {
    fontFamily,
    fontSize: Math.round(style.fontSize * fontScale),
    color: style.primaryColor,
    fontWeight: isSemiBoldFont ? '600' : style.bold ? 'bold' : 'normal',
    fontStyle: style.italic ? 'italic' : 'normal',
    letterSpacing: Math.round(style.spacing * scale),
    textAlign: 'center',
    textShadowColor: hasShadow ? 'rgba(0, 0, 0, 0.15)' : 'transparent',
    textShadowOffset: hasShadow ? { width: 0, height: 5 } : { width: 0, height: 0 },
    textShadowRadius: hasShadow ? 6 : 0,
    transform: [{ scaleX: style.scaleX }, { scaleY: style.scaleY }],
  };
}

// ─── Caption / Timeline Helpers ──────────────────────────────────────

function parseCaptions(assContent: string): Caption[] {
  const captions: Caption[] = [];
  const lines = assContent.split('\n');
  let inEvents = false;
  let id = 0;

  for (const line of lines) {
    if (line.trim() === '[Events]') { inEvents = true; continue; }
    if (line.startsWith('[') && line !== '[Events]') { inEvents = false; continue; }
    if (inEvents && line.startsWith('Dialogue:')) {
      const parts = line.substring('Dialogue:'.length).split(',');
      if (parts.length >= 10) {
        const startTime = parseAssTime(parts[1].trim());
        const endTime = parseAssTime(parts[2].trim());
        const rawText = parts.slice(9).join(',').trim();
        const text = rawText.replace(/\{[^}]*\}/g, '').trim();
        captions.push({ id: `caption_${id++}`, startTime, endTime, text });
      }
    }
  }
  return captions;
}

function rebuildAssContent(originalAss: string, captions: Caption[]): string {
  const lines = originalAss.split('\n');
  const result: string[] = [];
  let inEvents = false;
  let captionIdx = 0;

  for (const line of lines) {
    if (line.trim() === '[Events]') { inEvents = true; result.push(line); continue; }
    if (line.startsWith('[') && line !== '[Events]') { inEvents = false; result.push(line); continue; }
    if (inEvents && line.startsWith('Dialogue:')) {
      if (captionIdx < captions.length) {
        const cap = captions[captionIdx];
        const parts = line.substring('Dialogue:'.length).split(',');
        parts[1] = formatAssTime(cap.startTime);
        parts[2] = formatAssTime(cap.endTime);
        const originalText = parts.slice(9).join(',').trim();
        const styleMatch = originalText.match(/^(\{[^}]*\})/);
        const styleTag = styleMatch ? styleMatch[1] : '';
        parts[9] = styleTag + cap.text;
        result.push('Dialogue:' + parts.slice(0, 10).join(','));
        captionIdx++;
      } else {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildTimelineJson(state: EditorState, originalTimeline: any): string {
  const totalDuration = state.segments.reduce((sum, s) => sum + s.duration, 0);
  const fps = originalTimeline?.fps ?? 30;
  return JSON.stringify({
    fps,
    durationInFrames: Math.round(totalDuration * fps),
    durationInSeconds: parseFloat(totalDuration.toFixed(2)),
    segments: state.segments.map(s => ({
      file: s.file,
      startFrom: s.startFrom,
      duration: s.duration,
      comment: s.comment || '',
    })),
    audio: {
      voiceFile: originalTimeline?.audio?.voiceFile ?? 'audio.mp3',
      voiceVolume: state.voiceoverVolume,
      playbackRate: originalTimeline?.audio?.playbackRate ?? 1.0,
      musicFile: originalTimeline?.audio?.musicFile ?? 'music.mp3',
      musicVolume: state.musicVolume,
      originalSoundVolume: state.originalSoundVolume,
      includeMusic: state.musicEnabled,
      includeVoice: state.voiceoverEnabled,
      includeOriginalSound: state.originalSoundEnabled,
    },
    subtitles: {
      ...(originalTimeline?.subtitles ?? { file: 'subtitles.srt', adjustForPlaybackRate: true }),
      includeCaptions: state.captionsEnabled,
    },
  }, null, 2);
}

function getCacheDir(projectId?: string): FSDirectory {
  if (projectId) {
    return new FSDirectory(new FSDirectory(Paths.cache, 'video-editor'), projectId);
  }
  return new FSDirectory(Paths.cache, 'video-editor');
}

async function cacheAsset(remoteUrl: string, key: string, projectId?: string): Promise<string> {
  const ext = remoteUrl.split('?')[0].split('.').pop() || 'mp4';
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeKey}.${ext}`;

  const dir = getCacheDir(projectId);
  const target = new FSFile(dir, filename);

  if (target.exists) return target.uri;

  if (!dir.exists) dir.create({ intermediates: true });
  const downloaded = await FSFile.downloadFileAsync(remoteUrl, target);
  return downloaded.uri;
}

async function cacheAllAssets(
  clipUrls: Record<string, string>,
  voiceUrl: string | null,
  musicUrl: string | null,
  projectId?: string,
): Promise<{ localClipUrls: Record<string, string>; localVoiceUrl: string | null; localMusicUrl: string | null }> {
  const localClipUrls: Record<string, string> = {};

  const uniqueUrls = new Map<string, string[]>();
  for (const [file, url] of Object.entries(clipUrls)) {
    if (!uniqueUrls.has(url)) uniqueUrls.set(url, []);
    uniqueUrls.get(url)!.push(file);
  }

  await Promise.all(
    Array.from(uniqueUrls.entries()).map(async ([url, files]) => {
      try {
        const localUri = await cacheAsset(url, files[0], projectId);
        for (const f of files) localClipUrls[f] = localUri;
      } catch (e) {
        console.warn('[video-editor] Failed to cache clip:', files[0], e);
        for (const f of files) localClipUrls[f] = url;
      }
    })
  );

  let localVoiceUrl: string | null = null;
  if (voiceUrl) {
    try { localVoiceUrl = await cacheAsset(voiceUrl, 'voice_audio', projectId); }
    catch { localVoiceUrl = voiceUrl; }
  }

  let localMusicUrl: string | null = null;
  if (musicUrl) {
    try { localMusicUrl = await cacheAsset(musicUrl, 'music_audio', projectId); }
    catch { localMusicUrl = musicUrl; }
  }

  return { localClipUrls, localVoiceUrl, localMusicUrl };
}

async function probeMediaDuration(uri: string): Promise<number | null> {
  try {
    const { sound, status } = await Audio.Sound.createAsync(
      { uri },
      { shouldPlay: false }
    );
    let duration: number | null = null;
    if (status.isLoaded && status.durationMillis) {
      duration = status.durationMillis / 1000;
    }
    await sound.unloadAsync();
    return duration;
  } catch {
    return null;
  }
}

function VolumeSlider({ value, onValueChange, enabled, color, onDragStart, onDragEnd }: {
  value: number;
  onValueChange: (v: number) => void;
  enabled: boolean;
  color: string;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  const widthRef = useRef(0);

  const handleTouch = useCallback((e: any) => {
    if (!enabled || widthRef.current === 0) return;
    const x = Math.max(0, Math.min(e.nativeEvent.locationX, widthRef.current));
    onValueChange(parseFloat((x / widthRef.current).toFixed(2)));
  }, [enabled, onValueChange]);

  const handleGrant = useCallback((e: any) => {
    onDragStart?.();
    handleTouch(e);
  }, [onDragStart, handleTouch]);

  const handleRelease = useCallback(() => {
    onDragEnd?.();
  }, [onDragEnd]);

  const fillColor = enabled ? color : '#555';

  return (
    <View
      style={volumeSliderStyles.container}
      onLayout={(e: any) => { widthRef.current = e.nativeEvent.layout.width; }}
      onStartShouldSetResponder={() => enabled}
      onMoveShouldSetResponder={() => enabled}
      onResponderTerminationRequest={() => false}
      onResponderGrant={handleGrant}
      onResponderMove={handleTouch}
      onResponderRelease={handleRelease}
      onResponderTerminate={handleRelease}
    >
      <View style={[volumeSliderStyles.trackRow, { opacity: enabled ? 1 : 0.35 }]}>
        {value > 0 && (
          <View style={{ flex: value, height: 3, backgroundColor: fillColor, borderRadius: 1.5 }} />
        )}
        <View style={[volumeSliderStyles.thumb, { backgroundColor: fillColor }]} />
        {value < 1 && (
          <View style={{ flex: 1 - value, height: 3, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 1.5 }} />
        )}
      </View>
    </View>
  );
}

const THUMB_DIAMETER = 12;

const volumeSliderStyles = StyleSheet.create({
  container: {
    height: 20,
    justifyContent: 'center',
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 20,
  },
  thumb: {
    width: THUMB_DIAMETER,
    height: THUMB_DIAMETER,
    borderRadius: THUMB_DIAMETER / 2,
  },
});

// ─── Component ───────────────────────────────────────────────────────

export default function VideoEditorScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ projectId: string }>();
  const projectId = params.projectId as any;

  const project = useQuery(
    api.tasks.getProject,
    projectId ? { id: projectId } : "skip"
  );
  const getEditorData = useAction(api.tasks.getProjectEditorData);
  const saveEditorChanges = useAction(api.tasks.saveEditorChanges);
  const { addVideo } = useApp();

  // ── Loading & data ──
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorData, setEditorData] = useState<any>(null);
  const [clipUrls, setClipUrls] = useState<Record<string, string>>({});
  const [originalAssContent, setOriginalAssContent] = useState<string>('');
  const [fallbackVideoUrl, setFallbackVideoUrl] = useState<string | null>(null);
  const [assStyle, setAssStyle] = useState<AssStyle | null>(null);

  // ── Editor state ──
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [voiceoverEnabled, setVoiceoverEnabled] = useState(true);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [originalSoundEnabled, setOriginalSoundEnabled] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [musicVolume, setMusicVolume] = useState(0.1);
  const [voiceoverVolume, setVoiceoverVolume] = useState(1.0);
  const [originalSoundVolume, setOriginalSoundVolume] = useState(1.0);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // ── Zoom ──
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [isPinching, setIsPinching] = useState(false);

  // ── Clip selection & trimming ──
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [trimmingClip, setTrimmingClip] = useState<string | null>(null);
  const [draggingVolume, setDraggingVolume] = useState(false);
  const [trimSide, setTrimSide] = useState<'left' | 'right' | null>(null);
  const [trimStartX, setTrimStartX] = useState(0);
  const [trimOriginalValue, setTrimOriginalValue] = useState(0);

  // ── Thumbnails & durations ──
  const [segmentThumbnails, setSegmentThumbnails] = useState<Record<string, { thumbs: string[]; fullDuration: number; url?: string }>>({});
  const [originalClipDurations, setOriginalClipDurations] = useState<Record<string, number>>({});
  const [voiceDuration, setVoiceDuration] = useState(0);
  const [musicDuration, setMusicDuration] = useState(0);
  const [initialTotalDuration, setInitialTotalDuration] = useState(0);
  const [voiceSpeed, setVoiceSpeed] = useState(1.0);

  // ── Caption editing ──
  const [editingCaption, setEditingCaption] = useState<Caption | null>(null);
  const [editText, setEditText] = useState('');
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  // ── Refs ──
  const voiceSoundRef = useRef<Audio.Sound | null>(null);
  const musicSoundRef = useRef<Audio.Sound | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffsetRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playheadTimeRef = useRef(0);
  const activeSegIdRef = useRef<string | null>(null);
  const loadedSourceUrlRef = useRef<string | null>(null);
  const pixelsPerSecondRef = useRef(DEFAULT_PIXELS_PER_SECOND);
  const pinchBaseRef = useRef(DEFAULT_PIXELS_PER_SECOND);
  const pinchStartDistRef = useRef(0);
  const isPinchingRef = useRef(false);
  const segmentThumbnailsRef = useRef(segmentThumbnails);
  segmentThumbnailsRef.current = segmentThumbnails;

  // ── Derived ──

  const totalDuration = useMemo(() =>
    segments.reduce((sum, s) => sum + s.duration, 0),
    [segments]
  );

  const totalTimelineWidth = useMemo(() =>
    Math.max(totalDuration, initialTotalDuration) * pixelsPerSecond + PLAYHEAD_OFFSET * 2,
    [totalDuration, initialTotalDuration, pixelsPerSecond]
  );

  const currentPreviewInfo = useMemo(() => {
    let elapsed = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segEnd = elapsed + seg.duration;
      const isLast = i === segments.length - 1;
      if (playheadTime >= elapsed && (isLast ? playheadTime <= segEnd : playheadTime < segEnd)) {
        return {
          segId: seg.id,
          file: seg.file,
          seekTime: playheadTime - elapsed + seg.startFrom,
          url: clipUrls[seg.file] || fallbackVideoUrl,
        };
      }
      elapsed += seg.duration;
    }
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      return { segId: last.id, file: last.file, seekTime: last.startFrom + last.duration, url: clipUrls[last.file] || fallbackVideoUrl };
    }
    if (fallbackVideoUrl) {
      return { segId: '__fallback__', file: '__fallback__', seekTime: playheadTime, url: fallbackVideoUrl };
    }
    return null;
  }, [segments, playheadTime, clipUrls, fallbackVideoUrl]);

  const currentCaption = useMemo(() => {
    return captions.find(c => playheadTime >= c.startTime && playheadTime <= c.endTime);
  }, [captions, playheadTime]);

  const captionOverlayStyle = useMemo((): TextStyle => {
    if (assStyle) return buildCaptionTextStyle(assStyle);
    return {
      color: Colors.white,
      fontSize: 17,
      fontFamily: Fonts.interSemiBold,
      fontWeight: '600',
      textAlign: 'center',
      textShadowColor: 'rgba(0, 0, 0, 0.15)',
      textShadowOffset: { width: 0, height: 5 },
      textShadowRadius: 6,
      letterSpacing: -1,
    };
  }, [assStyle]);

  const captionBottomOffset = useMemo(() => {
    if (assStyle) {
      const scale = PREVIEW_HEIGHT / ASS_RES_Y;
      return Math.max(20, assStyle.marginV * scale);
    }
    return 40;
  }, [assStyle]);

  // ── Video player (stable source -- transitions via replace()) ──

  const initialSourceUrl = useMemo(() => {
    if (segments.length > 0) return clipUrls[segments[0].file] || fallbackVideoUrl;
    return fallbackVideoUrl;
  }, []);

  const videoPlayer = useVideoPlayer(
    initialSourceUrl,
    (player) => {
      if (player) {
        player.loop = false;
        player.muted = !originalSoundEnabled;
        loadedSourceUrlRef.current = initialSourceUrl;
      }
    }
  );

  const { status: playerStatus } = useEvent(videoPlayer, 'statusChange', { status: videoPlayer.status });

  useEffect(() => {
    const showListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setIsKeyboardVisible(true),
    );
    const hideListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setIsKeyboardVisible(false),
    );
    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  // Seek + resume when segment changes (use replace() only when source URL differs)
  useEffect(() => {
    if (!currentPreviewInfo || !videoPlayer) return;

    if (activeSegIdRef.current === currentPreviewInfo.segId) return;

    const targetUrl = currentPreviewInfo.url;
    const needsSourceSwitch = targetUrl && targetUrl !== loadedSourceUrlRef.current;

    if (needsSourceSwitch) {
      activeSegIdRef.current = currentPreviewInfo.segId;
      loadedSourceUrlRef.current = targetUrl!;
      videoPlayer.replaceAsync({ uri: targetUrl! });
    } else {
      activeSegIdRef.current = currentPreviewInfo.segId;
      try {
        videoPlayer.currentTime = currentPreviewInfo.seekTime;
        videoPlayer.muted = !originalSoundEnabled;
        if (isPlayingRef.current) videoPlayer.play();
      } catch {}
    }
  }, [currentPreviewInfo?.segId, videoPlayer, originalSoundEnabled]);

  // After replace() finishes loading, seek to correct position and resume
  useEffect(() => {
    if (!currentPreviewInfo || !videoPlayer) return;
    if (playerStatus !== 'readyToPlay') return;
    try {
      videoPlayer.currentTime = currentPreviewInfo.seekTime;
      videoPlayer.muted = !originalSoundEnabled;
      if (isPlayingRef.current) videoPlayer.play();
    } catch {}
  }, [playerStatus]);

  // Seek during scrubbing (paused) or when trim changes the seek target
  useEffect(() => {
    if (isPlayingRef.current || !videoPlayer || playerStatus !== 'readyToPlay') return;
    if (!currentPreviewInfo) return;
    try { videoPlayer.currentTime = currentPreviewInfo.seekTime; } catch {}
  }, [playheadTime, currentPreviewInfo?.seekTime]);

  // Sync mute state
  useEffect(() => {
    if (videoPlayer) {
      try { videoPlayer.muted = !originalSoundEnabled; } catch {}
    }
  }, [originalSoundEnabled, videoPlayer]);

  // ── Audio toggles ──

  useEffect(() => {
    if (voiceSoundRef.current) {
      voiceSoundRef.current.setVolumeAsync(voiceoverEnabled ? voiceoverVolume : 0).catch(() => {});
    }
  }, [voiceoverEnabled, voiceoverVolume]);

  useEffect(() => {
    if (musicSoundRef.current) {
      musicSoundRef.current.setVolumeAsync(musicEnabled ? musicVolume : 0).catch(() => {});
    }
  }, [musicEnabled, musicVolume]);

  useEffect(() => {
    if (videoPlayer) {
      try { videoPlayer.volume = originalSoundEnabled ? originalSoundVolume : 0; } catch {}
    }
  }, [originalSoundEnabled, originalSoundVolume, videoPlayer]);

  // ── Playhead timer (wall-clock based, prevents drift) ──

  useEffect(() => {
    if (!isPlaying) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;

    const startWall = Date.now();
    const startPos = playheadTimeRef.current;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startWall) / 1000;
      const newTime = Math.min(startPos + elapsed, totalDuration);
      playheadTimeRef.current = newTime;
      setPlayheadTime(newTime);
    }, 50);

    return () => clearInterval(interval);
  }, [isPlaying, totalDuration]);

  // Clamp playhead when totalDuration changes (e.g. after trimming)
  useEffect(() => {
    if (!isPlaying && totalDuration > 0 && playheadTimeRef.current > totalDuration) {
      playheadTimeRef.current = Math.max(0, totalDuration - 0.05);
      setPlayheadTime(playheadTimeRef.current);
    }
  }, [totalDuration, isPlaying]);

  // Stop at end of timeline
  useEffect(() => {
    if (isPlaying && playheadTime >= totalDuration && totalDuration > 0) {
      try { videoPlayer?.pause(); } catch {}
      voiceSoundRef.current?.pauseAsync().catch(() => {});
      musicSoundRef.current?.pauseAsync().catch(() => {});
      setIsPlaying(false);
      isPlayingRef.current = false;
    }
  }, [playheadTime, isPlaying, totalDuration]);

  // Scroll timeline with playhead during playback
  useEffect(() => {
    if (isPlaying && scrollRef.current && !selectedClipId) {
      scrollRef.current.scrollTo({ x: playheadTime * pixelsPerSecond, animated: false });
    }
  }, [playheadTime, isPlaying, selectedClipId, pixelsPerSecond]);

  // ── Data loading ──

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    (async () => {
      try {
        const data = await getEditorData({ projectId });
        if (cancelled) return;

        setEditorData(data);
        setClipUrls(data.clipUrls || {});
        setMusicVolume(data.musicVolume || 0.1);
        setFallbackVideoUrl(data.baseVideoUrl || data.renderedVideoUrl || null);

        console.log('[video-editor] Editor data loaded:', {
          hasTimeline: !!data.timeline,
          segmentCount: data.timeline?.segments?.length ?? 0,
          clipUrlKeys: Object.keys(data.clipUrls || {}),
          duration: data.timeline?.durationInSeconds ?? data.duration,
        });

        // Build the unified clip URL map (original clips + fallbacks)
        const allClipUrls: Record<string, string> = { ...data.clipUrls };
        const videoFallback = data.baseVideoUrl || data.renderedVideoUrl;

        // ── Parse segments ──
        let parsedSegments: TimelineSegment[] = [];

        if (data.timeline?.segments && data.timeline.segments.length > 0) {
          parsedSegments = data.timeline.segments.map((s: any, i: number) => ({
            id: `seg_${i}`,
            file: s.file,
            startFrom: s.startFrom || 0,
            duration: s.duration,
            originalClipDuration: s.duration,
            comment: s.comment || '',
          }));

          // Fill in missing clip URLs from fallback
          if (videoFallback) {
            for (const seg of parsedSegments) {
              if (!allClipUrls[seg.file]) {
                allClipUrls[seg.file] = videoFallback;
              }
            }
          }
        } else if (videoFallback) {
          const dur = data.duration || 10;
          const singleFile = '__full_video__';
          parsedSegments = [{
            id: 'seg_0',
            file: singleFile,
            startFrom: 0,
            duration: dur,
            originalClipDuration: dur,
            comment: 'Full video',
          }];
          allClipUrls[singleFile] = videoFallback;
        }

        setSegments(parsedSegments);
        setInitialTotalDuration(parsedSegments.reduce((sum, s) => sum + s.duration, 0));

        // Initialize toggle states from timeline audio/subtitle settings
        if (data.timeline?.audio) {
          setVoiceoverEnabled(data.timeline.audio.includeVoice !== false);
          setMusicEnabled(data.timeline.audio.includeMusic !== false);
          setOriginalSoundEnabled(data.timeline.audio.includeOriginalSound === true);
          if (data.timeline.audio.musicVolume != null) {
            setMusicVolume(data.timeline.audio.musicVolume);
          }
          if (data.timeline.audio.voiceVolume != null) {
            setVoiceoverVolume(data.timeline.audio.voiceVolume);
          }
          if (data.timeline.audio.originalSoundVolume != null) {
            setOriginalSoundVolume(data.timeline.audio.originalSoundVolume);
          }
        }
        if (data.timeline?.subtitles) {
          setCaptionsEnabled(data.timeline.subtitles.includeCaptions !== false);
        }

        // ── Pre-cache all assets locally ──
        console.log('[video-editor] Caching assets...');
        const { localClipUrls, localVoiceUrl, localMusicUrl } = await cacheAllAssets(
          allClipUrls,
          data.voiceAudioUrl || null,
          data.musicAudioUrl || null,
          projectId,
        );
        if (cancelled) return;
        console.log('[video-editor] Assets cached:', Object.keys(localClipUrls).length, 'clips');

        setClipUrls(localClipUrls);
        setFallbackVideoUrl(
          localClipUrls[parsedSegments[0]?.file] || data.baseVideoUrl || data.renderedVideoUrl || null
        );

        // ── Parse captions & ASS styles ──
        if (data.assContent) {
          setOriginalAssContent(data.assContent);
          setCaptions(parseCaptions(data.assContent));
          setAssStyle(parseAssStyles(data.assContent));
        } else if (data.srtContent) {
          setOriginalAssContent('');
          const lines = data.srtContent.split('\n');
          const caps: Caption[] = [];
          let id = 0;
          for (let i = 0; i < lines.length; i++) {
            const timeLine = lines[i];
            if (timeLine.includes('-->')) {
              const [startStr, endStr] = timeLine.split('-->').map((t: string) => t.trim());
              const parseTime = (t: string) => {
                const [h, m, rest] = t.split(':');
                const [s, ms] = rest.split(',');
                return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
              };
              const text = lines[i + 1]?.trim() || '';
              if (text) {
                caps.push({ id: `caption_${id++}`, startTime: parseTime(startStr), endTime: parseTime(endStr), text });
              }
            }
          }
          setCaptions(caps);
        }

        // ── Load audio & probe durations ──
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false });

        const editorVoiceSpeed = data.voiceSpeed ?? 1.0;
        setVoiceSpeed(editorVoiceSpeed);

        const voiceUri = localVoiceUrl || data.voiceAudioUrl;
        if (voiceUri) {
          try {
            const { sound, status } = await Audio.Sound.createAsync(
              { uri: voiceUri },
              { shouldPlay: false, volume: 1.0 }
            );
            voiceSoundRef.current = sound;
            if (editorVoiceSpeed !== 1.0) {
              await sound.setRateAsync(editorVoiceSpeed, true).catch(() => {});
            }
            if (status.isLoaded && status.durationMillis) {
              setVoiceDuration(status.durationMillis / 1000 / editorVoiceSpeed);
            }
          } catch (e) {
            console.warn('[video-editor] Failed to load voice:', e);
          }
        }

        const musicUri = localMusicUrl || data.musicAudioUrl;
        if (musicUri) {
          try {
            const { sound, status } = await Audio.Sound.createAsync(
              { uri: musicUri },
              { shouldPlay: false, volume: data.musicVolume || 0.1 }
            );
            musicSoundRef.current = sound;
            if (status.isLoaded && status.durationMillis) {
              setMusicDuration(status.durationMillis / 1000);
            }
          } catch (e) {
            console.warn('[video-editor] Failed to load music:', e);
          }
        }

        // ── Probe original clip durations (using local cached files) ──
        const probedDurations: Record<string, number> = {};
        const probedUrls = new Map<string, number>();

        for (const seg of parsedSegments) {
          const url = localClipUrls[seg.file] || allClipUrls[seg.file];
          if (!url) continue;
          if (probedUrls.has(url)) {
            probedDurations[seg.file] = probedUrls.get(url)!;
            continue;
          }
          const dur = await probeMediaDuration(url);
          if (dur && dur > 0) {
            probedDurations[seg.file] = dur;
            probedUrls.set(url, dur);
          }
        }

        setOriginalClipDurations(probedDurations);

        // Update segments with probed durations
        if (Object.keys(probedDurations).length > 0) {
          setSegments(prev => prev.map(seg => ({
            ...seg,
            originalClipDuration: probedDurations[seg.file] || seg.originalClipDuration,
          })));
        }

        console.log('[video-editor] Probed clip durations:', probedDurations);

        // ── Generate filmstrip thumbnails per unique clip file ──
        const filmstrips: Record<string, { thumbs: string[]; fullDuration: number; url?: string }> = {};

        const uniqueFiles = new Map<string, { url: string; fullDuration: number }>();
        for (const seg of parsedSegments) {
          if (uniqueFiles.has(seg.file)) continue;
          const url = localClipUrls[seg.file] || allClipUrls[seg.file];
          if (!url) continue;
          const fullDur = probedDurations[seg.file] || seg.originalClipDuration;
          uniqueFiles.set(seg.file, { url, fullDuration: fullDur });
        }

        for (const [file, { url, fullDuration }] of uniqueFiles) {
          const numThumbs = Math.max(2, Math.ceil(fullDuration * DEFAULT_PIXELS_PER_SECOND / THUMB_WIDTH));
          try {
            const thumbList: string[] = [];
            for (let t = 0; t < numThumbs; t++) {
              const frac = numThumbs > 1 ? t / (numThumbs - 1) : 0;
              const timeMs = frac * fullDuration * 1000;
              const { uri } = await VideoThumbnails.getThumbnailAsync(url, {
                time: Math.round(Math.max(0, timeMs)),
                quality: 0.3,
              });
              thumbList.push(uri);
            }
            filmstrips[file] = { thumbs: thumbList, fullDuration, url };
          } catch (e) {
            console.warn(`[video-editor] Filmstrip failed for ${file}:`, e);
          }
        }
        setSegmentThumbnails(filmstrips);

        setLoading(false);
      } catch (e) {
        console.error('[video-editor] Failed to load editor data:', e);
        if (!cancelled) {
          setLoading(false);
          Alert.alert('Error', 'Failed to load editor data.');
        }
      }
    })();

    return () => {
      cancelled = true;
      voiceSoundRef.current?.unloadAsync();
      musicSoundRef.current?.unloadAsync();
    };
  }, [projectId]);

  // ── Lazy thumbnail generation when zooming in past initial density ──
  const thumbGenLockRef = useRef(false);
  useEffect(() => {
    if (loading || thumbGenLockRef.current) return;

    const entries = Object.entries(segmentThumbnailsRef.current);
    if (entries.length === 0) return;

    const neededFiles: { file: string; url: string; fullDuration: number; currentCount: number; desiredCount: number }[] = [];
    for (const [file, data] of entries) {
      if (!data.url) continue;
      const desiredCount = Math.max(2, Math.ceil(data.fullDuration * pixelsPerSecond / THUMB_WIDTH));
      if (desiredCount > data.thumbs.length * 1.3) {
        neededFiles.push({ file, url: data.url, fullDuration: data.fullDuration, currentCount: data.thumbs.length, desiredCount });
      }
    }
    if (neededFiles.length === 0) return;

    thumbGenLockRef.current = true;
    let cancelled = false;
    (async () => {
      for (const { file, url, fullDuration, desiredCount } of neededFiles) {
        if (cancelled) break;
        try {
          const thumbList: string[] = [];
          for (let t = 0; t < desiredCount; t++) {
            if (cancelled) break;
            const frac = desiredCount > 1 ? t / (desiredCount - 1) : 0;
            const timeMs = frac * fullDuration * 1000;
            const { uri } = await VideoThumbnails.getThumbnailAsync(url, {
              time: Math.round(Math.max(0, timeMs)),
              quality: 0.3,
            });
            thumbList.push(uri);
          }
          if (!cancelled && thumbList.length === desiredCount) {
            setSegmentThumbnails(prev => ({
              ...prev,
              [file]: { ...prev[file], thumbs: thumbList },
            }));
          }
        } catch (e) {
          console.warn(`[video-editor] Lazy filmstrip gen failed for ${file}:`, e);
        }
      }
      if (!cancelled) {
        thumbGenLockRef.current = false;
      }
    })();
    return () => { cancelled = true; thumbGenLockRef.current = false; };
  }, [pixelsPerSecond, loading]);

  // ── Handlers ──

  const handlePlayPause = useCallback(async () => {
    if (!videoPlayer) return;

    if (isPlaying) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      try { videoPlayer.pause(); } catch {}
      voiceSoundRef.current?.pauseAsync().catch(() => {});
      musicSoundRef.current?.pauseAsync().catch(() => {});
    } else {
      // Clear selection so auto-scroll follows the playhead
      setSelectedClipId(null);

      let startTime = playheadTimeRef.current;
      let seekTime = currentPreviewInfo?.seekTime ?? 0;

      if (startTime >= totalDuration - 0.05) {
        startTime = 0;
        playheadTimeRef.current = 0;
        setPlayheadTime(0);
        // When restarting from beginning, compute seek time directly to avoid
        // stale closure issue with currentPreviewInfo
        if (segments.length > 0) {
          seekTime = segments[0].startFrom;
        }
      }

      setIsPlaying(true);
      isPlayingRef.current = true;

      if (currentPreviewInfo) {
        try {
          videoPlayer.currentTime = seekTime;
          videoPlayer.play();
        } catch {}
      }

      const posMs = playheadTimeRef.current * 1000;
      if (voiceSoundRef.current && voiceoverEnabled) {
        await voiceSoundRef.current.setPositionAsync(posMs * voiceSpeed).catch(() => {});
        await voiceSoundRef.current.playAsync().catch(() => {});
      }
      if (musicSoundRef.current && musicEnabled) {
        await musicSoundRef.current.setPositionAsync(posMs).catch(() => {});
        await musicSoundRef.current.playAsync().catch(() => {});
      }
    }
  }, [videoPlayer, isPlaying, playheadTime, totalDuration, voiceoverEnabled, musicEnabled, currentPreviewInfo, segments, voiceSpeed]);

  const handleSave = useCallback(async () => {
    if (!editorData?.timeline || saving) return;
    try {
      setSaving(true);
      const state: EditorState = {
        segments, voiceoverEnabled, musicEnabled, originalSoundEnabled,
        captionsEnabled, musicVolume, voiceoverVolume, originalSoundVolume,
        captions, playheadTime, totalDuration,
      };
      const timelineJson = buildTimelineJson(state, editorData.timeline);
      let assContent: string | undefined;
      if (originalAssContent && captions.length > 0) {
        assContent = rebuildAssContent(originalAssContent, captions);
      }
      const result = await saveEditorChanges({ projectId, timelineJson, assContent });
      console.log('[video-editor] Editor export started, new project:', result?.newProjectId);
      Alert.alert('Rendering', 'A new version is being rendered with your edits. This may take a couple of minutes.',
        [{ text: 'OK', onPress: () => {
          if (result?.newProjectId) {
            addVideo({
              id: result.newProjectId,
              uri: '',
              prompt: project?.prompt || '',
              name: project?.name,
              script: project?.script?.replace(/\?\?\?/g, '?'),
              createdAt: Date.now(),
              status: 'processing',
              projectId: result.newProjectId,
              thumbnailUrl: project?.thumbnailUrl,
            });
          }
          router.replace('/(tabs)');
        }}]);
    } catch (e) {
      console.error('[video-editor] Save failed:', e);
      Alert.alert('Error', 'Failed to save changes. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [editorData, segments, voiceoverEnabled, musicEnabled, originalSoundEnabled, captionsEnabled, musicVolume, voiceoverVolume, originalSoundVolume, captions, playheadTime, totalDuration, projectId, saving, originalAssContent, project, addVideo]);

  const handleScroll = useCallback((event: any) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    scrollOffsetRef.current = offsetX;
    if (!isPlayingRef.current) {
      const time = Math.max(0, Math.min(offsetX / pixelsPerSecond, totalDuration));
      playheadTimeRef.current = time;
      setPlayheadTime(time);
    }
  }, [totalDuration, pixelsPerSecond]);

  // Tap on clip to select
  const handleClipTap = useCallback((segId: string) => {
    setSelectedClipId(prev => prev === segId ? null : segId);
  }, []);

  // Deselect when tapping outside clips
  const handleTrackBackgroundTap = useCallback(() => {
    setSelectedClipId(null);
  }, []);

  // Clip trimming with original duration clamping
  const handleTrimStart = useCallback((segId: string, side: 'left' | 'right', pageX: number) => {
    const seg = segments.find(s => s.id === segId);
    if (!seg) return;
    setTrimmingClip(segId);
    setTrimSide(side);
    setTrimStartX(pageX);
    setTrimOriginalValue(side === 'left' ? seg.startFrom : seg.duration);
  }, [segments]);

  const handleTrimMove = useCallback((pageX: number) => {
    if (!trimmingClip || !trimSide) return;
    const deltaX = pageX - trimStartX;
    const deltaSec = deltaX / pixelsPerSecond;

    setSegments(prev => prev.map(seg => {
      if (seg.id !== trimmingClip) return seg;
      const maxDur = seg.originalClipDuration;

      if (trimSide === 'left') {
        const newStartFrom = Math.max(0, Math.min(trimOriginalValue + deltaSec, maxDur - MIN_CLIP_DURATION));
        const durationChange = newStartFrom - seg.startFrom;
        const newDuration = Math.max(MIN_CLIP_DURATION, seg.duration - durationChange);
        return { ...seg, startFrom: newStartFrom, duration: newDuration };
      } else {
        const maxExtend = maxDur - seg.startFrom;
        const newDuration = Math.max(MIN_CLIP_DURATION, Math.min(trimOriginalValue + deltaSec, maxExtend));
        return { ...seg, duration: newDuration };
      }
    }));
  }, [trimmingClip, trimSide, trimStartX, trimOriginalValue, pixelsPerSecond]);

  const handleTrimEnd = useCallback(() => {
    setTrimmingClip(null);
    setTrimSide(null);
  }, []);

  const moveClip = useCallback((fromIndex: number, toIndex: number) => {
    setSegments(prev => {
      const newSegments = [...prev];
      const [moved] = newSegments.splice(fromIndex, 1);
      newSegments.splice(toIndex, 0, moved);
      return newSegments;
    });
  }, []);

  const handleEditCaption = useCallback((caption: Caption) => {
    setEditingCaption(caption);
    setEditText(caption.text);
  }, []);

  const handleSaveCaption = useCallback(() => {
    if (!editingCaption) return;
    setCaptions(prev => prev.map(c =>
      c.id === editingCaption.id ? { ...c, text: editText } : c
    ));
    setEditingCaption(null);
    setEditText('');
  }, [editingCaption, editText]);

  const applyZoom = useCallback((newPps: number) => {
    const clamped = Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, newPps));
    pixelsPerSecondRef.current = clamped;
    setPixelsPerSecond(clamped);
    const currentTime = playheadTimeRef.current;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: currentTime * clamped, animated: false });
    });
  }, []);

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    const prev = pixelsPerSecondRef.current;
    const next = direction === 'in'
      ? prev * ZOOM_STEP_FACTOR
      : prev / ZOOM_STEP_FACTOR;
    applyZoom(next);
  }, [applyZoom]);

  const getTouchDist = (touches: React.TouchList) => {
    const [a, b] = [touches[0], touches[1]];
    const dx = a.pageX - b.pageX;
    const dy = a.pageY - b.pageY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTimelineTouchStart = useCallback((e: any) => {
    const touches = e.nativeEvent.touches;
    if (touches.length === 2) {
      isPinchingRef.current = true;
      setIsPinching(true);
      pinchBaseRef.current = pixelsPerSecondRef.current;
      pinchStartDistRef.current = getTouchDist(touches);
    }
  }, []);

  const handleTimelineTouchMove = useCallback((e: any) => {
    if (!isPinchingRef.current) return;
    const touches = e.nativeEvent.touches;
    if (touches.length < 2) {
      isPinchingRef.current = false;
      setIsPinching(false);
      return;
    }
    const dist = getTouchDist(touches);
    if (pinchStartDistRef.current > 0) {
      const scale = dist / pinchStartDistRef.current;
      applyZoom(pinchBaseRef.current * scale);
    }
  }, [applyZoom]);

  const handleTimelineTouchEnd = useCallback(() => {
    if (isPinchingRef.current) {
      isPinchingRef.current = false;
      setIsPinching(false);
    }
  }, []);

  // ── Render ──

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.ember} />
          <Text style={styles.loadingText}>Loading editor...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
          <ChevronLeft size={24} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{project?.name || 'Untitled'}</Text>
        <TouchableOpacity
          onPress={handleSave}
          style={[styles.exportButton, saving && styles.exportButtonDisabled]}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color={Colors.white} />
          ) : (
            <Text style={styles.exportButtonText}>Export</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Video Preview */}
      <View style={styles.previewContainer}>
        {currentPreviewInfo?.url ? (
          <TouchableOpacity onPress={handlePlayPause} activeOpacity={0.9} style={styles.previewTouchable}>
            {videoEnabled ? (
              <VideoView
                player={videoPlayer}
                style={styles.previewVideo}
                contentFit="contain"
                nativeControls={false}
              />
            ) : (
              <View style={[styles.previewVideo, { backgroundColor: '#000' }]} />
            )}
            {captionsEnabled && currentCaption && (
              <View style={[styles.captionOverlay, { bottom: captionBottomOffset }]}>
                <Text style={captionOverlayStyle}>
                  {currentCaption.text}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ) : (
          <View style={styles.previewPlaceholder}>
            <Text style={styles.previewPlaceholderText}>No preview available</Text>
          </View>
        )}
      </View>

      {/* Playback controls */}
      <TouchableOpacity
        style={styles.playbackControls}
        activeOpacity={1}
        onPress={() => { if (selectedClipId) setSelectedClipId(null); }}
      >
        <Text style={styles.timeText}>
          {formatTime(playheadTime)} / {formatTime(totalDuration)}
        </Text>
        <TouchableOpacity onPress={handlePlayPause} style={styles.playPauseBtn}>
          {isPlaying ? (
            <Pause size={20} color={Colors.white} fill={Colors.white} />
          ) : (
            <Play size={20} color={Colors.white} fill={Colors.white} />
          )}
        </TouchableOpacity>
        <View style={styles.zoomControls}>
          <TouchableOpacity
            onPress={() => handleZoom('out')}
            style={[styles.zoomButton, pixelsPerSecond <= MIN_PIXELS_PER_SECOND && styles.zoomButtonDisabled]}
            disabled={pixelsPerSecond <= MIN_PIXELS_PER_SECOND}
          >
            <ZoomOut size={16} color={pixelsPerSecond <= MIN_PIXELS_PER_SECOND ? Colors.gray600 : Colors.white} />
          </TouchableOpacity>
          <Text style={styles.zoomLabel}>{Math.round((pixelsPerSecond / DEFAULT_PIXELS_PER_SECOND) * 100)}%</Text>
          <TouchableOpacity
            onPress={() => handleZoom('in')}
            style={[styles.zoomButton, pixelsPerSecond >= MAX_PIXELS_PER_SECOND && styles.zoomButtonDisabled]}
            disabled={pixelsPerSecond >= MAX_PIXELS_PER_SECOND}
          >
            <ZoomIn size={16} color={pixelsPerSecond >= MAX_PIXELS_PER_SECOND ? Colors.gray600 : Colors.white} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

      {/* Timeline Area */}
      <View
        style={styles.timelineArea}
        onTouchStart={handleTimelineTouchStart}
        onTouchMove={handleTimelineTouchMove}
        onTouchEnd={handleTimelineTouchEnd}
        onTouchCancel={handleTimelineTouchEnd}
      >
        <View style={[styles.playheadLine, { left: PLAYHEAD_OFFSET }]} />

        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEnabled={!trimmingClip && !draggingVolume && !isPinching}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ width: totalTimelineWidth }}
          style={styles.timelineScroll}
        >
          <View style={[styles.timelineContent, { paddingLeft: PLAYHEAD_OFFSET }]}>
            {/* Time ruler */}
            <View style={styles.timeRuler}>
              {(() => {
                const minTickSpacing = 50;
                const rawInterval = minTickSpacing / pixelsPerSecond;
                const niceIntervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
                const tickInterval = niceIntervals.find(n => n >= rawInterval) || 60;
                const tickCount = Math.ceil(totalDuration / tickInterval) + 1;
                return Array.from({ length: tickCount }, (_, i) => {
                  const timeSec = i * tickInterval;
                  if (timeSec > totalDuration + tickInterval) return null;
                  const showSubSecond = tickInterval < 1;
                  const label = showSubSecond
                    ? `${formatTime(Math.floor(timeSec))}.${
                        tickInterval === 0.25
                          ? Math.round((timeSec % 1) * 100).toString().padStart(2, '0')
                          : Math.round((timeSec % 1) * 10)
                      }`
                    : formatTime(timeSec);
                  return (
                    <View key={`tick_${i}`} style={[styles.timeTick, { left: timeSec * pixelsPerSecond }]}>
                      <View style={styles.tickMark} />
                      <Text style={styles.tickLabel}>{label}</Text>
                    </View>
                  );
                });
              })()}
            </View>

            {/* Video track */}
            <View style={styles.trackContainer}>
              <TouchableOpacity
                style={styles.trackLabel}
                onPress={() => setVideoEnabled(!videoEnabled)}
              >
                {videoEnabled ? (
                  <Eye size={12} color={Colors.ember} />
                ) : (
                  <EyeOff size={12} color={Colors.gray400} />
                )}
                <Text style={[styles.trackLabelText, !videoEnabled && styles.trackLabelMuted]}>Video</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.trackContent}
                activeOpacity={1}
                onPress={handleTrackBackgroundTap}
              >
                {segments.map((seg, index) => {
                  const segStart = segments.slice(0, index).reduce((sum, s) => sum + s.duration, 0);
                  const segWidth = seg.duration * pixelsPerSecond;
                  const filmstrip = segmentThumbnails[seg.file];
                  const isSelected = selectedClipId === seg.id;
                  const isTrimming = trimmingClip === seg.id;

                  return (
                    <View
                      key={seg.id}
                      style={[
                        styles.clipBlock,
                        {
                          left: segStart * pixelsPerSecond,
                          width: segWidth,
                          height: CLIP_TRACK_HEIGHT,
                        },
                        isSelected && styles.clipBlockSelected,
                        isTrimming && styles.clipBlockActive,
                      ]}
                    >
                      {/* Filmstrip thumbnails with offset clipping */}
                      <View style={styles.clipThumbnails}>
                        {filmstrip && filmstrip.thumbs.length > 0 ? (
                          <View style={{
                            position: 'absolute',
                            left: -(seg.startFrom * pixelsPerSecond),
                            width: filmstrip.fullDuration * pixelsPerSecond,
                            top: 0,
                            bottom: 0,
                            flexDirection: 'row',
                          }}>
                            {(() => {
                              const allThumbs = filmstrip.thumbs;
                              const desiredCount = Math.max(1, Math.round(filmstrip.fullDuration * pixelsPerSecond / THUMB_WIDTH));
                              const displayCount = Math.min(desiredCount, allThumbs.length);
                              const thumbW = filmstrip.fullDuration * pixelsPerSecond / displayCount;
                              return Array.from({ length: displayCount }, (_, di) => {
                                const srcIdx = Math.min(
                                  Math.round(di * (allThumbs.length - 1) / Math.max(1, displayCount - 1)),
                                  allThumbs.length - 1
                                );
                                return (
                                  <Image
                                    key={`thumb_${di}_${srcIdx}`}
                                    source={{ uri: allThumbs[srcIdx] }}
                                    style={[styles.clipThumb, { width: thumbW }]}
                                    resizeMode="cover"
                                  />
                                );
                              });
                            })()}
                          </View>
                        ) : (
                          <View style={styles.clipPlaceholder}>
                            <Text style={styles.clipPlaceholderText} numberOfLines={1}>
                              {seg.comment || seg.file}
                            </Text>
                          </View>
                        )}
                      </View>

                      {/* Trim handles - visible only when selected */}
                      {isSelected && (
                        <>
                          <View
                            style={styles.trimHandleLeft}
                            onStartShouldSetResponder={() => true}
                            onMoveShouldSetResponder={() => true}
                            onResponderGrant={(e) => handleTrimStart(seg.id, 'left', e.nativeEvent.pageX)}
                            onResponderMove={(e) => handleTrimMove(e.nativeEvent.pageX)}
                            onResponderRelease={handleTrimEnd}
                            onResponderTerminate={handleTrimEnd}
                          >
                            <View style={styles.trimHandleBar} />
                          </View>
                          <View
                            style={styles.trimHandleRight}
                            onStartShouldSetResponder={() => true}
                            onMoveShouldSetResponder={() => true}
                            onResponderGrant={(e) => handleTrimStart(seg.id, 'right', e.nativeEvent.pageX)}
                            onResponderMove={(e) => handleTrimMove(e.nativeEvent.pageX)}
                            onResponderRelease={handleTrimEnd}
                            onResponderTerminate={handleTrimEnd}
                          >
                            <View style={styles.trimHandleBar} />
                          </View>
                        </>
                      )}

                      {/* Tap to select / long-press to reorder */}
                      <TouchableOpacity
                        style={[styles.clipDragOverlay, !isSelected && { left: 0, right: 0 }]}
                        onPress={() => handleClipTap(seg.id)}
                        onLongPress={() => {
                          if (segments.length <= 1) return;
                          Alert.alert(
                            'Move Clip',
                            `Move "${seg.comment || seg.file}" to position:`,
                            [
                              ...segments.map((_, i) => ({
                                text: `Position ${i + 1}`,
                                onPress: () => { if (i !== index) moveClip(index, i); },
                              })),
                              { text: 'Cancel', style: 'cancel' as const },
                            ]
                          );
                        }}
                        activeOpacity={0.8}
                        delayLongPress={500}
                      >
                        <View />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </TouchableOpacity>
            </View>

            {/* Original Sound track */}
            <View style={[styles.trackContainer, { marginTop: 8 }]}>
              <View style={styles.audioTrackLabel}>
                <TouchableOpacity style={styles.audioTrackLabelRow} onPress={() => setOriginalSoundEnabled(!originalSoundEnabled)}>
                  {originalSoundEnabled ? (
                    <Volume2 size={12} color={Colors.ember} />
                  ) : (
                    <VolumeX size={12} color={Colors.gray400} />
                  )}
                  <Text style={[styles.trackLabelText, !originalSoundEnabled && styles.trackLabelMuted]}>Original Sound</Text>
                </TouchableOpacity>
                <VolumeSlider value={originalSoundVolume} onValueChange={setOriginalSoundVolume} enabled={originalSoundEnabled} color={Colors.ember} onDragStart={() => setDraggingVolume(true)} onDragEnd={() => setDraggingVolume(false)} />
              </View>
              <TouchableOpacity style={styles.trackContent} activeOpacity={1} onPress={handleTrackBackgroundTap}>
                {segments.map((seg, index) => {
                  const segStart = segments.slice(0, index).reduce((sum, s) => sum + s.duration, 0);
                  const segWidth = seg.duration * pixelsPerSecond;
                  const barCount = Math.max(1, Math.floor(segWidth / 3));
                  return (
                    <View
                      key={`orig_sound_${seg.id}`}
                      style={[
                        styles.audioTrack,
                        { position: 'absolute', left: segStart * pixelsPerSecond, width: segWidth, height: AUDIO_TRACK_HEIGHT },
                        !originalSoundEnabled && styles.audioTrackMuted,
                      ]}
                    >
                      <View style={styles.waveformContainer}>
                        {Array.from({ length: barCount }, (_, i) => (
                          <View
                            key={`wave_orig_${index}_${i}`}
                            style={[
                              styles.waveformBar,
                              {
                                height: 8 + seededRandom(i + index * 1000 + 100) * 20,
                                backgroundColor: originalSoundEnabled
                                  ? 'rgba(243, 106, 63, 0.6)'
                                  : 'rgba(100, 100, 100, 0.3)',
                              },
                            ]}
                          />
                        ))}
                      </View>
                    </View>
                  );
                })}
              </TouchableOpacity>
            </View>

            {/* Voiceover track */}
            <View style={styles.trackContainer}>
              <View style={styles.audioTrackLabel}>
                <TouchableOpacity style={styles.audioTrackLabelRow} onPress={() => setVoiceoverEnabled(!voiceoverEnabled)}>
                  {voiceoverEnabled ? (
                    <Volume2 size={12} color="#4CAF50" />
                  ) : (
                    <VolumeX size={12} color={Colors.gray400} />
                  )}
                  <Text style={[styles.trackLabelText, !voiceoverEnabled && styles.trackLabelMuted]}>Voice</Text>
                </TouchableOpacity>
                <VolumeSlider value={voiceoverVolume} onValueChange={setVoiceoverVolume} enabled={voiceoverEnabled} color="#4CAF50" onDragStart={() => setDraggingVolume(true)} onDragEnd={() => setDraggingVolume(false)} />
              </View>
              <TouchableOpacity style={styles.trackContent} activeOpacity={1} onPress={handleTrackBackgroundTap}>
                <View
                  style={[
                    styles.audioTrack,
                    { width: (voiceDuration || initialTotalDuration) * pixelsPerSecond, height: AUDIO_TRACK_HEIGHT },
                    !voiceoverEnabled && styles.audioTrackMuted,
                    { borderColor: '#4CAF50' },
                  ]}
                >
                  <View style={styles.waveformContainer}>
                    {Array.from({ length: Math.max(1, Math.floor((voiceDuration || initialTotalDuration) * pixelsPerSecond / 3)) }, (_, i) => (
                      <View
                        key={`wave_voice_${i}`}
                        style={[
                          styles.waveformBar,
                          {
                            height: 6 + seededRandom(i + 200) * 22,
                            backgroundColor: voiceoverEnabled
                              ? 'rgba(76, 175, 80, 0.6)'
                              : 'rgba(100, 100, 100, 0.3)',
                          },
                        ]}
                      />
                    ))}
                  </View>
                </View>
              </TouchableOpacity>
            </View>

            {/* Music track */}
            <View style={styles.trackContainer}>
              <View style={styles.audioTrackLabel}>
                <TouchableOpacity style={styles.audioTrackLabelRow} onPress={() => setMusicEnabled(!musicEnabled)}>
                  {musicEnabled ? (
                    <Volume2 size={12} color="#2196F3" />
                  ) : (
                    <VolumeX size={12} color={Colors.gray400} />
                  )}
                  <Text style={[styles.trackLabelText, !musicEnabled && styles.trackLabelMuted]}>Music</Text>
                </TouchableOpacity>
                <VolumeSlider value={musicVolume} onValueChange={setMusicVolume} enabled={musicEnabled} color="#2196F3" onDragStart={() => setDraggingVolume(true)} onDragEnd={() => setDraggingVolume(false)} />
              </View>
              <TouchableOpacity style={styles.trackContent} activeOpacity={1} onPress={handleTrackBackgroundTap}>
                <View
                  style={[
                    styles.audioTrack,
                    { width: (musicDuration || initialTotalDuration) * pixelsPerSecond, height: AUDIO_TRACK_HEIGHT },
                    !musicEnabled && styles.audioTrackMuted,
                    { borderColor: '#2196F3' },
                  ]}
                >
                  <View style={styles.waveformContainer}>
                    {Array.from({ length: Math.max(1, Math.floor((musicDuration || initialTotalDuration) * pixelsPerSecond / 3)) }, (_, i) => (
                      <View
                        key={`wave_music_${i}`}
                        style={[
                          styles.waveformBar,
                          {
                            height: 4 + seededRandom(i + 300) * 16,
                            backgroundColor: musicEnabled
                              ? 'rgba(33, 150, 243, 0.6)'
                              : 'rgba(100, 100, 100, 0.3)',
                          },
                        ]}
                      />
                    ))}
                  </View>
                </View>
              </TouchableOpacity>
            </View>

            {/* Captions track */}
            <View style={styles.trackContainer}>
              <TouchableOpacity
                style={styles.trackLabel}
                onPress={() => setCaptionsEnabled(!captionsEnabled)}
              >
                {captionsEnabled ? (
                  <Eye size={12} color="#FF9800" />
                ) : (
                  <EyeOff size={12} color={Colors.gray400} />
                )}
                <Text style={[styles.trackLabelText, !captionsEnabled && styles.trackLabelMuted]}>
                  Captions
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.trackContent} activeOpacity={1} onPress={handleTrackBackgroundTap}>
                {captions.map((cap) => {
                  const capLeft = cap.startTime * pixelsPerSecond;
                  const capWidth = Math.max((cap.endTime - cap.startTime) * pixelsPerSecond, 30);
                  return (
                    <TouchableOpacity
                      key={cap.id}
                      style={[
                        styles.captionBlock,
                        { left: capLeft, width: capWidth, height: AUDIO_TRACK_HEIGHT },
                        !captionsEnabled && styles.captionBlockMuted,
                      ]}
                      onPress={() => handleEditCaption(cap)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.captionBlockText} numberOfLines={1}>{cap.text}</Text>
                    </TouchableOpacity>
                  );
                })}
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </View>

      {/* Caption edit modal */}
      <Modal
        visible={!!editingCaption}
        transparent
        animationType="slide"
        onRequestClose={() => setEditingCaption(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <View style={[styles.modalContent, { paddingBottom: isKeyboardVisible ? 5 : insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Caption</Text>
              <TouchableOpacity onPress={() => setEditingCaption(null)}>
                <X size={24} color={Colors.white} />
              </TouchableOpacity>
            </View>

            {editingCaption && (
              <ScrollView
                style={{ flexShrink: 1 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                <View style={styles.modalBody}>
                  <Text style={styles.modalLabel}>
                    {formatTime(editingCaption.startTime)} - {formatTime(editingCaption.endTime)}
                  </Text>
                  <TextInput
                    style={styles.captionInput}
                    value={editText}
                    onChangeText={setEditText}
                    multiline
                    placeholder="Enter caption text..."
                    placeholderTextColor={Colors.gray500}
                  />
                  <View style={styles.captionPreview}>
                    <Text style={styles.captionPreviewLabel}>Preview:</Text>
                    <View style={styles.captionPreviewBox}>
                      <Text style={[
                        assStyle ? buildCaptionTextStyle(assStyle) : styles.captionPreviewTextDefault,
                      ]}>
                        {editText}
                      </Text>
                    </View>
                  </View>
                  <TouchableOpacity style={styles.saveButton} onPress={handleSaveCaption}>
                    <Text style={styles.saveButtonText}>Save Caption</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111111',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    color: Colors.white,
    fontSize: 16,
    fontFamily: Fonts.regular,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: '#1a1a1a',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  headerButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontFamily: Fonts.medium,
    color: Colors.white,
    textAlign: 'center',
  },
  exportButton: {
    backgroundColor: Colors.ember,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 80,
    alignItems: 'center',
  },
  exportButtonDisabled: {
    opacity: 0.6,
  },
  exportButtonText: {
    color: Colors.white,
    fontSize: 14,
    fontFamily: Fonts.medium,
  },
  previewContainer: {
    height: PREVIEW_HEIGHT,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewTouchable: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewVideo: {
    width: '100%',
    height: '100%',
  },
  previewPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewPlaceholderText: {
    color: Colors.gray500,
    fontSize: 14,
    fontFamily: Fonts.regular,
  },
  captionOverlay: {
    position: 'absolute',
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  playbackControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1a1a1a',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  playPauseBtn: {
    width: 26,
    height: 26,
    justifyContent: 'center',
    alignItems: 'center',
  },
  timeText: {
    position: 'absolute',
    left: 16,
    color: Colors.gray400,
    fontSize: 13,
    fontFamily: Fonts.regular,
    fontVariant: ['tabular-nums'],
  },
  zoomControls: {
    position: 'absolute',
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  zoomButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomButtonDisabled: {
    opacity: 0.4,
  },
  zoomLabel: {
    color: Colors.gray400,
    fontSize: 11,
    fontFamily: Fonts.regular,
    fontVariant: ['tabular-nums'],
    minWidth: 34,
    textAlign: 'center',
  },
  timelineArea: {
    flex: 1,
    backgroundColor: '#111111',
    position: 'relative',
  },
  playheadLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#FFFFFF',
    zIndex: 100,
  },
  timelineScroll: {
    flex: 1,
  },
  timelineContent: {
    paddingTop: 4,
    paddingRight: PLAYHEAD_OFFSET,
  },
  timeRuler: {
    height: 24,
    position: 'relative',
  },
  timeTick: {
    position: 'absolute',
    top: 0,
    alignItems: 'center',
  },
  tickMark: {
    width: 1,
    height: 8,
    backgroundColor: '#444',
  },
  tickLabel: {
    color: '#666',
    fontSize: 10,
    fontFamily: Fonts.regular,
    marginTop: 2,
  },
  trackContainer: {
    flexDirection: 'row',
    marginBottom: 4,
    minHeight: AUDIO_TRACK_HEIGHT,
  },
  trackLabel: {
    width: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 4,
    position: 'absolute',
    left: -PLAYHEAD_OFFSET + 4,
    zIndex: 10,
    height: '100%',
  },
  audioTrackLabel: {
    width: 160,
    flexDirection: 'column',
    justifyContent: 'center',
    paddingLeft: 4,
    paddingRight: 4,
    position: 'absolute',
    left: -PLAYHEAD_OFFSET + 4,
    zIndex: 10,
    height: '100%',
    gap: 1,
  },
  audioTrackLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  trackLabelText: {
    color: Colors.gray400,
    fontSize: 10,
    fontFamily: Fonts.medium,
  },
  trackLabelMuted: {
    color: Colors.gray600,
  },
  trackContent: {
    flex: 1,
    position: 'relative',
    minHeight: AUDIO_TRACK_HEIGHT,
  },
  clipBlock: {
    position: 'absolute',
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: Colors.ember,
    backgroundColor: '#2a2a2a',
  },
  clipBlockSelected: {
    borderColor: '#FFFFFF',
    borderWidth: 2,
  },
  clipBlockActive: {
    borderColor: Colors.white,
    borderWidth: 2.5,
  },
  clipThumbnails: {
    flexDirection: 'row',
    flex: 1,
    overflow: 'hidden',
  },
  clipThumb: {
    height: '100%',
  },
  clipPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  clipPlaceholderText: {
    color: Colors.gray400,
    fontSize: 9,
    fontFamily: Fonts.regular,
  },
  trimHandleLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
  },
  trimHandleRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
  },
  trimHandleBar: {
    width: 3,
    height: 20,
    backgroundColor: Colors.white,
    borderRadius: 2,
  },
  clipDragOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 0,
    bottom: 0,
  },
  audioTrack: {
    position: 'absolute',
    borderRadius: 4,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(243, 106, 63, 0.4)',
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
  },
  audioTrackMuted: {
    opacity: 0.3,
    borderColor: '#444',
    backgroundColor: 'rgba(100, 100, 100, 0.1)',
  },
  waveformContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 1,
    paddingHorizontal: 2,
  },
  waveformBar: {
    width: 2,
    borderRadius: 1,
  },
  captionBlock: {
    position: 'absolute',
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 152, 0, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255, 152, 0, 0.5)',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  captionBlockMuted: {
    opacity: 0.3,
    borderColor: '#444',
    backgroundColor: 'rgba(100, 100, 100, 0.1)',
  },
  captionBlockText: {
    color: Colors.white,
    fontSize: 9,
    fontFamily: Fonts.regular,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  modalBody: {
    gap: 16,
  },
  modalLabel: {
    color: Colors.gray400,
    fontSize: 13,
    fontFamily: Fonts.regular,
  },
  captionInput: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 16,
    color: Colors.white,
    fontSize: 16,
    fontFamily: Fonts.regular,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#3a3a3a',
  },
  captionPreview: {
    gap: 8,
  },
  captionPreviewLabel: {
    color: Colors.gray400,
    fontSize: 12,
    fontFamily: Fonts.regular,
  },
  captionPreviewBox: {
    backgroundColor: '#000',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 60,
  },
  captionPreviewTextDefault: {
    color: Colors.white,
    fontSize: 20,
    fontFamily: Fonts.title,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 4,
    letterSpacing: -0.5,
  },
  saveButton: {
    backgroundColor: Colors.ember,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveButtonText: {
    color: Colors.white,
    fontSize: 16,
    fontFamily: Fonts.medium,
  },
});
