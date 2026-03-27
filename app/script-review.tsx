import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Edit2, Check, X, RotateCcw, Play, TestTube } from 'lucide-react-native';
import { useState, useEffect } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { Asset } from 'expo-asset';
import { uploadFileToConvex } from '@/lib/api-helpers';
import { Fonts } from '@/constants/typography';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';

// Conditionally load test data only when test mode is enabled
// This prevents Metro from bundling testData.ts in production builds
 
// UNCOMMENT THIS FOR LOCAL TESTING
// const TEST_MODE_DATA = ENABLE_TEST_RUN_MODE 
//   ? require('@/constants/testData').TEST_MODE_DATA 
//   : { script: '', prompt: '', localVideoPath: null };

const TEST_MODE_DATA = { 
  script: '', 
  prompt: '', 
  localVideoPath: null 
};

export default function ScriptReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ projectId: string; testRun?: string; testMode?: string }>();
  const projectId = params.projectId as any;
  const isTestRun = params.testRun === 'true';
  // Test mode is active if ENABLE_TEST_RUN_MODE is true AND we're coming from composer with testMode flag
  const isTestMode = params.testMode === 'true' || (ENABLE_TEST_RUN_MODE && projectId === 'test-mode-project');
  const { addVideo, videos } = useApp();

  // Convex hooks - SKIP all queries in test mode to avoid API calls
  const project = useQuery(api.tasks.getProject, (!isTestMode && projectId) ? { id: projectId } : "skip");
  const updateProjectScript = useMutation(api.tasks.updateProjectScript);
  const regenerateScript = useAction(api.tasks.regenerateScript);
  const markProjectSubmitted = useMutation(api.tasks.markProjectSubmitted);
  const markProjectSubmittedTestMode = useMutation(api.tasks.markProjectSubmittedTestMode);
  const generateUploadUrl = useMutation(api.tasks.generateUploadUrl);
  const updateProjectRenderMode = useMutation(api.tasks.updateProjectRenderMode);
  const updateProjectVoiceSpeed = useMutation(api.tasks.updateProjectVoiceSpeed);
  const updateProjectAudioSettings = useMutation(api.tasks.updateProjectAudioSettings);

  // Local state
  const [isEditing, setIsEditing] = useState(false);
  const [editedScript, setEditedScript] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [renderMode, setRenderMode] = useState<'remotion' | 'ffmpeg'>('ffmpeg');
  const [lastProjectScript, setLastProjectScript] = useState<string>('');
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.08); // Default to "Normal" (1.08)
  const [includeMusic, setIncludeMusic] = useState<boolean>(true); // Default to include music
  const [includeCaptions, setIncludeCaptions] = useState<boolean>(true); // Default to include captions
  const [keepOrder, setKeepOrder] = useState<boolean>(false); // Default to not keeping original order

  // Initialize script and render mode from project (or mock data in test mode)
  useEffect(() => {
    // Test Mode: Use predefined script from test data - NO API calls
    if (isTestMode && !editedScript) {
      console.log('[script-review] Test Mode: Using predefined script (no API calls)');
      setEditedScript(TEST_MODE_DATA.script);
      setLastProjectScript(TEST_MODE_DATA.script);
      return;
    }
    
    if (project?.script) {
      // Update editedScript when project script changes (e.g., after regeneration)
      // But only if we're not currently editing
      if (!isEditing && project.script !== lastProjectScript) {
      // Replace ??? with ? for display
      setEditedScript(project.script.replace(/\?\?\?/g, "?"));
        setLastProjectScript(project.script);
      } else if (!editedScript) {
        // Initial load
        setEditedScript(project.script.replace(/\?\?\?/g, "?"));
        setLastProjectScript(project.script);
      }
    }
    if (project?.renderMode) {
      setRenderMode(project.renderMode);
    }
    if (project?.voiceSpeed) {
      setVoiceSpeed(project.voiceSpeed);
    }
    // Load keepOrder setting (default to false if not set)
    if (project?.keepOrder !== undefined) {
      setKeepOrder(project.keepOrder);
    }
    
    // Always ensure audio settings are ON (user can configure in final project)
    // These are explicitly set to true and NOT loaded from project
    setIncludeMusic(true);
    setIncludeCaptions(true);
  }, [project?.script, project?.renderMode, project?.voiceSpeed, project?.keepOrder, isEditing, isTestMode]);

  const handleSaveEdit = async () => {
    if (!projectId || !editedScript.trim()) {
      Alert.alert('Error', 'Script cannot be empty');
      return;
    }

    try {
      // Replace ? with ??? before saving (but not if it's already ???)
      const scriptToSave = editedScript.trim().replace(/\?(?!\?\?)/g, "???");
      await updateProjectScript({
        id: projectId,
        script: scriptToSave,
      });
      setIsEditing(false);
    } catch (error) {
      console.error('Update script error:', error);
      Alert.alert('Error', 'Failed to update script');
    }
  };

  const handleCancelEdit = () => {
    // Replace ??? with ? for display
    setEditedScript((project?.script || '').replace(/\?\?\?/g, "?"));
    setIsEditing(false);
  };

  const handleRegenerate = async () => {
    if (!projectId) return;

    // Always ensure audio settings are ON for regeneration
    // (user can configure these in the final project anyway)
    setIncludeMusic(true);
    setIncludeCaptions(true);

    setIsRegenerating(true);
    try {
      const result = await regenerateScript({ projectId });
      if (result.success) {
        // The new script will be automatically picked up by the useEffect
      } else {
        throw new Error(result.error || 'Failed to regenerate script');
      }
    } catch (error) {
      console.error('Regenerate script error:', error);
      Alert.alert('Error', 'Failed to regenerate script');
    } finally {
      setIsRegenerating(false);
    }
  };

  // Action to get fresh video URL from the source project (only used in production mode)
  const getFreshVideoUrl = useAction(api.tasks.getFreshProjectVideoUrl);
  
  const handleApprove = async () => {
    // Test Mode: Skip ALL API calls and use local video file
    if (isTestMode) {
      console.log('[script-review] Test Mode: Using local video file (NO API calls)');

      // Check if local video is available (it's excluded from production builds)
      if (!TEST_MODE_DATA.localVideoPath) {
        Alert.alert(
          'Test Mode Error',
          'Local test video is not available. The video file is excluded from production builds. For local testing, add test-video.mp4 to assets/ folder.',
          [{ text: 'OK' }]
        );
        return;
      }

      setIsSubmitting(true);

      // Get the local video URI from the require() asset
      const localVideoUri = Asset.fromModule(TEST_MODE_DATA.localVideoPath).uri;

      console.log('[script-review] Test Mode: Local video URI:', localVideoUri);

      // Show generation started message (same as production)
      Alert.alert(
        '🎬 Generation Started!',
        'Your video is being created! Feel free to close the app — we\'ll send you a notification when it\'s ready.',
        [{
          text: 'Got it!',
          style: 'default',
          onPress: () => {
            // Navigate to video-preview with the LOCAL video file
            router.replace({
              pathname: '/video-preview',
              params: {
                videoId: 'test-mode-video',
                videoUri: localVideoUri,
                prompt: TEST_MODE_DATA.prompt,
                script: TEST_MODE_DATA.script,
                testMode: 'true',
              },
            });
          }
        }]
      );
      return;
    }

    if (!projectId || !project?.script) {
      Alert.alert('Error', 'No script available');
      return;
    }

    // Check if this is the user's first project BEFORE adding the optimistic video
    const isFirstProject = videos.filter(v => v.status !== 'draft').length === 0;

    setIsSubmitting(true);

    // For normal mode, add video to context FIRST, then show alert
    if (!isTestRun) {
      // Get the script to save
      const scriptToSave = editedScript !== project.script
        ? editedScript.trim().replace(/\?(?!\?\?)/g, "???")
        : project.script.replace(/\?(?!\?\?)/g, "???");

      // Optimistically update video status to "processing" BEFORE showing alert
      console.log('[script-review] Adding video with processing status before alert...');
      addVideo({
        id: projectId,
        uri: '',
        prompt: project.prompt,
        script: scriptToSave,
        createdAt: project.createdAt || Date.now(),
        status: 'processing',
        projectId: projectId,
        thumbnailUrl: project.thumbnailUrl,
      });

      // NOW show the alert and navigate
      Alert.alert(
        '🎬 Generation Started!',
        'Your video is being created! Feel free to close the app — we\'ll send you a notification when it\'s ready.',
        [{
          text: 'Got it!',
          style: 'default',
          onPress: () => {
            // Navigate to feed immediately
            router.replace('/(tabs)');
          }
        }]
      );

      // Process API calls in background after showing alert
      processBackgroundTasks();
    } else {
      // For test run, process normally without showing alert
      await processBackgroundTasks();
    }
  };

  // Helper function to process all API calls in background
  const processBackgroundTasks = async () => {
    if (!projectId || !project?.script) return;

    try {
      // Save any edits (replace ? with ??? before saving, matching studio behavior)
      const scriptToSave = editedScript !== project.script
        ? editedScript.trim().replace(/\?(?!\?\?)/g, "???")
        : project.script.replace(/\?(?!\?\?)/g, "???");

      if (editedScript !== project.script || scriptToSave !== project.script) {
        console.log('[script-review] Saving edited script...');
        await updateProjectScript({
          id: projectId,
          script: scriptToSave,
        });
      }

      // Save render mode
      console.log('[script-review] Saving render mode:', renderMode);
      await updateProjectRenderMode({
        id: projectId,
        renderMode,
      });

      // Save voice speed
      console.log('[script-review] Saving voice speed:', voiceSpeed);
      await updateProjectVoiceSpeed({
        id: projectId,
        voiceSpeed,
      });

      // Save music, captions, and keepOrder settings
      console.log('[script-review] Saving audio settings - music:', includeMusic, 'captions:', includeCaptions, 'keepOrder:', keepOrder);
      await updateProjectAudioSettings({
        id: projectId,
        includeMusic,
        includeCaptions,
        keepOrder,
      });

      // Skip adding video here if not test run (already added before alert)
      if (isTestRun) {
        // Only add video for test run mode
        console.log('[script-review] Test run: updating video to processing state...');
        addVideo({
          id: projectId,
          uri: '',
          prompt: project.prompt,
          script: scriptToSave,
          createdAt: project.createdAt || Date.now(),
          status: 'processing',
          projectId: projectId,
          thumbnailUrl: project.thumbnailUrl,
        });
      }

      // For normal mode, mark as submitted and schedule generation server-side
      if (!isTestRun) {
        console.log('[script-review] Marking project as submitted (schedules generation server-side)...');
        try {
          await markProjectSubmitted({ id: projectId });
          console.log('[script-review] Media generation scheduled server-side');
        } catch (submitError) {
          // Check if this is a free tier limit error
          const errorMessage = submitError instanceof Error ? submitError.message : String(submitError);
          if (errorMessage.includes('FREE_TIER_LIMIT_REACHED')) {
            console.log('[script-review] User has reached free tier limit, showing paywall');
            setIsSubmitting(false);
            router.push('/paywall');
            return;
          }
          // Re-throw other errors to be caught by outer catch
          throw submitError;
        }
      }

      // Test run mode requested but not available when ENABLE_TEST_RUN_MODE is false
      if (isTestRun && !ENABLE_TEST_RUN_MODE) {
        console.error('[script-review] Test run mode requested but ENABLE_TEST_RUN_MODE is disabled');
        Alert.alert('Error', 'Test mode is not available in this build. Sample assets are not configured.');
        setIsSubmitting(false);
        return;
      }
    } catch (error) {
      console.error('[script-review] Approve error:', error);
      Alert.alert('Error', `Failed to start generation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsSubmitting(false);
    }
  };

  // Test Mode: Skip the normal project loading checks
  const hasScript = isTestMode ? !!editedScript : !!project?.script;
  // Show loading if we don't have a script yet (regardless of status)
  // This ensures we never show "No script available" when script is being generated
  const isLoadingScript = !isTestMode && project && !hasScript;

  if (!projectId && !isTestMode) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <ArrowLeft size={24} color={Colors.ink} strokeWidth={2} />
          </TouchableOpacity>
          {/* <Text style={styles.headerTitle}>Script Review</Text> */}
          {/* <View style={styles.placeholder} /> */}
        </View>
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>No project ID</Text>
        </View>
      </View>
    );
  }

  if (!project && !isTestMode) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <ArrowLeft size={24} color={Colors.ink} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Script Review</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.ember} />
        </View>
      </View>
    );
  }

  // Navigate back to composer (reverse slide animation)
  const handleBackToComposer = () => {
    router.back();
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={handleBackToComposer}
          activeOpacity={0.7}
        >
          <ArrowLeft size={24} color={Colors.ink} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Review Script</Text>
        <View style={styles.placeholder} />
      </View>

      {ENABLE_TEST_RUN_MODE && isTestRun && (
        <View style={styles.testModeBadge}>
          <TestTube size={14} color={Colors.ember} />
          <Text style={styles.testModeText}>Test Run Mode</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {isLoadingScript ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={Colors.ember} />
            <Text style={styles.loadingText}>Generating script...</Text>
          </View>
        ) : hasScript ? (
          <>
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Generated Script</Text>
                {!isEditing && (
                  <View style={styles.actions}>
                    <TouchableOpacity
                      style={styles.iconButton}
                      onPress={() => setIsEditing(true)}
                      activeOpacity={0.7}
                    >
                      <Edit2 size={18} color={Colors.ember} strokeWidth={2} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.iconButton}
                      onPress={handleRegenerate}
                      activeOpacity={0.7}
                      disabled={isRegenerating}
                    >
                      {isRegenerating ? (
                        <ActivityIndicator size="small" color={Colors.ember} />
                      ) : (
                        <RotateCcw size={18} color={Colors.ember} strokeWidth={2} />
                      )}
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {isEditing ? (
                <View style={styles.editingContainer}>
                  <TextInput
                    style={styles.scriptInput}
                    value={editedScript}
                    onChangeText={setEditedScript}
                    multiline
                    textAlignVertical="top"
                    placeholder="Enter script..."
                    placeholderTextColor={Colors.gray400}
                    autoFocus
                  />
                  <View style={styles.editActions}>
                    <TouchableOpacity
                      style={styles.editButton}
                      onPress={handleSaveEdit}
                      activeOpacity={0.7}
                    >
                      <Check size={18} color={Colors.cream} strokeWidth={2} />
                      <Text style={styles.editButtonText}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.cancelButton}
                      onPress={handleCancelEdit}
                      activeOpacity={0.7}
                    >
                      <X size={18} color={Colors.textSecondary} strokeWidth={2} />
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View testID="scriptContainer" style={styles.scriptContainer}>
                  <Text style={styles.scriptText}>{editedScript || (project.script ? project.script.replace(/\?\?\?/g, "?") : '')}</Text>
                </View>
              )}
            </View>

            {/* Voice Speed Selector */}
            <View style={styles.voiceSpeedContainer}>
              <Text style={styles.voiceSpeedLabel}>Voice Speed</Text>
              <View style={styles.voiceSpeedToggle}>
                {[
                  { label: 'Slow', value: 1.0 },
                  { label: 'Normal', value: 1.08 },
                  { label: 'Fast', value: 1.15 },
                  { label: 'Very Fast', value: 1.25 },
                ].map((option) => (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.voiceSpeedOption,
                      voiceSpeed === option.value && styles.voiceSpeedOptionActive
                    ]}
                    onPress={() => setVoiceSpeed(option.value)}
                    activeOpacity={0.7}
                  >
                    <Text style={[
                      styles.voiceSpeedText,
                      voiceSpeed === option.value && styles.voiceSpeedTextActive
                    ]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Audio Options - Music and Captions checkboxes */}
            {/* Hidden for now - defaults to true for both. Uncomment to enable user control */}
            {/* <View style={styles.audioOptionsContainer}>
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() => setIncludeMusic(!includeMusic)}
                activeOpacity={0.7}
              >
                <View style={[styles.checkbox, includeMusic && styles.checkboxChecked]}>
                  {includeMusic && <Check size={14} color={Colors.cream} strokeWidth={3} />}
                </View>
                <Text style={styles.checkboxLabel}>Add Music</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() => setIncludeCaptions(!includeCaptions)}
                activeOpacity={0.7}
              >
                <View style={[styles.checkbox, includeCaptions && styles.checkboxChecked]}>
                  {includeCaptions && <Check size={14} color={Colors.cream} strokeWidth={3} />}
                </View>
                <Text style={styles.checkboxLabel}>Add Captions</Text>
              </TouchableOpacity>
            </View> */}

            {/* Keep Order checkbox - separate row */}
            <View style={styles.keepOrderContainer}>
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() => setKeepOrder(!keepOrder)}
                activeOpacity={0.7}
              >
                <View style={[styles.checkbox, keepOrder && styles.checkboxChecked]}>
                  {keepOrder && <Check size={14} color={Colors.cream} strokeWidth={3} />}
                </View>
                <Text style={styles.checkboxLabel}>Keep Order</Text>
              </TouchableOpacity>
            </View>

            {/* Render Mode Toggle - Commented out for production (defaults to ffmpeg) */}
            {/* <View style={styles.renderModeContainer}>
              <Text style={styles.renderModeLabel}>Rendering Engine:</Text>
              <View style={styles.renderModeToggle}>
                <TouchableOpacity
                  style={[
                    styles.renderModeOption,
                    renderMode === 'remotion' && styles.renderModeOptionActive
                  ]}
                  onPress={() => setRenderMode('remotion')}
                  activeOpacity={0.7}
                >
                  <Text style={[
                    styles.renderModeText,
                    renderMode === 'remotion' && styles.renderModeTextActive
                  ]}>
                    Remotion
                  </Text>
                  <Text style={styles.renderModeDesc}>(Higher quality)</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.renderModeOption,
                    renderMode === 'ffmpeg' && styles.renderModeOptionActive
                  ]}
                  onPress={() => setRenderMode('ffmpeg')}
                  activeOpacity={0.7}
                >
                  <Text style={[
                    styles.renderModeText,
                    renderMode === 'ffmpeg' && styles.renderModeTextActive
                  ]}>
                    FFmpeg
                  </Text>
                  <Text style={styles.renderModeDesc}>(Faster)</Text>
                </TouchableOpacity>
              </View>
            </View> */}

            <TouchableOpacity
              testID="approveScriptButton"
              style={[styles.approveButton, isSubmitting && styles.approveButtonDisabled]}
              onPress={handleApprove}
              disabled={isSubmitting}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.approveButtonInner,
                  { backgroundColor: isSubmitting ? Colors.creamDark : Colors.ember }
                ]}
              >
                {isSubmitting ? (
                  <>
                    <ActivityIndicator size="small" color={Colors.white} />
                    <Text style={styles.approveButtonText}>Starting...</Text>
                  </>
                ) : (
                  <>
                    <Play size={20} color={Colors.white} strokeWidth={2.5} />
                    <Text style={styles.approveButtonText}>Approve & Generate Reel</Text>
                  </>
                )}
              </View>
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>No script available</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={handleRegenerate}
              activeOpacity={0.7}
            >
              <Text style={styles.retryButtonText}>Generate Script</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
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
    paddingBottom: 16,
    backgroundColor: Colors.cream,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: Fonts.medium,
    color: Colors.ink,
  },
  placeholder: {
    width: 40,
  },
  content: {
    padding: 24,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    color: Colors.textSecondary,
    fontSize: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.ink,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scriptContainer: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.creamDark,
  },
  scriptText: {
    fontSize: 16,
    lineHeight: 24,
    color: Colors.ink,
  },
  editingContainer: {
    gap: 12,
  },
  scriptInput: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 16,
    fontSize: 16,
    color: Colors.ink,
    borderWidth: 2,
    borderColor: Colors.ember,
    minHeight: 200,
    textAlignVertical: 'top',
  },
  editActions: {
    flexDirection: 'row',
    gap: 12,
  },
  editButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.ember,
    borderRadius: 100,
    padding: 16,
  },
  editButtonText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  cancelButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.creamDark,
    borderRadius: 100,
    padding: 16,
  },
  cancelButtonText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.textSecondary,
  },
  voiceSpeedContainer: {
    marginTop: 2,
    gap: 12,
  },
  voiceSpeedLabel: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  voiceSpeedToggle: {
    flexDirection: 'row',
    gap: 8,
  },
  voiceSpeedOption: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: 2,
    borderColor: Colors.creamDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceSpeedOptionActive: {
    borderColor: Colors.ember,
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
  },
  voiceSpeedText: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    textAlign: 'center',
  },
  voiceSpeedTextActive: {
    color: Colors.ember,
    fontWeight: '600',
  },
  audioOptionsContainer: {
    marginTop: 20,
    flexDirection: 'row',
    gap: 24,
  },
  keepOrderContainer: {
    marginTop: 20,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Colors.creamDarker,
    backgroundColor: Colors.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: Colors.ember,
    borderColor: Colors.ember,
  },
  checkboxLabel: {
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.ink,
  },
  renderModeContainer: {
    marginTop: 24,
    gap: 12,
  },
  renderModeLabel: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  renderModeToggle: {
    flexDirection: 'row',
    gap: 12,
  },
  renderModeOption: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: Colors.creamDark,
    alignItems: 'center',
  },
  renderModeOptionActive: {
    borderColor: Colors.ember,
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
  },
  renderModeText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    fontWeight: '600',
    marginBottom: 4,
  },
  renderModeTextActive: {
    color: Colors.ember,
  },
  renderModeDesc: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  approveButton: {
    borderRadius: 100,
    overflow: 'hidden',
    marginTop: 24,
  },
  approveButtonDisabled: {
    opacity: 0.5,
  },
  approveButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 18,
    borderRadius: 100,
  },
  approveButtonText: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  errorContainer: {
    alignItems: 'center',
    gap: 16,
    paddingVertical: 40,
  },
  errorText: {
    fontSize: 16,
    color: Colors.textSecondary,
  },
  retryButton: {
    backgroundColor: Colors.ember,
    borderRadius: 100,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  retryButtonText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  testModeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginHorizontal: 24,
    marginTop: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(243, 106, 63, 0.2)',
  },
  testModeText: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.ember,
  },
});

