import { useRouter } from 'expo-router';
import { User, Palette, Mic, Volume2, Headphones, Info, ChevronRight, Crown, Gift, Check, Trash2, X, Play, Square } from 'lucide-react-native';
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
  Animated,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { useVoicePreview } from '@/hooks/useVoicePreview';
import { useApp } from '@/contexts/AppContext';
import { StylePreference } from '@/types';
import VoiceRecorder from '@/components/VoiceRecorder';
import { uploadFileToConvex, mapStyleToBackend, mapStyleToApp } from '@/lib/api-helpers';
import { Fonts } from '@/constants/typography';
import { ENABLE_STYLE_PREFERENCE } from '@/constants/config';

const STYLE_OPTIONS: StylePreference[] = ['Playful', 'Professional', 'Dreamy'];

// Bottom padding to account for the floating tab bar
const TAB_BAR_HEIGHT = 100;

export default function ProfileTab() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId, saveUser, clearData } = useApp();
  
  // Convex queries
  const user = useQuery(api.users.getCurrentUser, userId ? { userId } : "skip");
  const defaultVoices = useQuery(api.users.getDefaultVoices);
  const videoGenerationStatus = useQuery(
    api.users.getVideoGenerationStatus,
    userId ? { userId } : "skip"
  );
  const clonePreviewStorageId = user?.voicePreviewStorageId || user?.voiceRecordingStorageId;
  const clonePreviewUrl = useQuery(
    api.tasks.getStorageUrl,
    clonePreviewStorageId ? { storageId: clonePreviewStorageId } : "skip"
  );
  
  // Convex mutations and actions
  const generateUploadUrl = useMutation(api.users.generateUploadUrl);
  const updateProfile = useAction(api.users.updateProfile);
  const updateSelectedVoice = useMutation(api.users.updateSelectedVoice);
  const deleteAccountAction = useAction(api.users.deleteAccount);
  
  // Local state
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingStyle, setIsEditingStyle] = useState(false);
  const [isEditingVoice, setIsEditingVoice] = useState(false);
  const [isSelectingVoice, setIsSelectingVoice] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [editedStyle, setEditedStyle] = useState<StylePreference | null>(null);
  const [isPreloading, setIsPreloading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const {
    playingPreviewId,
    isGeneratingPreview,
    stopAllPreviews,
    playVoicePreview,
    playLivePreview,
    preloadVoices,
  } = useVoicePreview();

  // Initialize edited values from user data
  useEffect(() => {
    if (user) {
      setEditedName(user.name || '');
      setEditedStyle(user.preferredStyle ? mapStyleToApp(user.preferredStyle) : null);
    }
  }, [user]);

  // Pre-cache audio when voice selection modal is shown
  useEffect(() => {
    if (isSelectingVoice && defaultVoices && defaultVoices.length > 0 && !isPreloading) {
      preloadAudioFiles();
    }
  }, [isSelectingVoice, defaultVoices]);

  const preloadAudioFiles = async () => {
    if (!defaultVoices || isPreloading) return;
    setIsPreloading(true);
    await preloadVoices(defaultVoices);
    setIsPreloading(false);
  };

  const handleSaveName = async () => {
    if (!userId || !editedName.trim()) {
      Alert.alert('Error', 'Name cannot be empty');
      return;
    }

    setIsLoading(true);
    try {
      await updateProfile({
        userId,
        name: editedName.trim(),
      });
      
      await saveUser({ 
        name: editedName.trim(), 
        style: editedStyle || 'Professional',
        voiceRecordingUri: user?.voiceRecordingUrl 
      });
      
      setIsEditingName(false);
      Alert.alert('Success', 'Name updated successfully');
    } catch (error) {
      console.error('Update name error:', error);
      Alert.alert('Error', 'Failed to update name');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelName = () => {
    setEditedName(user?.name || '');
    setIsEditingName(false);
  };

  const handleSaveStyle = async () => {
    if (!userId || !editedStyle) {
      Alert.alert('Error', 'Please select a style');
      return;
    }

    setIsLoading(true);
    try {
      await updateProfile({
        userId,
        preferredStyle: mapStyleToBackend(editedStyle),
      });
      
      await saveUser({ 
        name: editedName.trim() || user?.name || '', 
        style: editedStyle,
        voiceRecordingUri: user?.voiceRecordingUrl 
      });
      
      setIsEditingStyle(false);
      Alert.alert('Success', 'Style preference updated');
    } catch (error) {
      console.error('Update style error:', error);
      Alert.alert('Error', 'Failed to update style');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelStyle = () => {
    setEditedStyle(user?.preferredStyle ? mapStyleToApp(user.preferredStyle) : null);
    setIsEditingStyle(false);
  };

  const handleVoiceRecordingComplete = async (uri: string) => {
    if (!userId) {
      Alert.alert('Error', 'User not found');
      return;
    }

    setIsLoading(true);
    try {
      const storageId = await uploadFileToConvex(
        generateUploadUrl,
        uri,
        'audio/mp3'
      );

      await updateProfile({
        userId,
        voiceRecordingStorageId: storageId,
      });

      setIsEditingVoice(false);
      Alert.alert(
        'Success', 
        'Voice recording uploaded! Your voice clone is being created. This may take a few moments.'
      );
    } catch (error) {
      console.error('Voice upload error:', error);
      Alert.alert('Error', 'Failed to upload voice recording');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectVoice = async (voiceId: string) => {
    if (!userId) {
      Alert.alert('Error', 'User not found');
      return;
    }

    setIsLoading(true);
    try {
      await updateSelectedVoice({
        userId,
        voiceId,
      });
    } catch (error) {
      console.error('Select voice error:', error);
      Alert.alert('Error', 'Failed to select voice');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    if (Platform.OS === 'web') {
      if (window.confirm('Are you sure you want to logout?')) {
        try {
          await clearData();
          router.replace('/auth');
        } catch (error) {
          console.error('Logout error:', error);
          window.alert('Failed to logout. Please try again.');
        }
      }
      return;
    }

    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearData();
              router.replace('/auth');
            } catch (error) {
              console.error('Logout error:', error);
              Alert.alert('Error', 'Failed to logout. Please try again.');
            }
          },
        },
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'Are you sure you want to delete your account? This will permanently delete all your data including:\n\n• Your profile information\n• All your videos and projects\n• Your voice recordings\n• Your subscription and credits\n\nThis action cannot be undone.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Final Confirmation',
              'This is your last chance to cancel. Your account and all data will be permanently deleted.',
              [
                {
                  text: 'Keep Account',
                  style: 'cancel',
                },
                {
                  text: 'Delete Forever',
                  style: 'destructive',
                  onPress: async () => {
                    if (!userId) return;
                    
                    setIsLoading(true);
                    try {
                      const result = await deleteAccountAction({ userId });
                      
                      if (result.success) {
                        await clearData();
                        Alert.alert(
                          'Account Deleted',
                          'Your account has been permanently deleted.',
                          [
                            {
                              text: 'OK',
                              onPress: () => router.replace('/auth'),
                            },
                          ]
                        );
                      } else {
                        Alert.alert('Error', result.error || 'Failed to delete account. Please try again.');
                      }
                    } catch (error) {
                      console.error('Delete account error:', error);
                      Alert.alert('Error', 'Failed to delete account. Please try again.');
                    } finally {
                      setIsLoading(false);
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  const getCreditStatusText = () => {
    if (!videoGenerationStatus) return '';
    
    const { isPremium, subscriptionCreditsRemaining, purchasedCredits, totalCreditsRemaining } = videoGenerationStatus;
    
    if (isPremium) {
      return `${subscriptionCreditsRemaining} subscription + ${purchasedCredits || 0} bonus credits`;
    } else {
      return `${totalCreditsRemaining} credits remaining`;
    }
  };

  if (!userId) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Please log in to access settings</Text>
        </View>
      </View>
    );
  }

  if (!user) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.ember} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Close button */}
      <TouchableOpacity
        style={[styles.closeButton, { top: insets.top + 12 }]}
        onPress={() => router.back()}
        activeOpacity={0.7}
      >
        <X size={24} color={Colors.ink} strokeWidth={2} />
      </TouchableOpacity>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_HEIGHT }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Section */}
        <View style={styles.profileSection}>
          <View style={styles.profileAvatar}>
            <Text style={styles.profileAvatarText}>
              {(user.name || 'U').charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.profileName}>{user.name || 'User'}</Text>
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Menu Items */}
        <View style={styles.menuSection}>
          <TouchableOpacity
            testID="settingsCreditsButton"
            style={styles.menuItem}
            onPress={() => router.push('/paywall')}
            activeOpacity={0.7}
          >
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIconContainer, videoGenerationStatus?.isPremium ? styles.creditsIconContainer : styles.proIconContainer]}>
                {videoGenerationStatus?.isPremium ? (
                  <Gift size={22} color="#4CAF50" strokeWidth={2} />
                ) : (
                  <Crown size={22} color={Colors.ember} strokeWidth={2} />
                )}
              </View>
              <View>
                <Text style={styles.menuItemText}>
                  {videoGenerationStatus?.isPremium ? 'Buy More Credits' : 'Reelful Pro'}
                </Text>
                <Text style={styles.menuItemSubtext}>
                  {videoGenerationStatus?.isPremium 
                    ? getCreditStatusText() || 'Get extra video credits'
                    : 'Unlock premium features'
                  }
                </Text>
              </View>
            </View>
            <ChevronRight size={20} color={Colors.textSecondary} strokeWidth={2} />
          </TouchableOpacity>

          <TouchableOpacity
            testID="settingsAccountButton"
            style={styles.menuItem}
            onPress={() => setIsEditingName(true)}
            activeOpacity={0.7}
          >
            <View style={styles.menuItemLeft}>
              <View style={styles.menuIconContainer}>
                <User size={22} color={Colors.ink} strokeWidth={2} />
              </View>
              <Text style={styles.menuItemText}>Account</Text>
            </View>
            <ChevronRight size={20} color={Colors.textSecondary} strokeWidth={2} />
          </TouchableOpacity>

          {ENABLE_STYLE_PREFERENCE && (
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => setIsEditingStyle(true)}
              activeOpacity={0.7}
            >
              <View style={styles.menuItemLeft}>
                <View style={styles.menuIconContainer}>
                  <Palette size={22} color={Colors.ink} strokeWidth={2} />
                </View>
                <Text style={styles.menuItemText}>Content Preferences</Text>
              </View>
              <ChevronRight size={20} color={Colors.textSecondary} strokeWidth={2} />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            testID="settingsVoiceSettingsButton"
            style={styles.menuItem}
            onPress={() => setIsSelectingVoice(true)}
            activeOpacity={0.7}
          >
            <View style={styles.menuItemLeft}>
              <View style={styles.menuIconContainer}>
                <Headphones size={22} color={Colors.ink} strokeWidth={2} />
              </View>
              <Text style={styles.menuItemText}>Voice Settings</Text>
            </View>
            <ChevronRight size={20} color={Colors.textSecondary} strokeWidth={2} />
          </TouchableOpacity>

          <TouchableOpacity
            testID="settingsVoiceCloneButton"
            style={styles.menuItem}
            onPress={() => setIsEditingVoice(true)}
            activeOpacity={0.7}
          >
            <View style={styles.menuItemLeft}>
              <View style={styles.menuIconContainer}>
                <Mic size={22} color={Colors.ink} strokeWidth={2} />
              </View>
              <Text style={styles.menuItemText}>Voice Clone</Text>
            </View>
            <ChevronRight size={20} color={Colors.textSecondary} strokeWidth={2} />
          </TouchableOpacity>

          <TouchableOpacity
            testID="settingsAboutButton"
            style={styles.menuItem}
            onPress={() => setIsAboutOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.menuItemLeft}>
              <View style={styles.menuIconContainer}>
                <Info size={22} color={Colors.ink} strokeWidth={2} />
              </View>
              <Text style={styles.menuItemText}>About</Text>
            </View>
            <ChevronRight size={20} color={Colors.textSecondary} strokeWidth={2} />
          </TouchableOpacity>
        </View>

        {/* Logout Button */}
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.7}
        >
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>

        {/* Delete Account Button */}
        <View style={styles.deleteAccountContainer}>
          <TouchableOpacity
            style={styles.deleteAccountButton}
            onPress={handleDeleteAccount}
            activeOpacity={0.7}
            disabled={isLoading}
          >
            <Trash2 size={16} color={Colors.error} strokeWidth={2} />
            <Text style={styles.deleteAccountText}>Delete Account</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Edit Name Modal */}
      {isEditingName && (
        <View testID="accountModal" style={styles.editModalOverlay}>
          <View style={styles.editModalContent}>
            <View style={styles.editModalHeader}>
              <Text style={styles.editModalTitle}>Edit Name</Text>
              <TouchableOpacity
                testID="closeAccountModal"
                onPress={handleCancelName}
                activeOpacity={0.7}
                disabled={isLoading}
              >
                <X size={24} color={Colors.ink} strokeWidth={2} />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.editInput}
              value={editedName}
              onChangeText={setEditedName}
              placeholder="Enter your name"
              placeholderTextColor={Colors.grayLight}
              autoCapitalize="words"
              editable={!isLoading}
            />
            <TouchableOpacity
              onPress={handleSaveName}
              activeOpacity={0.7}
              disabled={isLoading}
            >
              <View
                style={[
                  styles.saveButton,
                  { backgroundColor: isLoading ? Colors.creamDark : Colors.ember }
                ]}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Text style={styles.saveButtonText}>Save</Text>
                )}
              </View>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Edit Style Modal */}
      {ENABLE_STYLE_PREFERENCE && isEditingStyle && (
        <View style={styles.editModalOverlay}>
          <View style={styles.editModalContent}>
            <View style={styles.editModalHeader}>
              <Text style={styles.editModalTitle}>Content Preferences</Text>
              <TouchableOpacity
                onPress={handleCancelStyle}
                activeOpacity={0.7}
                disabled={isLoading}
              >
                <X size={24} color={Colors.ink} strokeWidth={2} />
              </TouchableOpacity>
            </View>
            <View style={styles.styleOptions}>
              {STYLE_OPTIONS.map((style) => (
                <TouchableOpacity
                  key={style}
                  style={[
                    styles.styleOption,
                    editedStyle === style && styles.styleOptionSelected,
                  ]}
                  onPress={() => setEditedStyle(style)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.styleOptionText,
                      editedStyle === style && styles.styleOptionTextSelected,
                    ]}
                  >
                    {style}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              onPress={handleSaveStyle}
              activeOpacity={0.7}
              disabled={isLoading}
            >
              <View
                style={[
                  styles.saveButton,
                  { backgroundColor: isLoading ? Colors.creamDark : Colors.ember }
                ]}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Text style={styles.saveButtonText}>Save</Text>
                )}
              </View>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Voice Recording Modal */}
      {isEditingVoice && (
        <View testID="voiceCloneModal" style={styles.editModalOverlay}>
          <View style={styles.voiceCloneModalContent}>
            <View style={styles.voiceModalHeader}>
              <Text style={styles.editModalTitle}>Voice Clone</Text>
              <TouchableOpacity
                testID="closeVoiceCloneModal"
                onPress={() => setIsEditingVoice(false)}
                activeOpacity={0.7}
                disabled={isLoading}
              >
                <X size={24} color={Colors.ink} strokeWidth={2} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalDescription}>
              Record a sample to create your AI voice clone
            </Text>
            <VoiceRecorder
              onRecordingComplete={handleVoiceRecordingComplete}
              initialRecordingUri={user.voiceRecordingUrl}
              showScript={true}
              disabled={isLoading}
            />
          </View>
        </View>
      )}

      {/* Voice Selection Modal */}
      {isSelectingVoice && (
        <View testID="voiceSettingsModal" style={styles.editModalOverlay}>
          <View style={styles.voiceModalContent}>
            <View style={styles.editModalHeader}>
              <Text style={styles.editModalTitle}>Select Voice</Text>
              <TouchableOpacity
                testID="closeVoiceSettingsModal"
                onPress={() => { stopAllPreviews(); setIsSelectingVoice(false); }}
                activeOpacity={0.7}
              >
                <X size={24} color={Colors.ink} strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.voicesList}>
              {/* Custom Voice Option */}
              {user.elevenlabsVoiceId && (() => {
                const voiceId = user.elevenlabsVoiceId!;
                const isPlaying = playingPreviewId === voiceId;
                const isLoading_ = isPlaying && isGeneratingPreview;
                const hasStoredPreview = !!clonePreviewUrl;
                return (
                  <TouchableOpacity
                    style={[
                      styles.voiceOption,
                      user.selectedVoiceId === voiceId && styles.voiceOptionSelected,
                    ]}
                    onPress={() => handleSelectVoice(voiceId)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.voiceOptionContent}>
                      <Headphones size={24} color={Colors.ember} strokeWidth={2} />
                      <View style={styles.voiceOptionText}>
                        <Text style={styles.voiceOptionName}>
                          {user.name ? `${user.name}'s Voice` : 'Your Voice'}
                        </Text>
                        <Text style={styles.voiceOptionDesc}>Custom AI voice clone</Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.previewButton,
                        isPlaying && styles.previewButtonPlaying,
                      ]}
                      onPress={() => {
                        if (hasStoredPreview) {
                          playVoicePreview(voiceId, clonePreviewUrl!);
                        } else {
                          playLivePreview(voiceId);
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

              {/* Default Voices */}
              {defaultVoices?.map((voice: any) => {
                const isPlaying = playingPreviewId === voice.voiceId;
                
                return (
                  <TouchableOpacity
                    key={voice._id}
                    style={[
                      styles.voiceOption,
                      user.selectedVoiceId === voice.voiceId && styles.voiceOptionSelected,
                    ]}
                    onPress={() => handleSelectVoice(voice.voiceId)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.voiceOptionContent}>
                      <Volume2 size={24} color={Colors.ember} strokeWidth={2} />
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
            </ScrollView>
          </View>
        </View>
      )}

      {/* About Modal */}
      {isAboutOpen && (
        <View testID="aboutModal" style={styles.editModalOverlay}>
          <View style={styles.editModalContent}>
            <View style={styles.editModalHeader}>
              <Text style={styles.editModalTitle}>About Reelful</Text>
              <TouchableOpacity
                testID="closeAboutModal"
                onPress={() => setIsAboutOpen(false)}
                activeOpacity={0.7}
              >
                <X size={24} color={Colors.ink} strokeWidth={2} />
              </TouchableOpacity>
            </View>
            <View style={styles.aboutContent}>
              <Text style={styles.aboutDescription}>
                Upload your photos and videos with a short description and get a ready-to-share clip in minutes.
              </Text>
              <Text style={styles.aboutDescription}>
                Transform your memories into engaging content effortlessly.
              </Text>
              <View style={styles.madeWithLove}>
                <Text style={styles.madeWithLoveText}>Made with love </Text>
                <Text style={styles.orangeHeart}>🧡</Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  closeButton: {
    position: 'absolute',
    left: 16,
    zIndex: 10,
    padding: 8,
  },
  content: {
    paddingTop: 24,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  // Profile Section
  profileSection: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 48,
    paddingBottom: 24,
  },
  profileAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.ember,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  profileAvatarText: {
    fontSize: 28,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  profileName: {
    fontSize: 24,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    fontWeight: '600',
  },
  // Divider
  divider: {
    height: 1,
    backgroundColor: Colors.creamDark,
    marginBottom: 8,
  },
  // Menu Section
  menuSection: {
    paddingHorizontal: 24,
    marginBottom: 32,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.creamDark,
  },
  menuItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  menuIconContainer: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuItemText: {
    fontSize: 16,
    color: Colors.ink,
    fontFamily: Fonts.regular,
  },
  menuItemSubtext: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontFamily: Fonts.regular,
    marginTop: 2,
  },
  proIconContainer: {
    backgroundColor: 'rgba(243, 106, 63, 0.12)',
    borderRadius: 8,
  },
  creditsIconContainer: {
    backgroundColor: 'rgba(76, 175, 80, 0.12)',
    borderRadius: 8,
  },
  // Logout
  logoutButton: {
    marginHorizontal: 24,
    paddingVertical: 5,
    alignItems: 'center',
  },
  logoutText: {
    fontSize: 16,
    color: Colors.error,
    fontFamily: Fonts.regular,
  },
  // Delete Account
  deleteAccountContainer: {
    paddingHorizontal: 24,
    paddingBottom: 32,
    paddingTop: 16,
    marginTop: 115,
    borderTopWidth: 1,
    borderTopColor: Colors.creamDark,
  },
  deleteAccountButton: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  deleteAccountText: {
    fontSize: 13,
    color: Colors.error,
    fontFamily: Fonts.regular,
  },
  // Edit Modals
  editModalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  editModalContent: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 400,
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  editModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  editModalTitle: {
    fontSize: 20,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    fontWeight: '600',
  },
  editInput: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: Colors.ink,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: Colors.creamDark,
  },
  saveButton: {
    borderRadius: 100,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  saveButtonText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.white,
    fontWeight: '600',
  },
  // Style Options
  styleOptions: {
    gap: 12,
    marginBottom: 24,
  },
  styleOption: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  styleOptionSelected: {
    borderColor: Colors.ember,
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
  },
  styleOptionText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    textAlign: 'center',
  },
  styleOptionTextSelected: {
    color: Colors.ember,
    fontWeight: '600',
  },
  // Voice Modal
  voiceModalContent: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    width: '92%',
    maxHeight: '92%',
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  voiceCloneModalContent: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
    width: '92%',
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  voiceModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalDescription: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginBottom: 12,
    textAlign: 'center',
  },
  voicesList: {
    maxHeight: 400,
  },
  voiceOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  voiceOptionSelected: {
    borderColor: Colors.ember,
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
  },
  voiceOptionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  voiceOptionText: {
    flex: 1,
  },
  voiceOptionTextContainer: {
    flex: 1,
  },
  voiceOptionName: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    marginBottom: 4,
  },
  voiceOptionDesc: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
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
  // About Modal
  aboutContent: {
    paddingVertical: 8,
  },
  aboutDescription: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    lineHeight: 24,
    marginBottom: 16,
  },
  madeWithLove: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.creamDark,
  },
  madeWithLoveText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  orangeHeart: {
    fontSize: 18,
  },
});
