import { X, ChevronDown, ChevronUp, Volume2, Check, Play, Square, Mic } from 'lucide-react-native';
import { useState, useEffect } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
  ScrollView,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { Fonts } from '@/constants/typography';
import { useApp } from '@/contexts/AppContext';
import { useVoicePreview } from '@/hooks/useVoicePreview';
import VoiceRecorder from './VoiceRecorder';

interface VoiceConfigModalProps {
  visible: boolean;
  onComplete: () => void;
  onSkip: () => void;
  onClose: () => void;
  showSkip?: boolean;
}

export default function VoiceConfigModal({
  visible,
  onComplete,
  onSkip,
  onClose,
  showSkip = true,
}: VoiceConfigModalProps) {
  const insets = useSafeAreaInsets();
  const { userId } = useApp();
  const [isSaving, setIsSaving] = useState(false);
  const [showVoiceList, setShowVoiceList] = useState(false);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [isPreloading, setIsPreloading] = useState(false);
  const {
    playingPreviewId,
    isGeneratingPreview,
    stopAllPreviews,
    playVoicePreview,
    playLivePreview,
    preloadVoices,
  } = useVoicePreview();

  // Convex hooks
  const generateUploadUrl = useMutation(api.users.generateUploadUrl);
  const updateProfile = useAction(api.users.updateProfile);
  const updateSelectedVoice = useMutation(api.users.updateSelectedVoice);
  
  // Query default voices (now includes previewUrl)
  const defaultVoices = useQuery(api.users.getDefaultVoices);
  
  // Query current user to check for existing voice clone
  const backendUser = useQuery(
    api.users.getCurrentUser,
    userId ? { userId } : "skip"
  );
  const hasVoiceClone = !!backendUser?.elevenlabsVoiceId;
  
  // Get preview URL for user's cloned voice
  // Try voicePreviewStorageId first (TTS preview), fall back to voiceRecordingStorageId (original recording)
  const clonePreviewStorageId = backendUser?.voicePreviewStorageId || backendUser?.voiceRecordingStorageId;
  const clonePreviewUrl = useQuery(
    api.tasks.getStorageUrl,
    clonePreviewStorageId
      ? { storageId: clonePreviewStorageId }
      : "skip"
  );

  // Initialize selectedVoiceId from backend user when modal opens
  useEffect(() => {
    if (visible && backendUser?.selectedVoiceId) {
      setSelectedVoiceId(backendUser.selectedVoiceId);
    }
  }, [visible, backendUser?.selectedVoiceId]);
  
  // Auto-expand voice list when user already has a clone (so they can see it)
  useEffect(() => {
    if (visible && hasVoiceClone) {
      setShowVoiceList(true);
    }
  }, [visible, hasVoiceClone]);

  // Pre-cache audio when voice list is shown
  useEffect(() => {
    if (showVoiceList && defaultVoices && defaultVoices.length > 0 && !isPreloading) {
      preloadAudioFiles();
    }
  }, [showVoiceList, defaultVoices]);

  const preloadAudioFiles = async () => {
    if (!defaultVoices || isPreloading) return;
    setIsPreloading(true);
    await preloadVoices(defaultVoices);
    setIsPreloading(false);
  };

  // Helper function to upload voice recording to Convex storage
  const uploadVoiceRecording = async (uri: string): Promise<string | null> => {
    try {
      console.log('[VoiceConfigModal] Uploading voice recording...');
      
      // Get upload URL
      const uploadUrl = await generateUploadUrl();
      
      // Read the file
      const response = await fetch(uri);
      const blob = await response.blob();
      
      // Upload to Convex storage
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
      
      if (!uploadResponse.ok) {
        throw new Error('Failed to upload voice recording');
      }
      
      const { storageId } = await uploadResponse.json();
      console.log('[VoiceConfigModal] Voice recording uploaded:', storageId);
      return storageId;
    } catch (error) {
      console.error('[VoiceConfigModal] Error uploading voice recording:', error);
      return null;
    }
  };

  const handleVoiceRecordingComplete = async (uri: string) => {
    if (!userId) return;
    
    setIsSaving(true);
    try {
      console.log('[VoiceConfigModal] Saving voice recording...');
      
      // Upload voice recording to Convex
      const voiceStorageId = await uploadVoiceRecording(uri);
      
      if (!voiceStorageId) {
        Alert.alert('Error', 'Failed to upload voice recording. Please try again.');
        setIsSaving(false);
        return;
      }
      
      // Update user profile with voice recording
      // This will create the ElevenLabs voice clone on the backend
      await updateProfile({
        userId,
        voiceRecordingStorageId: voiceStorageId,
      });
      
      console.log('[VoiceConfigModal] Voice saved successfully!');
      setIsSaving(false);
      
      stopAllPreviews();
      setTimeout(() => {
        onComplete();
      }, 100);
    } catch (error) {
      console.error('[VoiceConfigModal] Error saving voice:', error);
      Alert.alert('Error', 'Failed to save your voice. Please try again.');
      setIsSaving(false);
    }
  };

  const handleSkipOrDone = () => {
    if (isSaving) return;
    stopAllPreviews();
    
    if (selectedVoiceId) {
      onComplete();
    } else {
      onSkip();
    }
  };

  const handleSelectDefaultVoice = async (voiceId: string) => {
    if (!userId || isSaving) return;
    
    // If already selected, deselect
    if (selectedVoiceId === voiceId) {
      setSelectedVoiceId(null);
      return;
    }
    
    setIsSaving(true);
    try {
      console.log('[VoiceConfigModal] Selecting default voice:', voiceId);
      
      await updateSelectedVoice({
        userId,
        voiceId,
      });
      
      console.log('[VoiceConfigModal] Default voice selected successfully!');
      setSelectedVoiceId(voiceId);
      setIsSaving(false);
    } catch (error) {
      console.error('[VoiceConfigModal] Error selecting default voice:', error);
      Alert.alert('Error', 'Failed to select voice. Please try again.');
      setIsSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => { stopAllPreviews(); onClose(); }}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => { stopAllPreviews(); onClose(); }}
            activeOpacity={0.7}
            disabled={isSaving}
          >
            <X size={24} color={isSaving ? Colors.gray400 : Colors.ink} strokeWidth={2} />
          </TouchableOpacity>
          {(showSkip || selectedVoiceId) && (
            <TouchableOpacity
              style={[
                styles.headerSkipButton,
                selectedVoiceId && styles.headerDoneButton,
              ]}
              onPress={handleSkipOrDone}
              activeOpacity={0.7}
              disabled={isSaving}
            >
              <Text style={[
                styles.headerSkipText,
                selectedVoiceId && styles.headerDoneText,
                isSaving && { opacity: 0.5 },
              ]}>
                {selectedVoiceId ? 'Done' : 'Skip'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 20 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerContent}>
            <View style={styles.iconContainer}>
              <Image
                source={require('../assets/images/reel-icon.png')}
                style={styles.iconImage}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.title}>Record Your Voice</Text>
            <Text style={styles.subtitle}>
              Create your personalized AI voice for all your reels
            </Text>
          </View>

          <View style={styles.content}>
            <VoiceRecorder
              onRecordingComplete={handleVoiceRecordingComplete}
              onBeforeRecord={async () => {
                await stopAllPreviews();
              }}
              showScript={true}
              disabled={isSaving}
            />
            
            <TouchableOpacity
              style={styles.noteContainer}
              onPress={() => setShowVoiceList(!showVoiceList)}
              activeOpacity={0.7}
              disabled={isSaving}
            >
              <View style={styles.noteContent}>
                <Text style={styles.noteText}>
                  Don&apos;t want to record? No worries!{' '}
                  <Text style={styles.noteTextLink}>Use our default AI voices instead</Text>
                </Text>
                {showVoiceList ? (
                  <ChevronUp size={18} color={Colors.ember} strokeWidth={2} />
                ) : (
                  <ChevronDown size={18} color={Colors.ember} strokeWidth={2} />
                )}
              </View>
            </TouchableOpacity>

            {/* Expandable Voice List */}
            {showVoiceList && (
              <View style={styles.voicesList}>
                {/* User's cloned voice - shown first */}
                {hasVoiceClone && backendUser?.elevenlabsVoiceId && (() => {
                  const cloneVoiceId = backendUser.elevenlabsVoiceId!;
                  const isSelected = selectedVoiceId === cloneVoiceId;
                  const isPlaying = playingPreviewId === cloneVoiceId;
                  const hasPreview = !!clonePreviewUrl;
                  const isLoading_ = isPlaying && isGeneratingPreview;
                  
                  return (
                    <TouchableOpacity
                      key="my-voice-clone"
                      style={[
                        styles.voiceOption,
                        isSelected && styles.voiceOptionSelected,
                      ]}
                      onPress={() => handleSelectDefaultVoice(cloneVoiceId)}
                      activeOpacity={0.7}
                      disabled={isSaving}
                    >
                      <View style={styles.voiceOptionContent}>
                        {isSelected ? (
                          <View style={styles.checkIconContainer}>
                            <Check size={18} color={Colors.white} strokeWidth={3} />
                          </View>
                        ) : (
                          <Mic size={22} color={Colors.ember} strokeWidth={2} />
                        )}
                        <View style={styles.voiceOptionTextContainer}>
                          <Text style={styles.voiceOptionName}>
                            {backendUser?.name ? `${backendUser.name}'s Voice` : 'Your Voice'}
                          </Text>
                          <Text style={styles.voiceOptionDesc}>
                            Custom AI voice clone
                          </Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        style={[
                          styles.previewButton,
                          isPlaying && styles.previewButtonPlaying,
                        ]}
                        onPress={() => {
                          if (hasPreview) {
                            playVoicePreview(cloneVoiceId, clonePreviewUrl!);
                          } else {
                            playLivePreview(cloneVoiceId);
                          }
                        }}
                        activeOpacity={0.7}
                        disabled={isLoading_}
                      >
                        {isLoading_ ? (
                          <ActivityIndicator size="small" color={Colors.ember} />
                        ) : isPlaying ? (
                          <Square size={14} color={Colors.white} strokeWidth={0} fill={Colors.white} />
                        ) : (
                          <Play size={16} color={Colors.ember} strokeWidth={0} fill={Colors.ember} />
                        )}
                      </TouchableOpacity>
                    </TouchableOpacity>
                  );
                })()}
                
                {/* Default voices */}
                {defaultVoices?.map((voice: any) => {
                  const isSelected = selectedVoiceId === voice.voiceId;
                  const isPlaying = playingPreviewId === voice.voiceId;
                  
                  return (
                    <TouchableOpacity
                      key={voice._id}
                      style={[
                        styles.voiceOption,
                        isSelected && styles.voiceOptionSelected,
                      ]}
                      onPress={() => handleSelectDefaultVoice(voice.voiceId)}
                      activeOpacity={0.7}
                      disabled={isSaving}
                    >
                      <View style={styles.voiceOptionContent}>
                        {isSelected ? (
                          <View style={styles.checkIconContainer}>
                            <Check size={18} color={Colors.white} strokeWidth={3} />
                          </View>
                        ) : (
                          <Volume2 size={22} color={Colors.ember} strokeWidth={2} />
                        )}
                        <View style={styles.voiceOptionTextContainer}>
                          <Text style={styles.voiceOptionName}>{voice.name}</Text>
                          <Text style={styles.voiceOptionDesc}>
                            {voice.description || 'Default voice'}
                          </Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        style={[
                          styles.previewButton,
                          isPlaying && styles.previewButtonPlaying,
                        ]}
                        onPress={() => voice.previewUrl && playVoicePreview(voice.voiceId, voice.previewUrl)}
                        activeOpacity={0.7}
                        disabled={!voice.previewUrl}
                      >
                        {isPlaying ? (
                          <Square size={14} color={Colors.white} strokeWidth={0} fill={Colors.white} />
                        ) : (
                          <Play size={16} color={voice.previewUrl ? Colors.ember : Colors.gray400} strokeWidth={0} fill={voice.previewUrl ? Colors.ember : Colors.gray400} />
                        )}
                      </TouchableOpacity>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  closeButton: {
    padding: 8,
  },
  headerSkipButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  headerDoneButton: {
    backgroundColor: Colors.ember,
    borderRadius: 20,
  },
  headerSkipText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.textSecondary,
  },
  headerDoneText: {
    color: Colors.white,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  headerContent: {
    alignItems: 'center',
    marginBottom: 32,
  },
  iconContainer: {
    marginBottom: 16,
  },
  iconImage: {
    width: 72,
    height: 72,
  },
  title: {
    fontSize: 24,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  content: {
    flex: 1,
  },
  noteContainer: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    padding: 14,
    marginTop: 16,
    borderWidth: 1,
    borderColor: Colors.creamDark,
  },
  noteContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  noteText: {
    fontSize: 13,
    lineHeight: 19,
    color: Colors.textSecondary,
    fontFamily: Fonts.regular,
    textAlign: 'center',
    flex: 1,
  },
  noteTextLink: {
    color: Colors.ember,
    fontFamily: Fonts.medium,
  },
  voicesList: {
    marginTop: 12,
  },
  voiceOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 2,
    borderColor: Colors.creamDark,
  },
  voiceOptionSelected: {
    borderColor: Colors.ember,
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
  },
  checkIconContainer: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.ember,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.creamDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewButtonPlaying: {
    backgroundColor: Colors.ember,
  },
  voiceOptionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  voiceOptionTextContainer: {
    flex: 1,
  },
  voiceOptionName: {
    fontSize: 15,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    marginBottom: 2,
  },
  voiceOptionDesc: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
});
