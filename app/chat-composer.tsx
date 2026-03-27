import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { ArrowLeft, Plus, Send, X, Check, Info, Copy, MessageSquare, Volume2, Mic, Gauge, MoreHorizontal, VolumeX, RotateCcw, Pencil } from 'lucide-react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
  Keyboard,
  Pressable,
  Animated,
  ActionSheetIOS,
  InteractionManager,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { VideoExportPreset } from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Paths, File as FSFile, Directory } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useAction, useQuery, useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import * as Clipboard from 'expo-clipboard';
import { Audio } from 'expo-av';
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import {
  retryWithBackoff,
  runWithConcurrency,
  uploadSingleMediaFileToR2,
} from '@/lib/api-helpers';
import { Fonts } from '@/constants/typography';
import { LocalChatMessage } from '@/types';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';
import VoiceConfigModal from '@/components/VoiceConfigModal';
import ChatOnboarding, { SpotlightRect } from '@/components/ChatOnboarding';
import MediaPreviewModal, { PreviewMediaItem } from '@/components/MediaPreviewModal';

const MAX_USER_MESSAGES = 10;
const UPLOAD_CONCURRENCY = 3;
const MAX_MESSAGE_LENGTH = 2500;
const MAX_MEDIA_FILES = 10;
const SCRIPT_LOADING_PHRASES = [
  "Generating script",
  "Composing your story",
  "Wow, what a twist",
  "Your content creator era begins here",
  "Threading your clips into a narrative",
  "Finding the strongest hook",
  "Turning moments into a scroll-stopper",
  "Polishing your plotline",
  "Building your binge-worthy draft",
  "Syncing vibe, voice, and visuals",
  "Cooking up your next viral cut",
];

// Voice speed options
const VOICE_SPEED_OPTIONS = [
  { label: 'Slow', value: 1.0 },
  { label: 'Normal', value: 1.08 },
  { label: 'Fast', value: 1.15 },
  { label: 'Very Fast', value: 1.25 },
];

// Generate a consistent 13-digit numeric ID for media files.
// Ensures all batches produce the same length IDs regardless of timing.
function generateMediaTimestamp(): number {
  const ts = Date.now();
  // Ensure exactly 13 digits: pad with trailing zeros if too short, truncate if too long
  const str = ts.toString();
  if (str.length === 13) return ts;
  if (str.length < 13) return parseInt(str.padEnd(13, '0'), 10);
  return parseInt(str.slice(0, 13), 10);
}

// Extended media type with upload status for inline attachments
interface PendingMedia {
  uri: string;
  type: 'image' | 'video';
  id: string;
  assetId?: string;
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed';
  storageId?: any;
}

// Guard against web where Directory/Paths is not supported
const videoThumbDir: Directory | null = (() => {
  try {
    return new Directory(Paths.cache, 'video-thumbs/');
  } catch {
    return null;
  }
})();

function VideoThumbnail({ uri, style, cacheId }: { uri: string; style: any; cacheId?: string }) {
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const cacheIdRef = useRef(cacheId);
  cacheIdRef.current = cacheId;
  // Track whether we have already generated a thumbnail so that rotating
  // Convex storage URLs don't cancel in-progress or completed work.
  const generatedRef = useRef(false);

  // Reset generatedRef when cacheId changes (different video)
  useEffect(() => {
    generatedRef.current = false;
  }, [cacheId]);

  useEffect(() => {
    if (generatedRef.current && thumbUri) return;

    let cancelled = false;

    (async () => {
      const id = cacheIdRef.current;
      if (id && videoThumbDir) {
        try {
          const cached = new FSFile(videoThumbDir, `${id}.jpg`);
          if (cached.exists) {
            if (!cancelled) {
              generatedRef.current = true;
              setThumbUri(cached.uri);
            }
            return;
          }
        } catch (e) {
          console.warn('[VideoThumbnail] Cache read error:', e);
        }
      }

      let generated: string | undefined;
      try {
        ({ uri: generated } = await VideoThumbnails.getThumbnailAsync(uri, { time: 100, quality: 0.7 }));
      } catch (e) {
        console.warn('[VideoThumbnail] Failed to generate thumbnail:', e);
        return;
      }

      const latestId = cacheIdRef.current;
      if (latestId && videoThumbDir) {
        try {
          if (!videoThumbDir.exists) videoThumbDir.create();
          const dest = new FSFile(videoThumbDir, `${latestId}.jpg`);
          new FSFile(generated).copy(dest);
          if (!cancelled) {
            generatedRef.current = true;
            setThumbUri(dest.uri);
          }
          return;
        } catch (e) {
          console.warn('[VideoThumbnail] Failed to cache thumbnail:', e);
        }
      }

      if (!cancelled) {
        generatedRef.current = true;
        setThumbUri(generated);
      }
    })();

    return () => { cancelled = true; };
  }, [uri, thumbUri]);

  useEffect(() => {
    if (!cacheId || !thumbUri || !videoThumbDir) return;
    try {
      const dest = new FSFile(videoThumbDir, `${cacheId}.jpg`);
      if (dest.exists) return;
      if (!videoThumbDir.exists) videoThumbDir.create();
      new FSFile(thumbUri).copy(dest);
    } catch (e) {
      console.warn('[VideoThumbnail] Failed to late-cache thumbnail:', e);
    }
  }, [cacheId, thumbUri]);

  if (!thumbUri) {
    return <View style={[style, { backgroundColor: Colors.creamDark }]} />;
  }

  return (
    <Image
      source={thumbUri}
      style={style}
      contentFit="cover"
      transition={150}
    />
  );
}

// Typing indicator with animated dots
function TypingIndicator() {
  const [dotCount, setDotCount] = useState(1);
  const [phrase, setPhrase] = useState(SCRIPT_LOADING_PHRASES[0]);
  
  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount(prev => prev >= 3 ? 1 : prev + 1);
    }, 300);
    
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let phraseInterval: ReturnType<typeof setInterval> | null = null;
    const firstRotationTimeout = setTimeout(() => {
      setPhrase((currentPhrase) => {
        const candidates = SCRIPT_LOADING_PHRASES.slice(1).filter((p) => p !== currentPhrase);
        return candidates[Math.floor(Math.random() * candidates.length)] || SCRIPT_LOADING_PHRASES[0];
      });
      phraseInterval = setInterval(() => {
        setPhrase((currentPhrase) => {
          const candidates = SCRIPT_LOADING_PHRASES.slice(1).filter((p) => p !== currentPhrase);
          return candidates[Math.floor(Math.random() * candidates.length)] || SCRIPT_LOADING_PHRASES[0];
        });
      }, 2800);
    }, 3200);

    return () => {
      clearTimeout(firstRotationTimeout);
      if (phraseInterval) {
        clearInterval(phraseInterval);
      }
    };
  }, []);
  
  const dots = '.'.repeat(dotCount);
  // Always reserve space for the maximum 3 dots to prevent text reflow
  const estimatedBubbleWidth = (phrase.length + 3) * 6.1 + 15;
  
  return (
    <View style={[styles.scriptLoadingContainer, { width: estimatedBubbleWidth }]}>
      <Text style={styles.scriptLoadingText} numberOfLines={1}>
        {phrase}
        <Text style={styles.scriptLoadingDots}>{dots}</Text>
      </Text>
    </View>
  );
}

// Animated tap-to-edit indicator for the latest assistant message
function TapToEditIndicator() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
      { iterations: 3 }
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View style={[styles.tapToEditIndicator, { opacity }]}>
      <Pencil size={10} color={Colors.ember} strokeWidth={2.5} />
      <Text style={styles.tapToEditText}>tap to edit</Text>
    </Animated.View>
  );
}

