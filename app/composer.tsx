import { Redirect as RedirectLegacy , Redirect , useRouter, useLocalSearchParams } from 'expo-router';
import { Camera, X, ArrowRight } from 'lucide-react-native';
import { useState, useEffect, useRef } from 'react';
import {
  Alert,
  Image,
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
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { VideoExportPreset } from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useMutation, useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { uploadMediaFiles } from '@/lib/api-helpers';
import { Fonts } from '@/constants/typography';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';

function ComposerRedirectLegacy() {
  return <RedirectLegacy href="/chat-composer" />;
}

export default function ComposerRedirect() {
  return <Redirect href="/chat-composer" />;
}

// Step types for the composer flow
type ComposerStep = 'media_selection' | 'description';

function VideoThumbnail({ uri, style }: { uri: string; style: any }) {
  const player = useVideoPlayer(uri, (player) => {
    player.muted = true;
  });
  
  return (
    <VideoView
      player={player}
      style={style}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

// Overlay loader component (fully opaque to hide content behind)
function OverlayLoader({ 
  title, 
  subtitle, 
  showWarning = false,
  progress,
  preparing = false,
}: { 
  title: string; 
  subtitle?: string;
  showWarning?: boolean;
  progress?: { current: number; total: number };
  preparing?: boolean; // Show 0% while preparing (iCloud download)
}) {
  const percent = progress ? Math.round((progress.current / progress.total) * 100) : 0;
  
  return (
    <View style={styles.overlayLoader}>
      <View style={styles.loaderContent}>
        <ActivityIndicator size="large" color={Colors.ember} />
        <Text style={styles.loaderTitle}>{title}</Text>
        {preparing ? (
          <Text style={styles.loaderProgress}>Preparing... (0%)</Text>
        ) : progress ? (
          <Text style={styles.loaderProgress}>
            {progress.current}/{progress.total} files ({percent}%)
          </Text>
        ) : null}
        {subtitle && <Text style={styles.loaderSubtitle}>{subtitle}</Text>}
        {showWarning && (
          <Text style={styles.loaderWarning}>Please don't leave the app</Text>
        )}
      </View>
    </View>
  );
}

function ComposerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ projectId?: string }>();
  const projectId = params.projectId as any;
  const insets = useSafeAreaInsets();
  const { user, userId, syncUserFromBackend } = useApp();
  
  // Step-based state
  const [step, setStep] = useState<ComposerStep>('media_selection');
  const [prompt, setPrompt] = useState('');
  const [mediaUris, setMediaUris] = useState<{ 
    uri: string; 
    type: 'video' | 'image'; 
    id: string; 
    assetId?: string;
    storageId?: any; // Set after upload
    uploadedUrl?: string; // URL from Convex storage
  }[]>([]);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [isPickingMedia, setIsPickingMedia] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [showUploadOverlay, setShowUploadOverlay] = useState(false);
  const [showGeneratingOverlay, setShowGeneratingOverlay] = useState(false);
  // Track project ID created during this session (for when user goes back from script-review)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  
  // Track if picker was auto-opened
  const hasAutoOpenedPicker = useRef(false);
  const textInputRef = useRef<TextInput>(null);
  
  // Fetch current user profile from backend
  const backendUser = useQuery(
    api.users.getCurrentUser,
    userId ? { userId } : "skip"
  );
  
  // Fetch existing project if projectId is provided (for editing drafts)
  const existingProject = useQuery(
    api.tasks.getProject,
    projectId ? { id: projectId } : "skip"
  );
  
  // Sync user profile from backend when loaded
  useEffect(() => {
    if (backendUser && userId) {
      console.log('[composer] Syncing user profile from backend');
      syncUserFromBackend(backendUser);
    }
  }, [backendUser, userId, syncUserFromBackend]);
  
  // Pre-populate form data from existing project (for editing drafts)
  useEffect(() => {
    if (existingProject && !draftLoaded) {
      console.log('[composer] Loading draft project data:', existingProject._id);
      
      // Set prompt from project
      setPrompt(existingProject.prompt || '');
      
      // Convert project file URLs to media URIs format
      if (existingProject.fileUrls && existingProject.fileMetadata) {
        const mediaFromProject = existingProject.fileUrls
          .map((url: string | null, index: number) => {
            if (!url) return null;
            const metadata = existingProject.fileMetadata?.[index];
            const isVideo = metadata?.contentType?.startsWith('video/') ?? false;
            return {
              uri: url,
              type: (isVideo ? 'video' : 'image') as 'video' | 'image',
              id: `draft-${index}-${Date.now()}`,
              storageId: metadata?.storageId, // Already uploaded
              uploadedUrl: url, // Already has URL
            };
          })
          .filter((item: any): item is typeof mediaUris[0] => item !== null);
        
        setMediaUris(mediaFromProject);
        console.log('[composer] Loaded', mediaFromProject.length, 'media files from draft');
        
        // If we have media, go straight to description step
        if (mediaFromProject.length > 0) {
          setStep('description');
        }
      }
      
      setDraftLoaded(true);
    }
  }, [existingProject, draftLoaded]);
  
  // Convex hooks
  const generateUploadUrl = useMutation(api.tasks.generateUploadUrl);
  const createProject = useMutation(api.tasks.createProject);
  const generateScriptOnly = useAction(api.tasks.generateScriptOnly);

  // Auto-open media picker on first visit (Step 1)
  useEffect(() => {
    if (step === 'media_selection' && !hasAutoOpenedPicker.current && !projectId && !draftLoaded) {
      hasAutoOpenedPicker.current = true;
      // Small delay to ensure component is mounted
      const timer = setTimeout(() => {
        pickMedia();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [step, projectId, draftLoaded]);
  
  // Auto-focus text input when entering description step
  useEffect(() => {
    if (step === 'description') {
      const timer = setTimeout(() => {
        textInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [step]);

  const handleClose = async () => {
    // Only save draft for NEW projects that haven't been created yet
    // Don't save if:
    // - We have a projectId from params (editing existing draft)
    // - We created a project during this session (went to script-review and came back)
    const hasExistingProject = projectId || createdProjectId;
    if (!hasExistingProject && (mediaUris.length > 0 || prompt.trim())) {
      await saveDraft();
    }
    router.back();
  };

  const saveDraft = async () => {
    if (!userId) return;
    
    try {
      // Get uploaded files from mediaUris
      const uploadedMedia = mediaUris.filter(m => m.storageId);
      
      if (uploadedMedia.length > 0) {
        console.log('[composer] Saving draft with uploaded files...');
        const fileMetadata = uploadedMedia.map(m => ({
          storageId: m.storageId,
          filename: `${m.type}_${m.id}.${m.type === 'video' ? 'mp4' : 'jpg'}`,
          contentType: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
          size: 0, // Size not tracked after upload
        }));
        
        const draftProjectId = await createProject({
          userId,
          prompt: prompt.trim() || 'Draft',
          files: uploadedMedia.map(m => m.storageId),
          fileMetadata,
          thumbnail: uploadedMedia[0]?.storageId,
        });
        console.log('[composer] Draft saved:', draftProjectId);
      }
    } catch (error) {
      console.error('[composer] Failed to save draft:', error);
    }
  };

  const pickMedia = async () => {
    const MAX_MEDIA_FILES = 10;
    
    if (mediaUris.length >= MAX_MEDIA_FILES) {
      Alert.alert('Limit Reached', `You can upload a maximum of ${MAX_MEDIA_FILES} media files.`);
      return;
    }
    
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      alert('Sorry, we need camera roll permissions to make this work!');
      return;
    }

    // Show loading indicator after 2 seconds (for iCloud downloads)
    const loadingTimeout = setTimeout(() => {
      setIsPickingMedia(true);
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
      });

      clearTimeout(loadingTimeout);
      setIsPickingMedia(false);

      if (!result.canceled && result.assets.length > 0) {
        const selectedAssets = result.assets.slice(0, remaining);
        console.log('[pickMedia] Selected assets:', selectedAssets.length);
        
        // Show overlay immediately
        setShowUploadOverlay(true);
        
        // Use consistent 13-digit timestamp for media IDs
        const ts = Date.now();
        const baseTimestamp = parseInt(ts.toString().slice(0, 13).padEnd(13, '0'), 10);
        const newMedia = selectedAssets.map((asset, index) => ({
          uri: asset.uri,
          type: (asset.type === 'video' ? 'video' : 'image') as 'video' | 'image',
          id: `${baseTimestamp + index}`,
          assetId: asset.assetId ?? undefined,
        }));
        
        const allMedia = [...mediaUris, ...newMedia];
        setMediaUris(allMedia);
        
        // Start uploading (only new files)
        await startUpload(allMedia, newMedia);
      }
    } catch (error) {
      clearTimeout(loadingTimeout);
      setIsPickingMedia(false);
      setShowUploadOverlay(false);
      throw error;
    }
  };

  const startUpload = async (allMedia: typeof mediaUris, newMediaOnly?: typeof mediaUris) => {
    // Test Mode: Skip actual uploads, just assign mock storageIds and proceed
    if (ENABLE_TEST_RUN_MODE) {
      console.log('[composer] Test Mode: Skipping uploads, assigning mock storageIds');
      const updatedMedia = allMedia.map(m => ({
        ...m,
        storageId: m.storageId || `mock-storage-${m.id}`,
      }));
      setMediaUris(updatedMedia);
      setShowUploadOverlay(false);
      setStep('description');
      return;
    }
    
    // Only upload files that don't have a storageId yet
    const filesToUpload = newMediaOnly || allMedia.filter(m => !m.storageId);
    
    if (filesToUpload.length === 0) {
      // All files already uploaded, go to description
      setShowUploadOverlay(false);
      setStep('description');
      return;
    }
    
    setUploadProgress({ current: 0, total: filesToUpload.length });
    
    try {
      console.log('[composer] Starting upload of', filesToUpload.length, 'new files');
      
      // Upload files one by one to track progress
      const updatedMedia = [...allMedia];
      
      for (let i = 0; i < filesToUpload.length; i++) {
        const item = filesToUpload[i];
        setUploadProgress({ current: i, total: filesToUpload.length });
        
        // Skip if already uploaded
        if (item.storageId) {
          continue;
        }
        
        try {
          const uploadResult = await uploadMediaFiles(
            generateUploadUrl,
            [{ uri: item.uri, type: item.type, assetId: item.assetId }]
          );
          
          // Update the media item with storageId
          const mediaIndex = updatedMedia.findIndex(m => m.id === item.id);
          if (mediaIndex !== -1 && uploadResult[0]) {
            updatedMedia[mediaIndex] = {
              ...updatedMedia[mediaIndex],
              storageId: uploadResult[0].storageId,
            };
          }
        } catch (error) {
          console.error('[composer] Failed to upload file', i, error);
          throw error;
        }
      }
      
      setUploadProgress({ current: filesToUpload.length, total: filesToUpload.length });
      setMediaUris(updatedMedia);
      
      console.log('[composer] Upload complete:', filesToUpload.length, 'files');
      
      // Hide overlay and move to description step
      setShowUploadOverlay(false);
      setStep('description');
    } catch (error) {
      console.error('[composer] Upload failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      setShowUploadOverlay(false);
      
      // Handle iCloud errors
      if (
        errorMessage.includes('iCloud') || 
        errorMessage.includes('downloading') ||
        errorMessage.includes('PHPhotos') ||
        errorMessage.includes('3164')
      ) {
        Alert.alert(
          'iCloud Video Not Available',
          'One or more videos are stored in iCloud and need to be downloaded first.\n\nTo fix this:\n1. Open the Photos app\n2. Find the video(s) you want to use\n3. Wait for them to fully download\n4. Come back and try again'
        );
      } else {
        Alert.alert('Upload Failed', errorMessage);
      }
      
      // Stay on current step (don't reset)
      if (step === 'media_selection') {
        // Already on media selection
      } else {
        // Stay on description step if we were adding more
      }
    }
  };

  const removeMedia = (index: number) => {
    setMediaUris(prev => prev.filter((_, i) => i !== index));
  };

  const handleAddMoreMedia = () => {
    // Dismiss keyboard before opening media picker
    Keyboard.dismiss();
    pickMedia();
  };

  const handleSubmit = async () => {
    const uploadedMedia = mediaUris.filter(m => m.storageId);
    
    if (!prompt.trim() || uploadedMedia.length === 0 || !userId) {
      return;
    }

    // Test Mode: Skip ALL API calls and navigate directly with mock data
    if (ENABLE_TEST_RUN_MODE) {
      console.log('[composer] Test Mode: Skipping ALL API calls, navigating to script review with mock data');
      
      // Short delay to simulate loading
      setShowGeneratingOverlay(true);
      await new Promise(resolve => setTimeout(resolve, 1000));
      setShowGeneratingOverlay(false);
      
      // Mark as created so no draft is saved when going back
      setCreatedProjectId('test-mode-project');
      
      // Navigate to script review with test mode flag (use push so user can go back)
      router.push({
        pathname: '/script-review',
        params: { 
          projectId: 'test-mode-project',
          testMode: 'true',
        },
      });
      return;
    }

    setShowGeneratingOverlay(true);

    try {
      console.log('[composer] Creating project and generating script...');

      let finalProjectId = projectId;

      if (projectId && existingProject) {
        // Editing existing draft - regenerate script
        console.log('[composer] Regenerating script for existing draft...');
        await generateScriptOnly({ projectId });
      } else {
        // New project - build file metadata from uploaded media
        const fileMetadata = uploadedMedia.map(m => ({
          storageId: m.storageId,
          filename: `${m.type}_${m.id}.${m.type === 'video' ? 'mp4' : 'jpg'}`,
          contentType: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
          size: 0,
        }));
        
        finalProjectId = await createProject({
          userId,
          prompt: prompt.trim(),
          files: uploadedMedia.map(m => m.storageId),
          fileMetadata,
          thumbnail: uploadedMedia[0].storageId,
        });

        console.log('[composer] Project created:', finalProjectId);
        
        // Track created project ID so we don't save duplicate draft if user goes back
        setCreatedProjectId(finalProjectId.toString());
        
        // Generate script
        await generateScriptOnly({ projectId: finalProjectId });
      }

      setShowGeneratingOverlay(false);
      
      // Navigate to script review (use push so user can go back)
      router.push({
        pathname: '/script-review',
        params: { projectId: finalProjectId.toString() },
      });
    } catch (error) {
      console.error('[composer] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Alert.alert('Error', `Failed to generate script: ${errorMessage}`);
      setShowGeneratingOverlay(false);
    }
  };

  const uploadedMedia = mediaUris.filter(m => m.storageId);
  const isValid = prompt.trim().length > 0 && uploadedMedia.length > 0;

  // Render based on current step
  const renderContent = () => {
    switch (step) {
      case 'media_selection':
        return (
          <View style={styles.mediaSelectionContainer}>
            <Text style={styles.title}>
              Hey, {user?.name || 'there'}, share your story!
            </Text>

            <Text style={styles.uploadLabel}>
              Upload Media {mediaUris.length > 0 && `(${mediaUris.length} files)`}
            </Text>

            {/* Media Grid */}
            {mediaUris.length > 0 ? (
              <View style={styles.mediaGrid}>
                {mediaUris.slice(0, 3).map((media, index) => (
                  <View key={media.id} style={styles.mediaItem}>
                    {media.type === 'video' ? (
                      <VideoThumbnail uri={media.uri} style={styles.mediaThumbnail} />
                    ) : (
                      <Image source={{ uri: media.uri }} style={styles.mediaThumbnail} />
                    )}
                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => removeMedia(index)}
                      activeOpacity={0.7}
                    >
                      <X size={16} color={Colors.cream} strokeWidth={2} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.emptyMediaGrid}>
                <Text style={styles.emptyMediaText}>No media selected</Text>
              </View>
            )}

            {/* Add More Media Button */}
            <TouchableOpacity
              testID="selectMediaButton"
              style={styles.addMediaButton}
              onPress={pickMedia}
              activeOpacity={0.7}
              disabled={isPickingMedia}
            >
              <Camera size={20} color={Colors.white} strokeWidth={2} />
              <Text style={styles.addMediaButtonText}>Add More Media</Text>
            </TouchableOpacity>

            {/* iCloud warning */}
            <Text style={styles.icloudWarning}>
            ☁️ Videos stored in iCloud may take a moment to load
            </Text>
          </View>
        );
        
      case 'description':
        return (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.keyboardView}
          >
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.title}>
                Hey, {user?.name || 'there'}, share your story!
              </Text>

              <Text style={styles.uploadLabel}>
                Upload Media {`(optimal: 5-6 files)`}
              </Text>

              {/* Media Preview Grid */}
              <View style={styles.mediaGridSmall}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.mediaScrollContent}
                >
                  {mediaUris.map((media) => (
                    <View key={media.id} style={styles.mediaItemSmall}>
                      {media.type === 'video' ? (
                        <VideoThumbnail uri={media.uri} style={styles.mediaThumbnailSmall} />
                      ) : (
                        <Image source={{ uri: media.uri }} style={styles.mediaThumbnailSmall} />
                      )}
                      <TouchableOpacity
                        style={styles.removeButtonSmall}
                        onPress={() => removeMedia(mediaUris.indexOf(media))}
                        activeOpacity={0.7}
                      >
                        <X size={14} color={Colors.cream} strokeWidth={2} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              </View>

              {/* Add More Media Button */}
              <TouchableOpacity
                style={styles.addMediaButton}
                onPress={handleAddMoreMedia}
                activeOpacity={0.7}
              >
                <Camera size={20} color={Colors.white} strokeWidth={2} />
                <Text style={styles.addMediaButtonText}>Add More Media</Text>
              </TouchableOpacity>

              {/* iCloud warning */}
              <Text style={styles.icloudWarning}>
              ☁️ Videos stored in iCloud may take a moment to load
              </Text>

              {/* Description Input */}
              <View style={styles.inputGroup}>
                <TextInput
                  testID="promptInput"
                  ref={textInputRef}
                  style={styles.input}
                  placeholder="Describe your day, event, or experience..."
                  placeholderTextColor={Colors.gray400}
                  value={prompt}
                  onChangeText={setPrompt}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
              </View>

              {/* Example Story */}
              <View style={styles.exampleContainer}>
                <View style={styles.exampleHeader}>
                  <Camera size={14} color={Colors.ember} strokeWidth={2} />
                  <Text style={styles.exampleTitle}>Example Story</Text>
                </View>
                <Text style={styles.exampleText}>
                  "I went to the a16z Tech Week in SF - met inspiring founders and caught up with old friends. The focus was on pre-seed fundraising. My three main takeaways: storytelling wins, community opens doors, and clarity beats buzzwords."
                </Text>
              </View>

              {/* Generate Script Button */}
              <TouchableOpacity
                testID="generateScriptButton"
                style={[styles.generateButton, !isValid && styles.buttonDisabled]}
                onPress={handleSubmit}
                disabled={!isValid}
                activeOpacity={0.8}
              >
                <Text style={styles.generateButtonText}>Generate Script</Text>
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        );
        
      default:
        return null;
    }
  };

  return (
    <View style={styles.container}>
      {/* Header - always visible */}
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={handleClose}
          activeOpacity={0.7}
        >
          <X size={24} color={Colors.ink} strokeWidth={2} />
        </TouchableOpacity>
        
        <View style={styles.placeholder} />
        
        {/* Forward arrow - show when editing a draft that has a script */}
        {projectId && existingProject?.script ? (
          <TouchableOpacity
            style={styles.navButton}
            onPress={() => {
              router.push({
                pathname: '/script-review',
                params: { projectId: projectId.toString() },
              });
            }}
            activeOpacity={0.7}
          >
            <ArrowRight size={24} color={Colors.ink} strokeWidth={2} />
          </TouchableOpacity>
        ) : (
          <View style={styles.placeholder} />
        )}
      </View>

      {renderContent()}
      
      {/* Unified Upload Overlay (covers iCloud download + server upload) */}
      {(isPickingMedia || showUploadOverlay) && (
        <OverlayLoader
          title="Uploading..."
          preparing={isPickingMedia && !showUploadOverlay}
          progress={showUploadOverlay ? uploadProgress : undefined}
          showWarning={true}
        />
      )}
      
      {/* Generating Script Overlay */}
      {showGeneratingOverlay && (
        <OverlayLoader
          title="Generating your script..."
          subtitle="You'll review it on the next screen"
          showWarning={true}
        />
      )}
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
    paddingHorizontal: 24,
    paddingBottom: 8,
    backgroundColor: Colors.cream,
  },
  closeButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: {
    width: 40,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 40,
  },
  
  // Media Selection Step
  mediaSelectionContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  title: {
    fontSize: 24,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    lineHeight: 32,
    textAlign: 'center',
    marginBottom: 24,
  },
  mediaScrollContent: {
    gap: 10,
  },
  
  // Media Upload Screen
  uploadLabel: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginBottom: 16,
    fontFamily: Fonts.regular,
  },
  mediaGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 24,
  },
  mediaItem: {
    borderRadius: 12,
    overflow: 'hidden',
    width: 100,
    height: 100,
    backgroundColor: Colors.creamDark,
    position: 'relative',
  },
  mediaThumbnail: {
    width: '100%',
    height: '100%',
  },
  removeButton: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 12,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyMediaGrid: {
    height: 100,
    borderRadius: 12,
    backgroundColor: Colors.creamMedium,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 2,
    borderColor: Colors.creamDark,
    borderStyle: 'dashed',
  },
  emptyMediaText: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontFamily: Fonts.regular,
  },
  addMediaButton: {
    backgroundColor: Colors.ember,
    borderRadius: 100,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 16,
  },
  addMediaButtonText: {
    fontSize: 16,
    color: Colors.white,
    fontFamily: Fonts.medium,
  },
  icloudWarning: {
    fontSize: 12,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 16,
    fontFamily: Fonts.regular,
  },

  // Description Screen
  mediaGridSmall: {
    marginBottom: 16,
  },
  mediaItemSmall: {
    borderRadius: 8,
    overflow: 'hidden',
    width: 80,
    height: 80,
    backgroundColor: Colors.creamDark,
    marginRight: 10,
    position: 'relative',
  },
  removeButtonSmall: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 10,
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  generateButton: {
    backgroundColor: Colors.ember,
    borderRadius: 100,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  generateButtonText: {
    fontSize: 17,
    color: Colors.white,
    fontFamily: Fonts.medium,
  },

  // Full Screen Loader
  // Overlay Loader
  overlayLoader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.cream,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  loaderContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  loaderTitle: {
    fontSize: 20,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    marginTop: 20,
  },
  loaderProgress: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginTop: 8,
  },
  loaderSubtitle: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginTop: 8,
  },
  loaderWarning: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.ember,
    marginTop: 16,
  },
  
  // Common styles
  mediaThumbnailSmall: {
    width: '100%',
    height: '100%',
  },
  inputGroup: {
    marginBottom: 16,
  },
  input: {
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: Colors.ink,
    borderWidth: 2,
    borderColor: Colors.creamDark,
    minHeight: 100,
    fontFamily: Fonts.regular,
  },
  exampleContainer: {
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(243, 106, 63, 0.2)',
  },
  exampleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 6,
  },
  exampleTitle: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.ember,
  },
  exampleText: {
    fontSize: 11,
    color: Colors.textSecondary,
    lineHeight: 16,
    fontStyle: 'italic' as const,
    fontFamily: Fonts.regular,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