// Chat message bubble component
function ChatBubble({ 
  message, 
  onEditTap, 
  onCopy,
  isLatestAssistant,
  isCopied,
  onPlayVoice,
  isPlayingVoice,
  isGeneratingVoice,
  onRetry,
  onMediaPress,
  measureRef,
}: { 
  message: LocalChatMessage;
  onEditTap?: () => void;
  onCopy?: () => void;
  isLatestAssistant: boolean;
  isCopied?: boolean;
  onPlayVoice?: () => void;
  isPlayingVoice?: boolean;
  isGeneratingVoice?: boolean;
  onRetry?: () => void;
  onMediaPress?: (items: PreviewMediaItem[], index: number) => void;
  measureRef?: React.Ref<View>;
}) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  
  const mediaItems: PreviewMediaItem[] | undefined = message.mediaUris?.map(m => ({
    uri: m.uri,
    type: m.type,
  }));
  
  return (
    <View ref={measureRef} collapsable={false} style={[styles.messageBubbleContainer, isUser && styles.messageBubbleContainerUser]}>
      {/* Media display for user messages */}
      {message.mediaUris && message.mediaUris.length > 0 && mediaItems && (
        <View style={[styles.messageMediaGrid, isUser && styles.messageMediaGridUser]}>
          {message.mediaUris.map((media, index) => (
            <TouchableOpacity
              key={index}
              style={styles.messageMediaItem}
              activeOpacity={0.8}
              onPress={() => onMediaPress?.(mediaItems, index)}
            >
              {media.type === 'video' ? (
                <VideoThumbnail uri={media.uri} style={styles.messageMediaImage} cacheId={media.storageId} />
              ) : (
                <Image
                  source={{ uri: media.uri }}
                  style={styles.messageMediaImage}
                  contentFit="cover"
                  cachePolicy="disk"
                  recyclingKey={media.storageId || `msg-${message.id}-${index}`}
                  transition={150}
                />
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}
      
      {/* Message content */}
      {(message.content || message.isLoading) && (
        <Pressable 
          style={[
            styles.messageBubble, 
            isUser ? styles.messageBubbleUser : styles.messageBubbleAssistant,
            message.isLoading && styles.messageBubbleLoading,
          ]}
          onPress={isAssistant && isLatestAssistant ? onEditTap : undefined}
          onLongPress={message.content ? onCopy : undefined}
        >
          {message.isLoading ? (
            <View style={styles.scriptLoadingContainer}>
              <TypingIndicator />
            </View>
          ) : (
            <>
              <Text style={[styles.messageText, isUser && styles.messageTextUser]}>
                {message.content.replace(/\?\?\?/g, '?')}
              </Text>
              {message.isEdited && (
                <Text style={styles.editedLabel}>Edited</Text>
              )}
              {isAssistant && isLatestAssistant && !message.isEdited && (
                <TapToEditIndicator />
              )}
            </>
          )}
        </Pressable>
      )}

      {message.isLoading && (
        <Text style={[styles.scriptHint, { marginTop: 6, marginLeft: 4 }]}>
          might take a few minutes{'\n'}you can close the app, we'll notify you when it's ready
        </Text>
      )}
      
      {/* Action buttons for user messages */}
      {isUser && !message.isLoading && message.content && (
        <View style={[styles.messageActions, styles.messageActionsUser]}>
          {isCopied ? (
            <View style={styles.copiedFeedback}>
              <Check size={14} color={Colors.ember} strokeWidth={2.5} />
              <Text style={styles.copiedText}>Copied</Text>
            </View>
          ) : (
            <TouchableOpacity onPress={onCopy} style={styles.actionButton}>
              <Copy size={14} color={Colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      )}
      
      {/* Action buttons for assistant messages */}
      {isAssistant && !message.isLoading && (
        <View style={styles.messageActions}>
          {message.isError ? (
            <TouchableOpacity onPress={onRetry} style={styles.retryActionButton}>
              <RotateCcw size={14} color={Colors.ember} />
              <Text style={styles.retryActionText}>Retry</Text>
            </TouchableOpacity>
          ) : (
            <>
              {/* Copy button */}
              {isCopied ? (
                <View style={styles.copiedFeedback}>
                  <Check size={14} color={Colors.ember} strokeWidth={2.5} />
                  <Text style={styles.copiedText}>Copied</Text>
                </View>
              ) : (
                <TouchableOpacity onPress={onCopy} style={styles.actionButton}>
                  <Copy size={14} color={Colors.textSecondary} />
                </TouchableOpacity>
              )}
              
              {/* Voice preview button */}
              <TouchableOpacity 
                onPress={onPlayVoice} 
                style={styles.actionButton}
                disabled={isGeneratingVoice}
              >
                {isGeneratingVoice ? (
                  <ActivityIndicator size={14} color={Colors.ember} />
                ) : isPlayingVoice ? (
                  <VolumeX size={14} color={Colors.ember} />
                ) : (
                  <Volume2 size={14} color={Colors.textSecondary} />
                )}
              </TouchableOpacity>
              
              {/* Script hint for latest assistant message */}
              {isLatestAssistant && (
                <Text style={styles.scriptHint}>this message will be used as a script</Text>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

// Full-screen script editor modal
function ScriptEditor({
  visible,
  script,
  onSave,
  onClose,
}: {
  visible: boolean;
  script: string;
  onSave: (newScript: string) => void;
  onClose: () => void;
}) {
  const [editedScript, setEditedScript] = useState(script);
  const insets = useSafeAreaInsets();
  
  useEffect(() => {
    setEditedScript(script);
  }, [script, visible]);
  
  if (!visible) return null;
  
  return (
    <View style={[styles.editorOverlay, { paddingTop: insets.top }]}>
      <View style={styles.editorHeader}>
        <TouchableOpacity onPress={onClose} style={styles.editorCloseButton}>
          <X size={24} color={Colors.ink} />
        </TouchableOpacity>
        <Text style={styles.editorTitle}>Edit Script</Text>
        <TouchableOpacity onPress={() => onSave(editedScript)} style={styles.editorSaveButton}>
          <Check size={24} color={Colors.ember} />
        </TouchableOpacity>
      </View>
      <TextInput
        style={styles.editorInput}
        value={editedScript.replace(/\?\?\?/g, '?')}
        onChangeText={setEditedScript}
        multiline
        textAlignVertical="top"
        autoFocus
        placeholderTextColor={Colors.gray400}
      />
    </View>
  );
}

export default function ChatComposerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ projectId?: string; fromVideo?: string }>();
  const projectId = params.projectId as any;
  const fromVideo = params.fromVideo === 'true';
  const insets = useSafeAreaInsets();
  const { user, userId, addVideo } = useApp();
  
  // Fetch backend user for voice configuration check
  const backendUser = useQuery(
    api.users.getCurrentUser,
    userId ? { userId } : "skip"
  );
  
  // State
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [mediaUris, setMediaUris] = useState<PendingMedia[]>([]);
  const [sentMediaIds, setSentMediaIds] = useState<Set<string>>(new Set()); // Track media already sent in messages
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasScript, setHasScript] = useState(false);
  const [userMessageCount, setUserMessageCount] = useState(0);
  const [showEditor, setShowEditor] = useState(false);
  const [editingScript, setEditingScript] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(projectId || null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isProcessingMedia, setIsProcessingMedia] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  
  // Track if we've forked from a completed video project
  const [hasForkedFromVideo, setHasForkedFromVideo] = useState(false);
  const [originalVideoProjectId] = useState<string | null>(fromVideo ? projectId : null);
  const [isForking, setIsForking] = useState(false);
  
  // Voice preview state
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [generatingVoiceMessageId, setGeneratingVoiceMessageId] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const audioCache = useRef<Map<string, string>>(new Map()); // messageId -> audioUrl
  
  // Project settings state
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.08); // Default: Normal
  const [keepOrder, setKeepOrder] = useState<boolean>(false);
  
  // Voice configuration modal state (progressive disclosure)
  const [showVoiceConfigModal, setShowVoiceConfigModal] = useState(false);
  const [pendingVoiceAction, setPendingVoiceAction] = useState<{
    type: 'play' | 'submit';
    messageId?: string;
    content?: string;
  } | null>(null);
  const hasShownVoicePromptRef = useRef(false);
  const skipVoiceCheckRef = useRef(false); // Temporary flag to skip voice check after config
  
  // Chat onboarding tips state
  const [showChatOnboarding, setShowChatOnboarding] = useState(false);
  const [spotlightRects, setSpotlightRects] = useState<(SpotlightRect | null)[]>([null, null, null, null, null]);
  const [onboardingUsesLatest, setOnboardingUsesLatest] = useState(false);
  const [chatTipsCompletedLocally, setChatTipsCompletedLocally] = useState(false);
  const scriptBubbleRef = useRef<View>(null);
  const latestScriptBubbleRef = useRef<View>(null);
  const threeDotsRef = useRef<View>(null);
  
  // Media preview state
  const [previewMedia, setPreviewMedia] = useState<{ items: PreviewMediaItem[]; index: number } | null>(null);
  
  // Load local chat tips completion flag on mount
  useEffect(() => {
    AsyncStorage.getItem('@reelfull_chatTipsCompleted').then((value) => {
      if (value === 'true') setChatTipsCompletedLocally(true);
    });
  }, []);
  const composerRef = useRef<View>(null);
  const generateButtonRef = useRef<View>(null);
  const keepClipsOrderRef = useRef<View>(null);
  
  const hasAutoOpenedPicker = useRef(false);
  const scrollViewRef = useRef<ScrollView>(null);
  const keyboardVisibleRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const isMountedRef = useRef(true);
  const scriptBackfillRef = useRef<Set<string>>(new Set());
  const pendingOnboardingRef = useRef(false);
  const mediaUrisRef = useRef(mediaUris);
  const inputTextRef = useRef(inputText);
  const mediaUrlsRefreshTimeRef = useRef<number>(Date.now());
  const messageUrlsRefreshTimeRef = useRef<number>(Date.now());
  
  // Stores the arguments from the last generateScript call so we can retry on failure
  const lastGenerateArgsRef = useRef<{
    userInput: string;
    isNewMedia: boolean;
    newMediaCount: number;
    newMediaIds: string[];
    userMessagePersisted: boolean;
  } | null>(null);
  
  // Convex hooks
  const convex = useConvex();
  const createChatProject = useMutation(api.tasks.createChatProject);
  const addFilesToProject = useMutation(api.tasks.addFilesToProject);
  const addChatMessage = useMutation(api.tasks.addChatMessage);
  const updateChatMessage = useMutation(api.tasks.updateChatMessage);
  const updateChatProjectPrompt = useMutation(api.tasks.updateChatProjectPrompt);
  const forkChatProject = useMutation(api.tasks.forkChatProject);
  const generateChatScript = useAction(api.aiServices.generateChatScript);
  const markProjectSubmitted = useMutation(api.tasks.markProjectSubmitted);
  const updateProjectScript = useMutation(api.tasks.updateProjectScript);
  const generateScriptPreviewAudio = useAction(api.aiServices.generateScriptPreviewAudio);
  const updateProjectVoiceSpeed = useMutation(api.tasks.updateProjectVoiceSpeed);
  const updateProjectKeepOrder = useMutation(api.tasks.updateProjectKeepOrder);
  const refreshProjectR2Urls = useAction(api.tasks.refreshProjectR2Urls);
  const regenerateProjectEditing = useMutation(api.tasks.regenerateProjectEditing);
  const completeChatTips = useMutation(api.users.completeChatTips);
  const generateMultipleR2UploadUrls = useAction(api.r2Storage.generateMultipleR2UploadUrls);
  const importR2FileToConvexStorage = useAction(api.tasks.importR2FileToConvexStorage);
  
  // Track if we've already tried to refresh R2 URLs for this project
  const hasAttemptedR2Refresh = useRef(false);
  // Guard against double-tap on close button
  const isClosingRef = useRef(false);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => { mediaUrisRef.current = mediaUris; }, [mediaUris]);
  useEffect(() => { inputTextRef.current = inputText; }, [inputText]);
  
  // Fetch current project data (tracks newly created/forked chat projects too)
  const existingProject = useQuery(
    api.tasks.getProject,
    createdProjectId ? { id: createdProjectId as any } : "skip"
  );
  
  // Fetch existing chat messages
  const existingMessages = useQuery(
    api.tasks.getChatMessages,
    createdProjectId ? { projectId: createdProjectId as any } : "skip"
  );
  
  // Helper: Fork the project if coming from a completed video (never modify original)
  const forkProjectIfNeeded = async (): Promise<string | null> => {
    // Only fork if we came from a video and haven't forked yet
    if (!fromVideo || hasForkedFromVideo || !originalVideoProjectId) {
      return createdProjectId;
    }
    
    setIsForking(true);
    try {
      console.log('[chat-composer] Forking project from completed video:', originalVideoProjectId);
      const newProjectId = await forkChatProject({
        sourceProjectId: originalVideoProjectId as any,
      });
      
      console.log('[chat-composer] Forked to new project:', newProjectId);
      setCreatedProjectId(newProjectId);
      setHasForkedFromVideo(true);
      return newProjectId;
    } catch (error) {
      console.error('[chat-composer] Failed to fork project:', error);
      Alert.alert('Error', 'Failed to create a new draft from this video. Please try again.');
      return null;
    } finally {
      setIsForking(false);
    }
  };

  // Load existing project data
  useEffect(() => {
    if (existingProject && projectId && messages.length === 0) {
      // Load media from project
      if (existingProject.fileUrls && existingProject.fileMetadata) {
        const mediaFromProject = existingProject.fileUrls
          .map((url: string | null, index: number) => {
            if (!url) return null;
            const metadata = existingProject.fileMetadata?.[index];
            const isVideo = metadata?.contentType?.startsWith('video/') ?? false;
            return {
              uri: url,
              type: (isVideo ? 'video' : 'image') as 'video' | 'image',
              id: `existing-${index}`,
              storageId: metadata?.storageId,
              uploadStatus: 'uploaded' as const,
            };
          })
          .filter((item: any): item is typeof mediaUris[0] => item !== null);
        
        setMediaUris(mediaFromProject);
      }
      
      // Sync voice speed from project (so UI reflects the actual configured speed)
      if (existingProject.voiceSpeed) {
        setVoiceSpeed(existingProject.voiceSpeed);
      }
      
      // If coming from video preview, load chat history
      if (existingProject.chatEnabled && existingMessages) {
        // Create a lookup map from storageId to file metadata for media type detection
        const metadataByStorageId = new Map<string, { contentType: string }>();
        existingProject.fileMetadata?.forEach((meta: any) => {
          if (meta?.storageId) {
            metadataByStorageId.set(meta.storageId, meta);
          }
        });
        
        const loadedMessages: LocalChatMessage[] = existingMessages.map((msg: any) => ({
          id: msg._id,
          role: msg.role,
          content: msg.content,
          isEdited: msg.isEdited,
          createdAt: msg.createdAt,
          // Map mediaUrls back to mediaUris format for UI display
          mediaUris: msg.mediaUrls && msg.mediaIds 
            ? msg.mediaUrls
                .map((url: string | null, index: number) => {
                  if (!url) return null;
                  const storageId = msg.mediaIds[index];
                  // Look up media type from project metadata
                  const metadata = storageId ? metadataByStorageId.get(storageId) : null;
                  const isVideo = metadata?.contentType?.startsWith('video/') ?? false;
                  return {
                    uri: url,
                    type: (isVideo ? 'video' : 'image') as 'video' | 'image',
                    storageId: storageId,
                  };
                })
                .filter((item: any): item is { uri: string; type: 'video' | 'image'; storageId: string } => item !== null)
            : undefined,
        }));
        const hasAssistantMessage = loadedMessages.some(m => m.role === 'assistant');
        const hasProjectScript = !!existingProject.script?.trim();
        let hydratedMessages = loadedMessages;

        // Background generation can complete after this screen unmounts, which may leave
        // project.script populated but chatMessages missing the assistant response.
        // Backfill the UI and persist once so notification-opened chats remain consistent.
        if (!hasAssistantMessage && hasProjectScript) {
          hydratedMessages = [
            ...loadedMessages,
            {
              id: `script-backfill-${existingProject._id}`,
              role: 'assistant',
              content: existingProject.script!,
              createdAt: existingProject.scriptGeneratedAt || existingProject.createdAt || Date.now(),
            },
          ];

          const projectKey = String(existingProject._id);
          if (!scriptBackfillRef.current.has(projectKey)) {
            scriptBackfillRef.current.add(projectKey);
            addChatMessage({
              projectId: existingProject._id,
              role: 'assistant',
              content: existingProject.script!,
            }).catch((error) => {
              console.error('[chat-composer] Failed to backfill assistant script message:', error);
            });
          }
        }

        setMessages(hydratedMessages);
        setUserMessageCount(existingProject.userMessageCount || 0);
        
        // Consider script present if either assistant chat exists or project.script is set.
        setHasScript(hasAssistantMessage || hasProjectScript);
        
        // Mark all existing media as "sent" so they don't appear in the composer.
        // Only do this when there are actual messages (media was sent with those).
        // For drafts with no messages yet, media should remain in the composer.
        if (loadedMessages.length > 0) {
          const existingMediaIds = new Set<string>();
          for (let i = 0; i < (existingProject.fileUrls?.length || 0); i++) {
            existingMediaIds.add(`existing-${i}`);
          }
          setSentMediaIds(existingMediaIds);
        }
      }
    }
  }, [existingProject, existingMessages, projectId]);
  
  // Refresh R2 URLs for old projects where Convex storage has been deleted
  // This regenerates presigned URLs from R2 keys stored in fileMetadata
  useEffect(() => {
    if (!existingProject || !projectId || hasAttemptedR2Refresh.current) return;
    
    // Check if we have fileMetadata with R2 keys but some/all fileUrls are null
    const hasR2Keys = existingProject.fileMetadata?.some((meta: any) => meta.r2Key);
    const hasMissingUrls = existingProject.fileUrls?.some((url: string | null) => !url);
    
    if (hasR2Keys && hasMissingUrls && existingProject.fileMetadata && existingProject.fileMetadata.length > 0) {
      console.log('[chat-composer] Detected missing file URLs with R2 keys available, refreshing R2 URLs...');
      hasAttemptedR2Refresh.current = true;
      
      refreshProjectR2Urls({ projectId })
        .then((result) => {
          console.log('[chat-composer] R2 URL refresh result:', result);
        })
        .catch((error) => {
          console.error('[chat-composer] Failed to refresh R2 URLs:', error);
        });
    }
  }, [existingProject, projectId, refreshProjectR2Urls]);
  
  // Refresh media URLs when an existing URL is missing or potentially expired.
  // Convex generates new signed URLs on every query re-evaluation, and swapping
  // them frequently causes expo-image to restart downloads endlessly. To avoid
  // this, we only refresh if (a) the URL is missing, or (b) enough time has
  // passed that the URL may have expired (~1 hour for Convex URLs).
  useEffect(() => {
    if (!existingProject || !projectId) return;
    
    if (existingProject.fileUrls && existingProject.fileMetadata && mediaUris.length > 0) {
      const now = Date.now();
      const timeSinceLastRefresh = now - mediaUrlsRefreshTimeRef.current;
      const shouldAllowExpiredRefresh = timeSinceLastRefresh > 30 * 60 * 1000; // 30 minutes
      
      const freshMediaUris = mediaUris.map((media) => {
        if (media.id.startsWith('existing-')) {
          const existingIndex = parseInt(media.id.replace('existing-', ''));
          const freshUrl = existingProject.fileUrls?.[existingIndex];
          // Replace if URL is missing, or if URL changed and enough time passed (expired)
          if (freshUrl && (!media.uri || (freshUrl !== media.uri && shouldAllowExpiredRefresh))) {
            console.log(`[chat-composer] Refreshing URL for media ${existingIndex}`);
            return { ...media, uri: freshUrl };
          }
        }
        return media;
      });
      
      const urlsChanged = freshMediaUris.some((m, i) => m.uri !== mediaUris[i].uri);
      if (urlsChanged) {
        mediaUrlsRefreshTimeRef.current = now;
        setMediaUris(freshMediaUris);
      }
    }
  }, [existingProject?.fileUrls, projectId]);
  
  // Refresh message media URLs when missing or potentially expired.
  // Same rationale as above — avoid frequent URL swaps but handle expiration.
  useEffect(() => {
    if (!existingMessages) return;
    
    const now = Date.now();
    const timeSinceLastRefresh = now - messageUrlsRefreshTimeRef.current;
    const shouldAllowExpiredRefresh = timeSinceLastRefresh > 30 * 60 * 1000; // 30 minutes
    
    const freshUrlsMap = new Map<string, (string | null)[]>();
    existingMessages.forEach((msg: any) => {
      if (msg.mediaUrls) {
        freshUrlsMap.set(msg._id, msg.mediaUrls);
      }
    });
    if (freshUrlsMap.size === 0) return;
    
    setMessages(prev => {
      if (prev.length === 0) return prev;
      let hasChanges = false;
      const updated = prev.map(msg => {
        const freshUrls = freshUrlsMap.get(msg.id);
        if (freshUrls && msg.mediaUris) {
          const updatedMediaUris = msg.mediaUris.map((media, index) => {
            const freshUrl = freshUrls[index];
            if (freshUrl && (!media.uri || (freshUrl !== media.uri && shouldAllowExpiredRefresh))) {
              hasChanges = true;
              return { ...media, uri: freshUrl };
            }
            return media;
          });
          return { ...msg, mediaUris: updatedMediaUris };
        }
        return msg;
      });
      if (hasChanges) {
        messageUrlsRefreshTimeRef.current = now;
      }
      return hasChanges ? updated : prev;
    });
  }, [existingMessages]);
  
  // Sync local message IDs with backend Convex IDs
  // Local messages get synthetic IDs (assistant-*, user-*) but backend saves them
  // with real Convex IDs. We need to sync so edits go through updateChatMessage.
  useEffect(() => {
    if (!existingMessages || existingMessages.length === 0) return;
    
    const normalize = (s: string) => s.replace(/\?\?\?/g, '?');
    
    setMessages(prev => {
      if (prev.length === 0) return prev;
      
      const hasSyntheticIds = prev.some(m => 
        m.id.startsWith('assistant-') || m.id.startsWith('user-') || m.id.startsWith('script-backfill-')
      );
      if (!hasSyntheticIds) return prev;
      
      const usedIds = new Set<string>(
        prev
          .filter(m =>
            !m.id.startsWith('assistant-') &&
            !m.id.startsWith('user-') &&
            !m.id.startsWith('script-backfill-')
          )
          .map(m => m.id)
      );

      const backendByRole = new Map<string, any[]>();
      existingMessages.forEach((msg: any) => {
        if (usedIds.has(msg._id)) return;
        const list = backendByRole.get(msg.role) || [];
        list.push(msg);
        backendByRole.set(msg.role, list);
      });
      
      let hasChanges = false;
      const updated = prev.map(msg => {
        if (
          !msg.id.startsWith('assistant-') &&
          !msg.id.startsWith('user-') &&
          !msg.id.startsWith('script-backfill-')
        ) {
          return msg;
        }
        
        const candidates = backendByRole.get(msg.role) || [];
        const normalizedLocal = normalize(msg.content);
        const matchIdx = candidates.findIndex((bm: any) => normalize(bm.content) === normalizedLocal);
        if (matchIdx !== -1) {
          const match = candidates[matchIdx];
          hasChanges = true;
          candidates.splice(matchIdx, 1);
          return { ...msg, id: match._id };
        }
        return msg;
      });
      
      return hasChanges ? updated : prev;
    });
  }, [existingMessages]);
  
  // Auto-focus keyboard for new projects (after screen transition completes)
  useFocusEffect(
    useCallback(() => {
      if (!projectId && !hasAutoOpenedPicker.current && messages.length === 0) {
        hasAutoOpenedPicker.current = true;
        // Wait for screen transition animation to fully complete
        const task = InteractionManager.runAfterInteractions(() => {
          // Additional delay to ensure screen is fully rendered
          setTimeout(() => {
            inputRef.current?.focus();
          }, 500);
        });
        return () => task.cancel();
      }
    }, [projectId, messages.length])
  );
  
  // Scroll to bottom when new messages are added
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);
  
  // Scroll to bottom when keyboard appears and track keyboard visibility
  useEffect(() => {
    const scrollToBottom = () => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 350);
    };
    
    const handleKeyboardShow = () => {
      setKeyboardVisible(true);
      keyboardVisibleRef.current = true;
      scrollToBottom();
    };
    
    const handleKeyboardHide = () => {
      setKeyboardVisible(false);
      keyboardVisibleRef.current = false;
    };
    
    const keyboardWillShowListener = Keyboard.addListener(
      'keyboardWillShow',
      handleKeyboardShow
    );
    const keyboardDidShowListener = Keyboard.addListener(
      'keyboardDidShow',
      handleKeyboardShow
    );
    const keyboardWillHideListener = Keyboard.addListener(
      'keyboardWillHide',
      handleKeyboardHide
    );
    const keyboardDidHideListener = Keyboard.addListener(
      'keyboardDidHide',
      handleKeyboardHide
    );
    
    return () => {
      keyboardWillShowListener.remove();
      keyboardDidShowListener.remove();
      keyboardWillHideListener.remove();
      keyboardDidHideListener.remove();
    };
  }, []);
  
  // Dismiss keyboard when loading overlay is shown
  useEffect(() => {
    if (isProcessingMedia) {
      Keyboard.dismiss();
    }
  }, [isProcessingMedia]);

  // Dismiss keyboard whenever chat onboarding is active
  useEffect(() => {
    if (showChatOnboarding) {
      Keyboard.dismiss();
    }
  }, [showChatOnboarding]);
  
  const pickMedia = async () => {
    // Dismiss keyboard immediately when opening media picker
    Keyboard.dismiss();
    
    if (mediaUris.length >= MAX_MEDIA_FILES) {
      Alert.alert('Limit Reached', `You can upload a maximum of ${MAX_MEDIA_FILES} media files.`);
      return;
    }
    
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please grant permission to access your photos.');
      return;
    }
    
    // Add a 2 second delay before showing the loading indicator
    // This prevents the overlay from flashing for quick operations
    const loadingTimeout = setTimeout(() => {
      setIsProcessingMedia(true);
    }, 2000);
    
    const remaining = MAX_MEDIA_FILES - mediaUris.length;
    
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos', 'images'],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 1,
        videoExportPreset: VideoExportPreset.H264_1920x1080,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        // Show as half-screen sheet on iOS so "Hello, [user]!" header is visible
        presentationStyle: ImagePicker.UIImagePickerPresentationStyle.FORM_SHEET,
      });
      
      if (!result.canceled && result.assets.length > 0) {
        const assets = result.assets.slice(0, remaining);
        const baseTimestamp = generateMediaTimestamp();
        const newMedia: PendingMedia[] = assets.map((asset, index) => ({
          uri: asset.uri,
          type: (asset.type === 'video' ? 'video' : 'image') as 'video' | 'image',
          id: `${baseTimestamp + index}`,
          assetId: asset.assetId ?? undefined,
          uploadStatus: 'pending' as const,
        }));
        
        // Add media immediately to show placeholders in UI
        const allMedia = [...mediaUris, ...newMedia];
        setMediaUris(allMedia);
        
        // Start uploading in background (no overlay)
        uploadMediaInBackground(allMedia, newMedia);
      }
    } catch (error) {
      console.error('Error picking media:', error);
    } finally {
      // Cancel the loading timeout if operation finished before 2 seconds
      clearTimeout(loadingTimeout);
      // Clear processing state after ImagePicker returns
      setIsProcessingMedia(false);
    }
  };
  
  const uploadMediaInBackground = async (allMedia: PendingMedia[], newMediaOnly: PendingMedia[]) => {
    const filesToUpload = newMediaOnly.filter(m => !m.storageId);
    
    if (filesToUpload.length === 0) {
      inputRef.current?.focus();
      return;
    }
    
    // Mark all as uploading
    setMediaUris(prev => prev.map(m => 
      filesToUpload.some(f => f.id === m.id) 
        ? { ...m, uploadStatus: 'uploading' as const }
        : m
    ));
    
    // 1. Batch-generate R2 presigned upload URLs for all files
    const fileMetadataForR2 = filesToUpload.map((item, index) => {
      const ext = item.type === 'video' ? 'mp4' : 'jpg';
      return {
        filename: `${item.type}_${item.id}_${index}.${ext}`,
        contentType: item.type === 'video' ? 'video/mp4' : 'image/jpeg',
      };
    });

    let r2UploadInfos: { filename: string; uploadUrl: string; key: string; r2Url?: string }[];
    try {
      r2UploadInfos = await retryWithBackoff(
        () => generateMultipleR2UploadUrls({ files: fileMetadataForR2 }),
        3,
        2000
      );
    } catch (error) {
      console.error('[upload] Failed to generate R2 upload URLs after retries', error);
      setMediaUris(prev => prev.map(m =>
        filesToUpload.some(f => f.id === m.id)
          ? { ...m, uploadStatus: 'failed' as const }
          : m
      ));
      setTimeout(() => inputRef.current?.focus(), 100);
      return;
    }

    // 2. Upload each file to R2 in parallel (concurrency-limited) with retry,
    //    then import into Convex storage for the storageId.
    await runWithConcurrency(filesToUpload, UPLOAD_CONCURRENCY, async (item, index) => {
      try {
        const r2Info = r2UploadInfos[index];
        const contentType = fileMetadataForR2[index].contentType;

        // Upload directly to R2 with retry (2 retries, 2s base backoff)
        const r2Result = await retryWithBackoff(
          () => uploadSingleMediaFileToR2(
            { uri: item.uri, type: item.type, assetId: item.assetId },
            r2Info,
            contentType
          ),
          3,
          2000
        );

        // Import the R2 file into Convex storage to obtain a storageId
        const { storageId } = await retryWithBackoff(
          () => importR2FileToConvexStorage({
            r2Url: r2Result.r2Url,
            r2Key: r2Result.r2Key,
            contentType,
          }),
          3,
          2000
        );

        setMediaUris(prev => prev.map(m =>
          m.id === item.id
            ? { ...m, uploadStatus: 'uploaded' as const, storageId }
            : m
        ));
      } catch (error) {
        console.error('Failed to upload file', item.id, error);
        setMediaUris(prev => prev.map(m =>
          m.id === item.id
            ? { ...m, uploadStatus: 'failed' as const }
            : m
        ));
      }
    });
    
    // Focus input after all uploads - user can add a prompt and press Send
    setTimeout(() => inputRef.current?.focus(), 100);
  };
  
  const removeMedia = (id: string) => {
    setMediaUris(prev => prev.filter(m => m.id !== id));
  };
  
  const handleSend = async () => {
    const selectedMedia = mediaUris.filter(m => !sentMediaIds.has(m.id));
    const mediaNotReady = selectedMedia.some(
      (media) => media.uploadStatus !== 'uploaded'
    );
    if (mediaNotReady) {
      return;
    }

    // Get pending media (uploaded but not yet sent in a message)
    const pendingMedia = mediaUris.filter(m => m.storageId && !sentMediaIds.has(m.id));
    const hasPendingMedia = pendingMedia.length > 0;
    
    // Check message limit
    if (userMessageCount >= MAX_USER_MESSAGES) {
      Alert.alert(
        'Message Limit Reached',
        'You can edit the script directly by tapping on it, or approve and generate your video.'
      );
      return;
    }
    
    // Check character limit
    if (inputText.length > MAX_MESSAGE_LENGTH) {
      return;
    }
    
    // Need either media or text for first message
    if (!hasScript && pendingMedia.length === 0) {
      Alert.alert('No Media', 'Please add some photos or videos first.');
      return;
    }
    
    // For follow-up messages, need either text or new media
    if (hasScript && !inputText.trim() && !hasPendingMedia) {
      // Nothing to send - this shouldn't happen with proper UI state
      return;
    }
    
    Keyboard.dismiss();
    
    // Create user message with any pending media
    const userMessage: LocalChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: inputText.trim(),
      mediaUris: hasPendingMedia ? pendingMedia.map(m => ({
        uri: m.uri,
        type: m.type,
        storageId: m.storageId,
      })) : undefined,
      createdAt: Date.now(),
    };
    
    // Mark pending media as sent
    if (hasPendingMedia) {
      setSentMediaIds(prev => {
        const newSet = new Set(prev);
        pendingMedia.forEach(m => newSet.add(m.id));
        return newSet;
      });
    }
    
    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setUserMessageCount(prev => prev + 1);
    
    // Get new media IDs for generateScript
    const newMediaIds = hasPendingMedia 
      ? pendingMedia.map(m => m.storageId).filter((id): id is string => !!id)
      : [];
    
    await generateScript(inputText.trim(), hasPendingMedia, pendingMedia.length, newMediaIds);
  };
  
  const generateScript = async (userInput: string, isNewMedia = false, newMediaCount = 0, newMediaIds: string[] = [], isRetry = false) => {
    if (!isMountedRef.current) return;
    lastGenerateArgsRef.current = { userInput, isNewMedia, newMediaCount, newMediaIds, userMessagePersisted: false };
    setIsGenerating(true);
    let requestProjectId: string | null = createdProjectId;
    
    // Add loading message
    const loadingMessage: LocalChatMessage = {
      id: `loading-${Date.now()}`,
      role: 'assistant',
      content: '',
      isLoading: true,
      createdAt: Date.now(),
    };
    setMessages(prev => [...prev.filter(m => !m.isError), loadingMessage]);
    
    try {
      // If coming from a video, fork the project first (never modify original)
      let currentProjectId = requestProjectId;
      if (fromVideo && !hasForkedFromVideo) {
        currentProjectId = await forkProjectIfNeeded();
        requestProjectId = currentProjectId;
        if (!currentProjectId) {
          if (isMountedRef.current) {
            setMessages(prev => prev.filter(m => !m.isLoading));
            setIsGenerating(false);
          }
          return;
        }
      }
      
      if (!currentProjectId) {
        const uploadedMedia = mediaUris.filter(m => m.storageId);
        const fileMetadata = uploadedMedia.map(m => ({
          storageId: m.storageId,
          filename: `${m.type}_${m.id}.${m.type === 'video' ? 'mp4' : 'jpg'}`,
          contentType: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
          size: 0,
        }));
        
        currentProjectId = await createChatProject({
          userId,
          files: uploadedMedia.map(m => m.storageId),
          fileMetadata,
          thumbnail: uploadedMedia[0]?.storageId,
        });
        requestProjectId = currentProjectId;
        
        if (isMountedRef.current) {
          setCreatedProjectId(currentProjectId);
        }
        
        // Update prompt
        if (userInput) {
          await updateChatProjectPrompt({
            projectId: currentProjectId,
            prompt: userInput,
          });
        }
      }
      
      // Store user message in backend (skip on retry only if already persisted by the original call)
      if (!isRetry || !lastGenerateArgsRef.current?.userMessagePersisted) {
        const uploadedMediaForMessage = mediaUris.filter(m => m.storageId);
        
        let mediaIdsToAttach: string[] | undefined;
        if (!hasScript && uploadedMediaForMessage.length > 0) {
          mediaIdsToAttach = uploadedMediaForMessage.map(m => m.storageId).filter(Boolean) as string[];
        } else if (isNewMedia && newMediaIds.length > 0) {
          mediaIdsToAttach = newMediaIds;
        }
        
        await addChatMessage({
          projectId: currentProjectId,
          role: 'user',
          content: userInput || '',
          messageIndex: userMessageCount + 1,
          mediaIds: mediaIdsToAttach as any,
        });
        if (lastGenerateArgsRef.current) {
          lastGenerateArgsRef.current.userMessagePersisted = true;
        }
      }

      // Keep project-level media in sync for follow-up messages with new uploads.
      // Composition/rendering reads project.files + project.fileMetadata.
      const isFollowUpWithNewMedia = hasScript && isNewMedia && newMediaIds.length > 0;
      let newMediaFilesForCaptioning:
        | { url: string; filename: string; contentType: string }[]
        | undefined;
      if (isFollowUpWithNewMedia) {
        const newMediaIdSet = new Set(newMediaIds);
        const uniqueNewMedia = Array.from(
          new Map(
            mediaUris
              .filter(m => m.storageId && newMediaIdSet.has(m.storageId))
              .map(m => [String(m.storageId), m])
          ).values()
        );

        if (uniqueNewMedia.length > 0) {
          const filesToAdd = uniqueNewMedia
            .map(m => m.storageId)
            .filter((id): id is string => !!id);

          const fileMetadataToAdd = uniqueNewMedia
            .filter((m): m is PendingMedia & { storageId: string } => !!m.storageId)
            .map((m) => ({
              storageId: m.storageId as any,
              filename: `${m.type}_${m.id}.${m.type === 'video' ? 'mp4' : 'jpg'}`,
              contentType: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
              size: 0,
            }));

          if (filesToAdd.length > 0 && fileMetadataToAdd.length > 0) {
            await addFilesToProject({
              projectId: currentProjectId,
              files: filesToAdd as any,
              fileMetadata: fileMetadataToAdd as any,
            });
          }

          const newMediaFilesRaw = await Promise.all(
            uniqueNewMedia.map(async (media) => {
              if (!media.storageId) return null;
              const url = await convex.query(api.tasks.getStorageUrl, {
                storageId: media.storageId as any,
              });
              if (!url) return null;
              return {
                url,
                filename: `${media.type}_${media.id}.${media.type === 'video' ? 'mp4' : 'jpg'}`,
                contentType: media.type === 'video' ? 'video/mp4' : 'image/jpeg',
              };
            })
          );
          newMediaFilesForCaptioning = newMediaFilesRaw.filter(
            (item): item is { url: string; filename: string; contentType: string } => item !== null
          );
        }
      }
      
      // Build conversation history for AI, excluding transient loading/error messages
      // and media-only user messages (empty content). Media context is conveyed via
      // storageIds / media descriptions, not synthetic placeholder text.
      const conversationHistory = messages
        .filter(m => !m.isLoading && !m.isError)
        .filter(m => !(m.role === 'user' && !m.content.trim() && m.mediaUris && m.mediaUris.length > 0))
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      
      // Add the current user message. For media-only sends the content is empty;
      // the backend handles empty user text with appropriate fallbacks.
      const currentInput = userInput.trim();
      const lastEntry = conversationHistory[conversationHistory.length - 1];
      if (!lastEntry || lastEntry.role !== 'user' || lastEntry.content !== currentInput) {
        conversationHistory.push({
          role: 'user',
          content: currentInput,
        });
      }
      
      // Use pre-computed media descriptions if available (from Gemini captioning)
      const cachedDescriptions = existingProject?.mediaDescriptions;
      
      // Generate script (saveAndNotify: true means backend saves script and sends notification)
      // Backend will wait for captions from the captioning pipeline if not yet available.
      const result = await generateChatScript({
        projectId: currentProjectId,
        conversationHistory,
        cachedMediaDescriptions: cachedDescriptions,
        newMediaFiles: newMediaFilesForCaptioning,
        isFirstMessage: !hasScript,
        isNewMedia,
        newMediaCount,
        saveAndNotify: true,
      });
      
      // Remove loading message and add real response
      if (isMountedRef.current) {
        setMessages(prev => {
        const withoutLoading = prev.filter(m => !m.isLoading);
        
        if (result.success && result.script) {
          const assistantMessage: LocalChatMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: result.script,
            createdAt: Date.now(),
          };
          
          return [...withoutLoading, assistantMessage];
        } else {
          const errorMessage: LocalChatMessage = {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: 'Sorry, I couldn\'t generate a script.',
            createdAt: Date.now(),
            isError: true,
          };
          return [...withoutLoading, errorMessage];
        }
        });
      }
      
      // Backend generateChatScript(saveAndNotify=true) already saves script + assistant
      // message. Keep local UI in sync but avoid duplicate persistence here.
      if (result.success && result.script) {
        if (isMountedRef.current) {
          setHasScript(true);
          pendingOnboardingRef.current = true;
        }
      }
    } catch (error: any) {
      // Check if this is a known transient case where backend may still succeed.
      const isConnectionLost = error?.message?.includes('Connection lost');
      if (!isConnectionLost) {
        console.error('Error generating script:', error);
      } else {
        console.log('[chat-composer] Connection lost while request in flight; attempting recovery');
      }
      
      if (isConnectionLost && requestProjectId) {
        console.log('[chat-composer] Connection lost - checking if script was generated...');
        
        // Wait a moment for any in-flight updates to settle
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        try {
          // Fetch the project to check if script exists
          const project = await convex.query(api.tasks.getProject, { id: requestProjectId as any });
          
          if (project?.script) {
            console.log('[chat-composer] Script was actually generated! Recovering...');
            
            // Remove loading message and add the script as assistant message
            if (isMountedRef.current) {
              setMessages(prev => {
                const withoutLoading = prev.filter(m => !m.isLoading);
                const assistantMessage: LocalChatMessage = {
                  id: `assistant-${Date.now()}`,
                  role: 'assistant',
                  content: project.script!,
                  createdAt: Date.now(),
                };
                return [...withoutLoading, assistantMessage];
              });
            }
            
            if (isMountedRef.current) {
              setHasScript(true);
              setIsGenerating(false);
              pendingOnboardingRef.current = true;
            }
            return; // Successfully recovered
          }
        } catch (recoveryError) {
          console.error('[chat-composer] Recovery check failed:', recoveryError);
        }
      }
      
      // If we couldn't recover, show inline error with retry
      if (isMountedRef.current) {
        setMessages(prev => {
          const withoutLoading = prev.filter(m => !m.isLoading);
          const errorMessage: LocalChatMessage = {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: 'Failed to generate script.',
            createdAt: Date.now(),
            isError: true,
          };
          return [...withoutLoading, errorMessage];
        });
      }
    } finally {
      if (isMountedRef.current) {
        setIsGenerating(false);
      }
    }
  };
  
  const handleEditScript = (messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditingScript(content);
    setShowEditor(true);
  };
  
  const handleSaveEdit = async (newScript: string) => {
    if (!editingMessageId) return;
    
    // If coming from a video, fork the project first (never modify original)
    let targetProjectId = createdProjectId;
    if (fromVideo && !hasForkedFromVideo) {
      targetProjectId = await forkProjectIfNeeded();
      if (!targetProjectId) {
        setShowEditor(false);
        setEditingMessageId(null);
        return;
      }
    }
    
    if (!targetProjectId) return;
    
    // Update local message - only mark as edited if content actually changed
    const wasActuallyEdited = newScript !== editingScript;
    setMessages(prev => prev.map(m => 
      m.id === editingMessageId 
        ? { ...m, content: newScript, isEdited: m.isEdited || wasActuallyEdited }
        : m
    ));
    
    // For forked projects or local messages, update project script directly
    // (Message IDs from original project won't exist in the forked project)
    if (hasForkedFromVideo || editingMessageId.startsWith('assistant-') || editingMessageId.startsWith('user-')) {
      const encodedScript = newScript.replace(/\?(?!\?\?)/g, '???');
      try {
        await updateProjectScript({
          id: targetProjectId as any,
          script: encodedScript,
        });
      } catch (error) {
        console.error('Failed to update script:', error);
      }
      
      // Also update the corresponding chatMessages entry if it exists.
      // The ID sync effect should normally replace synthetic IDs before the user
      // edits, but as a safety net handle the case where it hasn't run yet.
      if (!hasForkedFromVideo && existingMessages) {
        try {
          const normalize = (s: string) => s.replace(/\?\?\?/g, '?');
          const normalizedOriginal = normalize(editingScript || '');
          // Find the backend message that matches the original (pre-edit) content
          const matchingBackendMsg = [...existingMessages]
            .filter((msg: any) => msg.role === 'assistant')
            .find((msg: any) => normalize(msg.content) === normalizedOriginal);
          if (matchingBackendMsg) {
            await updateChatMessage({
              messageId: matchingBackendMsg._id,
              content: encodedScript,
            });
          }
        } catch (error) {
          console.error('Failed to update chat message (fallback):', error);
        }
      }
    } else {
      // Update in backend if it's a real message ID (not local) and not forked
      try {
        await updateChatMessage({
          messageId: editingMessageId as any,
          content: newScript.replace(/\?(?!\?\?)/g, '???'),
        });
      } catch (error) {
        console.error('Failed to update message:', error);
      }
    }
    
    setShowEditor(false);
    setEditingMessageId(null);
  };
  
  const handleCopy = async (messageId: string, content: string) => {
    try {
      await Clipboard.setStringAsync(content.replace(/\?\?\?/g, '?'));
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (error) {
      console.error('Copy error:', error);
    }
  };
  
  const handleRetryGenerate = () => {
    const args = lastGenerateArgsRef.current;
    if (!args || isGenerating) return;
    
    // Remove the error message before retrying
    setMessages(prev => prev.filter(m => !m.isError));
    
    generateScript(args.userInput, args.isNewMedia, args.newMediaCount, args.newMediaIds, true);
  };
  
  // Check if user needs voice configuration (progressive disclosure)
  // Use selectedVoiceId which covers both custom voice clones AND default voice selections
  const needsVoiceConfig = !backendUser?.selectedVoiceId && !backendUser?.elevenlabsVoiceId;
  
  // Helper to check if voice prompt should be shown (computed at call time)
  const shouldShowVoicePrompt = () => {
    if (skipVoiceCheckRef.current) return false;
    if (!needsVoiceConfig) return false;
    return ENABLE_TEST_RUN_MODE || !hasShownVoicePromptRef.current;
  };
  
  // Voice preview handlers
  const handlePlayVoice = async (messageId: string, content: string) => {
    // Check if voice configuration is needed before playing
    if (shouldShowVoicePrompt()) {
      setPendingVoiceAction({ type: 'play', messageId, content });
      setShowVoiceConfigModal(true);
      return;
    }
    
    // If already playing this message, stop it
    if (playingMessageId === messageId) {
      if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      setPlayingMessageId(null);
      return;
    }
    
    // Stop any currently playing audio
    if (soundRef.current) {
      await soundRef.current.stopAsync();
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    setPlayingMessageId(null);
    
    // Set audio mode to play through speaker (important for iOS silent mode)
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
    } catch (error) {
      console.log('Failed to set audio mode:', error);
    }
    
    // Check if we have cached audio for this message
    const cachedUrl = audioCache.current.get(messageId);
    
    if (cachedUrl) {
      // Use cached audio - instant playback!
      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri: cachedUrl },
          { shouldPlay: true }
          // Speed is NOT applied here - preview plays at natural speed
          // Speed setting is for final video only (FFmpeg handles it better)
        );
        soundRef.current = sound;
        setPlayingMessageId(messageId);
        
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingMessageId(null);
            sound.unloadAsync();
            soundRef.current = null;
          }
        });
        return;
      } catch (error) {
        console.log('Cached audio failed, regenerating:', error);
        audioCache.current.delete(messageId); // Clear invalid cache
      }
    }
    
    // Generate new audio (ElevenLabs always generates at 1.2x speed)
    setGeneratingVoiceMessageId(messageId);
    
    try {
      const result = await generateScriptPreviewAudio({
        messageId: messageId, // Can be local ID or Convex ID
        script: content,
        userId: userId || undefined, // Pass userId to use their selected voice
      });
      
      if (result.success && result.audioUrl) {
        // Cache the audio URL for future plays
        audioCache.current.set(messageId, result.audioUrl);
        
        // Play the audio at natural speed
        // Speed setting is for final video only (FFmpeg handles it better)
        const { sound } = await Audio.Sound.createAsync(
          { uri: result.audioUrl },
          { shouldPlay: true }
        );
        soundRef.current = sound;
        setPlayingMessageId(messageId);
        
        // Handle playback finished
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlayingMessageId(null);
            sound.unloadAsync();
            soundRef.current = null;
          }
        });
      } else {
        Alert.alert('Error', result.error || 'Failed to generate voice preview');
      }
    } catch (error) {
      console.error('Voice preview error:', error);
      Alert.alert('Error', 'Failed to generate voice preview');
    } finally {
      setGeneratingVoiceMessageId(null);
    }
  };
  
  // Speed change handler - sets speed for final video (FFmpeg)
  // Preview always plays at natural speed for best quality
  const handleChangeSpeed = () => {
    const applySpeed = async (newSpeed: number) => {
      setVoiceSpeed(newSpeed);
      
      // Save to backend for FFmpeg to use in final video
      if (createdProjectId) {
        try {
          await updateProjectVoiceSpeed({
            id: createdProjectId as any,
            voiceSpeed: newSpeed,
          });
        } catch (error) {
          console.error('Failed to save voice speed:', error);
        }
      }
    };
    
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...VOICE_SPEED_OPTIONS.map(o => o.label), 'Cancel'],
          cancelButtonIndex: VOICE_SPEED_OPTIONS.length,
          title: 'Voiceover Speed (Final Video)',
          message: 'Preview plays at normal speed',
        },
        async (buttonIndex) => {
          if (buttonIndex < VOICE_SPEED_OPTIONS.length) {
            await applySpeed(VOICE_SPEED_OPTIONS[buttonIndex].value);
          }
        }
      );
    } else {
      // Android: Use simple Alert with options
      Alert.alert(
        'Voiceover Speed',
        'Select speed for the final video (preview plays at normal speed)',
        VOICE_SPEED_OPTIONS.map(option => ({
          text: option.label,
          onPress: () => applySpeed(option.value),
        }))
      );
    }
  };
  
  // Keep order toggle handler
  const handleToggleKeepOrder = async () => {
    const newValue = !keepOrder;
    setKeepOrder(newValue);
    
    // Save to backend if we have a project
    if (createdProjectId) {
      try {
        await updateProjectKeepOrder({
          id: createdProjectId as any,
          keepOrder: newValue,
        });
      } catch (error) {
        console.error('Failed to save keep order:', error);
      }
    }
  };
  
  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, []);
  
  // Handle regenerate when coming from video without modifications
  const handleRegenerateFromVideo = async () => {
    if (!originalVideoProjectId || isRegenerating) return;

    setIsRegenerating(true);
    try {
      console.log('[chat-composer] Regenerating project editing for:', originalVideoProjectId);
      
      const result = await regenerateProjectEditing({
        sourceProjectId: originalVideoProjectId as any,
      });

      if (result.success && result.newProjectId) {
        console.log('[chat-composer] New project created:', result.newProjectId);
        
      // Get the latest script from messages
      const latestScript = messages
        .filter(m => m.role === 'assistant' && !m.isLoading && !m.isError)
        .sort((a, b) => b.createdAt - a.createdAt)[0]?.content;
      
      addVideo({
          id: result.newProjectId,
          uri: '',
          prompt: existingProject?.prompt || 'Regenerated video',
          script: latestScript?.replace(/\?\?\?/g, '?'),
          createdAt: Date.now(),
          status: 'processing',
          projectId: result.newProjectId,
          thumbnailUrl: existingProject?.thumbnailUrl || mediaUris[0]?.uri,
        });

        Alert.alert(
          '🎬 Generation Started!',
          'Your video is being created! Feel free to close the app — we\'ll send you a notification when it\'s ready.',
          [{
            text: 'Got it!',
            style: 'default',
            onPress: () => {
              router.replace('/(tabs)');
            }
          }]
        );
      } else {
        throw new Error('Failed to create regenerated project');
      }
    } catch (error) {
      console.error('[chat-composer] Regenerate error:', error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('FREE_TIER_LIMIT_REACHED') || errorMessage.includes('NO_CREDITS_AVAILABLE')) {
        router.push('/paywall');
      } else {
        Alert.alert('Error', 'Failed to regenerate video. Please try again.');
      }
    } finally {
      setIsRegenerating(false);
    }
  };
  
  const handleApproveAndGenerate = async () => {
    if (isSubmitting || isMessageTooLong) return;
    
    // Check if voice configuration is needed before submitting
    if (shouldShowVoicePrompt()) {
      setPendingVoiceAction({ type: 'submit' });
      setShowVoiceConfigModal(true);
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      // If coming from a video, fork the project first (never modify original)
      let targetProjectId = createdProjectId;
      if (fromVideo && !hasForkedFromVideo) {
        targetProjectId = await forkProjectIfNeeded();
        if (!targetProjectId) {
          setIsSubmitting(false);
          return;
        }
      }
      
      if (!targetProjectId) {
        Alert.alert('Error', 'No project to generate');
        setIsSubmitting(false);
        return;
      }
      
      // Get the latest script from messages
      const latestScript = messages
        .filter(m => m.role === 'assistant' && !m.isLoading && !m.isError)
        .sort((a, b) => b.createdAt - a.createdAt)[0]?.content;
      
      if (!latestScript) {
        Alert.alert('Error', 'No script to approve');
        setIsSubmitting(false);
        return;
      }
      
      // Save the latest script to the project BEFORE submitting
      // This ensures the script is persisted in the DB even if it was only edited locally
      // (e.g. after forking from history, the forked project may not have the edited script yet)
      await updateProjectScript({
        id: targetProjectId as any,
        script: latestScript.replace(/\?(?!\?\?)/g, '???'),
      });
      
      // Mark project as submitted FIRST (changes backend status to 'processing')
      // This must happen before addVideo to prevent a race condition:
      // If addVideo runs first, the polling service sees local status 'processing' but backend still 'failed',
      // which triggers a false failure notification
      await markProjectSubmitted({ id: targetProjectId as any });
      
      // Now add video to context with processing status (polling will see consistent state)
      addVideo({
        id: targetProjectId,
        uri: '',
        prompt: inputText || 'Chat-generated video',
        script: latestScript.replace(/\?\?\?/g, '?'),
        createdAt: Date.now(),
        status: 'processing',
        projectId: targetProjectId,
        thumbnailUrl: mediaUris[0]?.uri,
      });
      
      Alert.alert(
        '🎬 Generation Started!',
        'Your video is being created! Feel free to close the app — we\'ll send you a notification when it\'s ready.',
        [{
          text: 'Got it!',
          style: 'default',
          onPress: () => {
            router.replace('/(tabs)');
          }
        }]
      );
    } catch (error) {
      console.error('Error approving:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('FREE_TIER_LIMIT_REACHED')) {
        router.push('/paywall');
      } else {
        Alert.alert('Error', 'Failed to start generation. Please try again.');
      }
      setIsSubmitting(false);
    }
  };
  
  // Voice config modal handlers (progressive disclosure)
  const handleVoiceConfigComplete = () => {
    setShowVoiceConfigModal(false);
    hasShownVoicePromptRef.current = true;
    
    // Clear audio cache so new audio is generated with the new voice
    audioCache.current.clear();
    
    // Skip voice check for the next action (voice was just configured)
    skipVoiceCheckRef.current = true;
    
    // Execute the pending action after voice is configured
    const action = pendingVoiceAction;
    setPendingVoiceAction(null);
    
    // Use setTimeout to ensure modal closes before re-triggering action
    setTimeout(() => {
      if (action?.type === 'play' && action.messageId && action.content) {
        // Re-trigger play voice (now that voice is configured)
        handlePlayVoice(action.messageId, action.content);
      } else if (action?.type === 'submit') {
        // Re-trigger approve and generate
        handleApproveAndGenerate();
      }
      // Reset skip flag after action is triggered
      skipVoiceCheckRef.current = false;
    }, 200);
  };
  
  const handleVoiceConfigSkip = () => {
    setShowVoiceConfigModal(false);
    hasShownVoicePromptRef.current = true;
    
    // Skip voice check for the next action (user chose to skip)
    skipVoiceCheckRef.current = true;
    
    // Execute the pending action with default voice
    const action = pendingVoiceAction;
    setPendingVoiceAction(null);
    
    // Use setTimeout to ensure modal closes before re-triggering action
    setTimeout(() => {
      if (action?.type === 'play' && action.messageId && action.content) {
        // Re-trigger play voice (will use default voice)
        handlePlayVoice(action.messageId, action.content);
      } else if (action?.type === 'submit') {
        // Re-trigger approve and generate (will use default voice)
        handleApproveAndGenerate();
      }
      // Reset skip flag after action is triggered
      skipVoiceCheckRef.current = false;
    }, 200);
  };
  
  const handleVoiceConfigClose = () => {
    setShowVoiceConfigModal(false);
    setPendingVoiceAction(null);
    // Don't mark as shown - user explicitly closed without deciding
  };
  
  // Chat onboarding tips: measure target elements and show overlay
  const measureSpotlightRects = useCallback(() => {
    const bubbleRef = onboardingUsesLatest ? latestScriptBubbleRef : scriptBubbleRef;
    const refs = [bubbleRef, threeDotsRef, composerRef, generateButtonRef, keepClipsOrderRef];
    const measured: (SpotlightRect | null)[] = [];
    let remaining = refs.length;
    
    refs.forEach((ref, index) => {
      if (ref.current) {
        ref.current.measureInWindow((x, y, width, height) => {
          measured[index] = { x, y, width, height };
          remaining--;
          if (remaining === 0) {
            setSpotlightRects([...measured]);
          }
        });
      } else {
        measured[index] = null;
        remaining--;
        if (remaining === 0) {
          setSpotlightRects([...measured]);
        }
      }
    });
  }, [onboardingUsesLatest]);

  const triggerChatOnboarding = useCallback(() => {
    const shouldShowTips = ENABLE_TEST_RUN_MODE || (!backendUser?.chatTipsCompleted && !chatTipsCompletedLocally);
    if (shouldShowTips) {
      // Dismiss keyboard before measuring rects so positions are accurate
      Keyboard.dismiss();
      // Scroll to end to ensure Generate/Keep Clips Order buttons are visible for measurement
      scrollViewRef.current?.scrollToEnd({ animated: false });
      // Wait for the script bubble to render, then measure and show immediately
      InteractionManager.runAfterInteractions(() => {
        requestAnimationFrame(() => {
          measureSpotlightRects();
          setShowChatOnboarding(true);
        });
      });
    }
  }, [backendUser, chatTipsCompletedLocally, measureSpotlightRects]);
  
  // Trigger onboarding only after the script message is committed to the render,
  // so the user never sees loading phrases and onboarding at the same time.
  useEffect(() => {
    if (!pendingOnboardingRef.current) return;
    const hasRenderedScript = messages.some(m => m.role === 'assistant' && !m.isLoading && !m.isError);
    if (hasRenderedScript && hasScript) {
      pendingOnboardingRef.current = false;
      triggerChatOnboarding();
    }
  }, [messages, hasScript, triggerChatOnboarding]);
  
  // Force-show onboarding from menu (always highlights latest message)
  const forceShowChatOnboarding = useCallback(() => {
    setOnboardingUsesLatest(true);
    Keyboard.dismiss();
    // Scroll to end to ensure Generate/Keep Clips Order buttons are visible for measurement
    scrollViewRef.current?.scrollToEnd({ animated: false });
    InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => {
        // Measure using latest ref (onboardingUsesLatest is now true)
        const bubbleRef = latestScriptBubbleRef;
        const refs = [bubbleRef, threeDotsRef, composerRef, generateButtonRef, keepClipsOrderRef];
        const measured: (SpotlightRect | null)[] = [];
        let remaining = refs.length;
        
        refs.forEach((ref, index) => {
          if (ref.current) {
            ref.current.measureInWindow((x, y, width, height) => {
              measured[index] = { x, y, width, height };
              remaining--;
              if (remaining === 0) {
                setSpotlightRects([...measured]);
                setShowChatOnboarding(true);
              }
            });
          } else {
            measured[index] = null;
            remaining--;
            if (remaining === 0) {
              setSpotlightRects([...measured]);
              setShowChatOnboarding(true);
            }
          }
        });
      });
    });
  }, []);

  const handleChatOnboardingComplete = useCallback(async () => {
    setShowChatOnboarding(false);
    setOnboardingUsesLatest(false);
    if (!ENABLE_TEST_RUN_MODE) {
      // Save locally first (guaranteed to persist)
      setChatTipsCompletedLocally(true);
      AsyncStorage.setItem('@reelfull_chatTipsCompleted', 'true').catch(() => {});
      // Also save to backend (best-effort)
      if (userId) {
        try {
          await completeChatTips({ userId });
        } catch (e) {
          console.error('Failed to save chat tips completion:', e);
        }
      }
    }
  }, [userId, completeChatTips]);
  
  const saveDraft = async (): Promise<boolean> => {
    if (createdProjectId || !userId) return false;

    const uploaded = mediaUrisRef.current.filter(m => m.storageId);
    if (uploaded.length === 0) return false;

    try {
      const fileMetadata = uploaded.map(m => ({
        storageId: m.storageId,
        filename: `${m.type}_${m.id}.${m.type === 'video' ? 'mp4' : 'jpg'}`,
        contentType: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
        size: 0,
      }));

      const draftId = await createChatProject({
        userId,
        files: uploaded.map(m => m.storageId),
        fileMetadata,
        thumbnail: uploaded[0]?.storageId,
      });
      console.log('[chat-composer] Draft saved on exit:', draftId);

      const currentInputText = inputTextRef.current;
      if (currentInputText.trim() && draftId) {
        try {
          await updateChatProjectPrompt({
            projectId: draftId,
            prompt: currentInputText.trim(),
          });
        } catch (promptError) {
          console.error('[chat-composer] Failed to save draft prompt:', promptError);
        }
      }
      return true;
    } catch (error) {
      console.error('[chat-composer] Failed to save draft on exit:', error);
      return false;
    }
  };

  const handleClose = async () => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;

    if (isGenerating) {
      Alert.alert(
        'Script is still generating',
        'You can safely leave this screen. We will keep generating in the background and notify you when it is ready.',
        [
          { text: 'Stay', style: 'cancel', onPress: () => { isClosingRef.current = false; } },
          {
            text: 'Continue in background',
            onPress: () => router.back(),
          },
        ]
      );
      return;
    }

    // Check if this is an existing draft that was opened (projectId param was provided)
    const isExistingDraft = !!projectId && !fromVideo;
    
    // If opening an existing draft without changes, exit silently
    if (isExistingDraft && !hasForkedFromVideo) {
      router.back();
      return;
    }
    
    // If we came from a video and forked (made changes), show the new draft notice
    if (fromVideo && hasForkedFromVideo) {
      Alert.alert(
        'Draft Created',
        'Your changes have been saved as a new draft. The original video remains unchanged.',
        [
          { 
            text: 'OK', 
            onPress: () => router.back() 
          }
        ]
      );
      return;
    }
    
    // If we came from a video but didn't make any changes, just go back
    if (fromVideo && !hasForkedFromVideo) {
      router.back();
      return;
    }
    
    const hasContent = mediaUris.length > 0 || messages.length > 0 || inputText.trim();
    const isNewlyCreatedProject = createdProjectId && !projectId;
    const isMediaUploading = mediaUris.some(
      m => m.uploadStatus === 'uploading' || m.uploadStatus === 'pending'
    );

    if (!hasContent && !isNewlyCreatedProject) {
      router.back();
      return;
    }

    if (isMediaUploading) {
      const uploadedSoFar = mediaUris.filter(m => m.storageId);
      Alert.alert(
        'Media still uploading',
        uploadedSoFar.length > 0
          ? 'Some media is still uploading. Already uploaded media will be saved as a draft.'
          : 'Media is still uploading and will be lost if you leave now.',
        [
          { text: 'Stay', style: 'cancel', onPress: () => { isClosingRef.current = false; } },
          {
            text: 'Leave',
            style: 'destructive',
            onPress: async () => {
              const saved = await saveDraft();
              if (saved || isNewlyCreatedProject) {
                Alert.alert(
                  'Draft Saved',
                  'Your draft has been saved in the Drafts tab. You can continue later.',
                  [{ text: 'OK', onPress: () => router.back() }]
                );
              } else {
                router.back();
              }
            },
          },
        ]
      );
      return;
    }

    const uploadedMedia = mediaUris.filter(m => m.storageId);
    const canSaveDraft = !createdProjectId && uploadedMedia.length > 0;

    let draftSaved = false;
    if (canSaveDraft) {
      draftSaved = await saveDraft();
    }

    if (draftSaved || isNewlyCreatedProject) {
      Alert.alert(
        'Draft Saved',
        'Your draft has been saved in the Drafts tab. You can continue later.',
        [
          {
            text: 'OK',
            onPress: () => router.back(),
          },
        ]
      );
    } else {
      router.back();
    }
  };
  
  const isLimitReached = userMessageCount >= MAX_USER_MESSAGES;
  const isMessageTooLong = inputText.length > MAX_MESSAGE_LENGTH;
  const selectedMedia = mediaUris.filter(m => !sentMediaIds.has(m.id));
  const uploadedMedia = mediaUris.filter(m => m.storageId);
  const pendingMedia = mediaUris.filter(m => m.storageId && !sentMediaIds.has(m.id));
  const hasPendingMedia = pendingMedia.length > 0;
  const hasNewInput = inputText.trim().length > 0;
  const allSelectedMediaReady = selectedMedia.every(
    (media) => media.uploadStatus === 'uploaded'
  );
  
  // Before first message: can send if we have media (even without text)
  // After first message: can send if we have new text input OR new pending media
  const canSend = messages.length === 0 
    ? (uploadedMedia.length > 0 && allSelectedMediaReady && !isGenerating && !isMessageTooLong)  // First message: need media
    : ((hasNewInput || hasPendingMedia) && allSelectedMediaReady && !isGenerating && !isLimitReached && !isMessageTooLong);
  
  // Determine if send button should act as "Regenerate" 
  // This happens when coming from video without any modifications
  const isRegenerateMode = fromVideo && !hasForkedFromVideo && hasScript && !hasNewInput && !hasPendingMedia && !isGenerating && !isRegenerating;
  
  // Determine if send button should act as "Approve & Generate"
  // This happens when we have a script, no new text input, no pending media, and not generating/submitting (but not regenerate mode)
  const isApproveMode = !isRegenerateMode && hasScript && !hasNewInput && !hasPendingMedia && !isGenerating && !isSubmitting;
  
  // Generate header button is active when we can approve OR regenerate (history chats + drafts)
  const isGenerateActive = (isApproveMode || isRegenerateMode) && !isMessageTooLong;
  const isGenerateBusy = isSubmitting || isRegenerating;
  
  // Find latest assistant message for edit functionality
  const latestAssistantMessageId = messages
    .filter(m => m.role === 'assistant' && !m.isLoading && !m.isError)
    .sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
  
  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <TouchableOpacity style={styles.headerButton} onPress={handleClose}>
          <ArrowLeft size={24} color={Colors.ink} />
        </TouchableOpacity>
        
        <TouchableOpacity 
          ref={threeDotsRef}
          style={styles.threeDotsButton}
          onPress={() => setShowMenu(prev => !prev)}
        >
          <MoreHorizontal size={20} color={Colors.ink} />
        </TouchableOpacity>
      </View>
      
      {/* Three-dots popover menu */}
      {showMenu && (
        <>
          <Pressable style={styles.menuOverlay} onPress={() => setShowMenu(false)} />
          <View style={[styles.menuContainer, { top: insets.top + 60 }]}>
            {/* Voice Clone */}
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowMenu(false);
                setPendingVoiceAction(null);
                setShowVoiceConfigModal(true);
              }}
              activeOpacity={0.6}
            >
              <Mic size={18} color={Colors.ink} />
              <Text style={styles.menuItemText}>Voice Clone</Text>
            </TouchableOpacity>
            
            <View style={styles.menuDivider} />
            
            {/* Voiceover Speed */}
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowMenu(false);
                handleChangeSpeed();
              }}
              activeOpacity={0.6}
            >
              <Gauge size={18} color={Colors.ink} />
              <View style={styles.menuItemTextContainer}>
                <Text style={styles.menuItemText}>Voiceover Speed</Text>
                <Text style={styles.menuItemSecondary}>
                  {VOICE_SPEED_OPTIONS.find(o => o.value === voiceSpeed)?.label || 'Normal'}
                </Text>
              </View>
            </TouchableOpacity>
            
            {hasScript && (
              <>
                <View style={styles.menuDivider} />
                
                {/* Show Tips */}
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    setShowMenu(false);
                    forceShowChatOnboarding();
                  }}
                  activeOpacity={0.6}
                >
                  <Info size={18} color={Colors.ink} />
                  <Text style={styles.menuItemText}>Show Tips</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </>
      )}
      
      {/* Chat Area */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.chatArea}
          contentContainerStyle={styles.chatContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onLayout={() => {
            if (keyboardVisibleRef.current) {
              scrollViewRef.current?.scrollToEnd({ animated: true });
            }
          }}
        >
          {/* Info banner when viewing chat from a completed video */}
          {fromVideo && !hasForkedFromVideo && (
            <View style={styles.infoBanner}>
              <Info size={16} color={Colors.ember} />
              <Text style={styles.infoBannerText}>
                Any changes will create a new draft. Original video stays unchanged.
              </Text>
            </View>
          )}
          
          {/* Welcome message - hidden when processing media or thumbnails visible */}
          {messages.length === 0 && mediaUris.length === 0 && !isProcessingMedia && (
            <View style={styles.welcomeContainer}>
              <Text style={styles.welcomeTitle}>Hello, {user?.name || 'there'}!</Text>
              <Text style={styles.welcomeSubtitle}>
                upload media for a video you would like to create
              </Text>
              <Text style={styles.welcomeNote}>
                max {MAX_MEDIA_FILES} media files
              </Text>
            </View>
          )}
          
          {/* Chat messages */}
          {(() => {
            const firstAssistantIndex = messages.findIndex(m => m.role === 'assistant' && !m.isLoading);
            const isLatestAssistant = (id: string) => id === latestAssistantMessageId;
            return messages.map((message, index) => {
              const isFirstAssistant = index === firstAssistantIndex;
              const isLatest = isLatestAssistant(message.id);
              
              const getMeasureRef = () => {
                if (isFirstAssistant && isLatest) {
                  return (node: View | null) => {
                    (scriptBubbleRef as React.MutableRefObject<View | null>).current = node;
                    (latestScriptBubbleRef as React.MutableRefObject<View | null>).current = node;
                  };
                }
                if (isFirstAssistant) return scriptBubbleRef;
                if (isLatest) return latestScriptBubbleRef;
                return undefined;
              };

              return (
                <ChatBubble
                  key={message.id}
                  message={message}
                  onEditTap={() => handleEditScript(message.id, message.content)}
                  onCopy={() => handleCopy(message.id, message.content)}
                  isLatestAssistant={isLatest}
                  isCopied={copiedMessageId === message.id}
                  onPlayVoice={() => handlePlayVoice(message.id, message.content)}
                  isPlayingVoice={playingMessageId === message.id}
                  isGeneratingVoice={generatingVoiceMessageId === message.id}
                  onRetry={message.isError ? handleRetryGenerate : undefined}
                  onMediaPress={(items, index) => setPreviewMedia({ items, index })}
                  measureRef={getMeasureRef()}
                />
              );
            });
          })()}
          
          {/* Generate & Keep Clips Order buttons */}
          {hasScript && !isGenerating && (
            <View style={styles.scriptActionButtons}>
              <TouchableOpacity
                ref={generateButtonRef}
                style={[styles.generateButton, !isGenerateActive && styles.generateButtonDisabled]}
                onPress={isRegenerateMode ? handleRegenerateFromVideo : handleApproveAndGenerate}
                disabled={!isGenerateActive || isGenerateBusy}
                activeOpacity={0.8}
              >
                {isGenerateBusy ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Text style={[styles.generateButtonText, !isGenerateActive && styles.generateButtonTextDisabled]}>Generate</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                ref={keepClipsOrderRef}
                style={[styles.keepClipsOrderButton, keepOrder && styles.keepClipsOrderButtonOn]}
                onPress={() => handleToggleKeepOrder()}
                activeOpacity={0.8}
              >
                <Text style={[styles.keepClipsOrderButtonText, keepOrder && styles.keepClipsOrderButtonTextOn]}>Keep clips order</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Message limit warning */}
          {isLimitReached && (
            <View style={styles.limitWarning}>
              <Text style={styles.limitWarningText}>
                Message limit reached. Edit the script directly or approve to generate.
              </Text>
            </View>
          )}
        </ScrollView>
        
        {/* Unified Composer */}
        <View style={[styles.composerContainer, { paddingBottom: keyboardVisible ? 10 : insets.bottom }]}>
          {/* Add media button - outside card */}
          <TouchableOpacity 
            style={styles.addMediaButton}
            onPress={pickMedia}
            disabled={isGenerating}
          >
            <Plus size={24} color={Colors.ink} />
          </TouchableOpacity>
          
          {/* Unified card containing media + input */}
          <View ref={composerRef} collapsable={false} style={[styles.composerCard, isMessageTooLong && styles.composerCardError]}>
            {/* Media thumbnails inside card - show pending media (not yet sent in a message) */}
            {(() => {
              const pendingMedia = mediaUris.filter(m => !sentMediaIds.has(m.id));
              return pendingMedia.length > 0 && (
                <ScrollView 
                  horizontal 
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.composerMediaScroll}
                  keyboardShouldPersistTaps="handled"
                >
                  {pendingMedia.map((item, itemIndex) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.composerMediaItem}
                      activeOpacity={0.8}
                      onPress={() => {
                        const allItems = pendingMedia.map(m => ({ uri: m.uri, type: m.type }));
                        setPreviewMedia({ items: allItems, index: itemIndex });
                      }}
                    >
                      {/* Actual thumbnail */}
                      {item.type === 'video' ? (
                        <VideoThumbnail uri={item.uri} style={styles.composerMediaImage} cacheId={item.storageId} />
                      ) : (
                        <Image
                          source={{ uri: item.uri }}
                          style={styles.composerMediaImage}
                          contentFit="cover"
                          cachePolicy="disk"
                          recyclingKey={item.id}
                          transition={150}
                        />
                      )}
                      
                      {/* Upload status overlay */}
                      {item.uploadStatus === 'uploading' && (
                        <View style={styles.composerMediaOverlay}>
                          <ActivityIndicator size="small" color={Colors.white} />
                        </View>
                      )}
                      
                      {/* Remove button */}
                      <TouchableOpacity
                        style={styles.composerMediaRemove}
                        onPress={() => removeMedia(item.id)}
                        activeOpacity={0.7}
                      >
                        <X size={16} color={Colors.white} strokeWidth={2} />
                      </TouchableOpacity>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              );
            })()}
            
            {/* Text input inside card */}
            <TextInput
              ref={inputRef}
              style={[styles.composerTextInput, isMessageTooLong && styles.composerTextInputError]}
              placeholder={hasScript ? "Type to edit" : "Share your story, or leave it blank..."}
              placeholderTextColor={Colors.gray400}
              value={inputText}
              onChangeText={setInputText}
              multiline
              editable={!isLimitReached && !isGenerating}
            />
            {inputText.length > 0 && (
              <Text style={[styles.charCounter, isMessageTooLong && styles.charCounterError]}>
                {inputText.length}/{MAX_MESSAGE_LENGTH}
              </Text>
            )}
          </View>
          
          {/* Send button - only for chat messages */}
          <TouchableOpacity
            style={[
              styles.sendButton, 
              canSend && styles.sendButtonActive,
            ]}
            onPress={handleSend}
            disabled={!canSend}
          >
            <Send size={20} color={canSend ? Colors.white : Colors.grayLight} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
      
      {/* Script Editor Modal */}
      <ScriptEditor
        visible={showEditor}
        script={editingScript}
        onSave={handleSaveEdit}
        onClose={() => setShowEditor(false)}
      />
      
      {/* Full-screen loading overlay while processing media */}
      {isProcessingMedia && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color={Colors.white} />
          <Text style={styles.processingOverlayText}>Loading...</Text>
        </View>
      )}
      
      {/* Voice configuration modal (progressive disclosure) */}
      <VoiceConfigModal
        visible={showVoiceConfigModal}
        onComplete={handleVoiceConfigComplete}
        onSkip={handleVoiceConfigSkip}
        onClose={handleVoiceConfigClose}
        showSkip={!!pendingVoiceAction}
      />
      
      {/* Chat onboarding tips overlay */}
      <ChatOnboarding
        visible={showChatOnboarding}
        onComplete={handleChatOnboardingComplete}
        spotlightRects={spotlightRects}
        safeAreaTop={insets.top}
      />
      
      {/* Media preview modal */}
      <MediaPreviewModal
        visible={!!previewMedia}
        items={previewMedia?.items ?? []}
        initialIndex={previewMedia?.index ?? 0}
        onClose={() => setPreviewMedia(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  generateButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.ember,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  generateButtonDisabled: {
    backgroundColor: Colors.creamDark,
  },
  generateButtonText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Nunito_700Bold',
  },
  generateButtonTextDisabled: {
    color: Colors.grayLight,
  },
  scriptActionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
    marginLeft: 4,
  },
  keepClipsOrderButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F7EBE7',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  keepClipsOrderButtonOn: {
    backgroundColor: Colors.ember,
  },
  keepClipsOrderButtonText: {
    color: Colors.ember,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Nunito_700Bold',
  },
  keepClipsOrderButtonTextOn: {
    color: Colors.white,
  },
  threeDotsButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
  },
  menuContainer: {
    position: 'absolute',
    right: 16,
    width: 270,
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingVertical: 6,
    zIndex: 51,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  menuItemTextContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuItemText: {
    fontSize: 15,
    fontFamily: Fonts.medium,
    color: Colors.ink,
  },
  menuItemSecondary: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.creamDark,
    marginHorizontal: 16,
  },
  keyboardView: {
    flex: 1,
  },
  chatArea: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 8,
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    gap: 8,
  },
  infoBannerText: {
    flex: 1,
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.ember,
    lineHeight: 18,
  },
  welcomeContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  welcomeTitle: {
    fontSize: 28,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    marginBottom: 8,
  },
  welcomeSubtitle: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  welcomeNote: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: 4,
  },
  messageBubbleContainer: {
    marginBottom: 12,
    alignItems: 'flex-start',
  },
  messageBubbleContainerUser: {
    alignItems: 'flex-end',
  },
  messageMediaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 8,
    maxWidth: '85%',
  },
  messageMediaGridUser: {
    alignSelf: 'flex-end',
    justifyContent: 'flex-end',
  },
  messageMediaItem: {
    width: 75,
    height: 75,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: Colors.creamDark,
  },
  messageMediaImage: {
    width: '100%',
    height: '100%',
  },
  messageBubble: {
    maxWidth: '85%',
    padding: 12,
    borderRadius: 16,
  },
  messageBubbleUser: {
    backgroundColor: Colors.ember,
    borderBottomRightRadius: 4,
  },
  messageBubbleAssistant: {
    backgroundColor: Colors.white,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: Colors.creamDark,
  },
  messageBubbleLoading: {
    minWidth: 0,
  },
  messageText: {
    fontSize: 15,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    lineHeight: 22,
  },
  messageTextUser: {
    color: Colors.white,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: Fonts.medium,
    color: Colors.textSecondary,
  },
  scriptLoadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  scriptLoadingText: {
    fontSize: 14,
    fontFamily: Fonts.italic,
    color: Colors.ember,
    flexShrink: 1,
    lineHeight: 20,
  },
  scriptLoadingDots: {
    minWidth: 14,
  },
  editedLabel: {
    fontSize: 11,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginTop: 4,
    fontStyle: 'italic',
  },
  messageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    paddingLeft: 4,
    gap: 2,
  },
  messageActionsUser: {
    alignSelf: 'flex-end',
    paddingLeft: 0,
    paddingRight: 0,
  },
  copyButton: {
    padding: 4,
  },
  actionButton: {
    padding: 6,
    borderRadius: 4,
  },
  retryActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 6,
    borderRadius: 8,
  },
  retryActionText: {
    fontSize: 13,
    fontFamily: Fonts.medium,
    color: Colors.ember,
  },
  actionButtonActive: {
    backgroundColor: 'rgba(243, 106, 63, 0.12)',
  },
  copiedFeedback: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 4,
  },
  copiedText: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.ember,
  },
  scriptHint: {
    fontSize: 11,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginLeft: 2,
  },
  tapToEditIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 4,
    marginTop: 8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
    borderRadius: 10,
  },
  tapToEditText: {
    fontSize: 11,
    fontFamily: Fonts.medium,
    color: Colors.ember,
  },
  limitWarning: {
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  limitWarningText: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.ember,
    textAlign: 'center',
  },
  // Unified Composer styles
  composerContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 15,
    backgroundColor: Colors.cream,
    gap: 8,
  },
  composerCard: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.creamDark,
  },
  composerMediaScroll: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  composerMediaItem: {
    width: 120,
    height: 120,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: Colors.creamDark,
  },
  composerMediaImage: {
    width: '100%',
    height: '100%',
  },
  composerMediaOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  composerMediaRemove: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  composerTextInput: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    maxHeight: 100,
  },
  composerTextInputError: {
    color: Colors.error,
  },
  composerCardError: {
    borderColor: Colors.error,
  },
  charCounter: {
    paddingHorizontal: 16,
    paddingBottom: 6,
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.gray400,
    textAlign: 'right',
  },
  charCounterError: {
    color: Colors.error,
  },
  composerMediaPlaceholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.creamDark,
    zIndex: 1,
  },
  composerMediaImageHidden: {
    opacity: 0,
  },
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  processingOverlayText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.white,
    marginTop: 12,
  },
  addMediaButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  sendButtonActive: {
    backgroundColor: Colors.ember,
  },
  editorOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.cream,
    zIndex: 100,
  },
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.creamDark,
  },
  editorCloseButton: {
    padding: 8,
  },
  editorTitle: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.ink,
  },
  editorSaveButton: {
    padding: 8,
  },
  editorInput: {
    flex: 1,
    padding: 16,
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    lineHeight: 24,
  },
});
