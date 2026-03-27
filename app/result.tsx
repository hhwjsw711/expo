import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, Download, Copy, RefreshCw } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { VideoView, useVideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { Fonts } from '@/constants/typography';

export default function ResultScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ projectId: string }>();
  const projectId = params.projectId as any;
  const { addVideo } = useApp();
  const [isSaved, setIsSaved] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Get project data
  const project = useQuery(api.tasks.getProject, projectId ? { id: projectId } : "skip");
  
  // Mutation for regenerating project editing
  const regenerateProjectEditing = useMutation(api.tasks.regenerateProjectEditing);

  console.log('Result screen project:', project);
  console.log('Result screen script available:', !!project?.script);

  // Swipe down gesture to go to feed
  const panGesture = Gesture.Pan()
    .onEnd((event) => {
      // If swiped down (positive Y velocity) and moved more than 100 pixels
      if (event.velocityY > 500 || event.translationY > 150) {
        handleGoHome();
      }
    });

  const videoUrl = project?.renderedVideoUrl;

  const videoPlayer = useVideoPlayer(
    videoUrl || null,
    (player) => {
      if (player && videoUrl) {
        player.loop = true;
        player.muted = false;
        player.play();
      }
    }
  );

  useEffect(() => {
    const handleSaveToFeed = async () => {
      if (!project || !videoUrl || isSaved) return;

      // Transform script: replace "???" with "?"
      const transformedScript = project.script?.replace(/\?\?\?/g, '?');

      const video = {
        id: project._id,
        uri: videoUrl,
        prompt: project.prompt,
        script: transformedScript,
        createdAt: project.createdAt,
        status: 'ready' as const,
        projectId: project._id,
      };

      await addVideo(video);
      setIsSaved(true);
    };

    handleSaveToFeed();
  }, [project, videoUrl, isSaved, addVideo]);

  const handleDownload = async () => {
    if (!videoUrl || isDownloading) return;

    try {
      setIsDownloading(true);

      const { status, accessPrivileges } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Permission Required',
          'Please grant media library permissions to download videos.'
        );
        return;
      }

      if (Platform.OS === 'web') {
        const link = document.createElement('a');
        link.href = videoUrl;
        link.download = `reelfull_${Date.now()}.mp4`;
        link.click();
      } else {
        const fileUri = `${FileSystem.documentDirectory}reelfull_${Date.now()}.mp4`;
        
        // Download from URL
        const downloadResult = await FileSystem.downloadAsync(videoUrl, fileUri);
        
        if (downloadResult.status === 200) {
          const asset = await MediaLibrary.createAssetAsync(downloadResult.uri);
          
          // Try to create album, but don't fail if it doesn't work (e.g., limited access)
          try {
            await MediaLibrary.createAlbumAsync('Reelful', asset, false);
          } catch (albumError) {
            // Album creation can fail with limited access, but the asset is still saved
            console.log('[Download] Album creation skipped (limited access):', albumError);
          }
          
          Alert.alert('Success', 'Video saved to your gallery!');
        } else {
          throw new Error('Download failed');
        }
      }
    } catch (error) {
      console.error('Download error:', error);
      Alert.alert('Error', 'Failed to download video. Please try again.');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopyScript = async () => {
    if (!project?.script) return;

    try {
      // Transform script: replace "???" with "?"
      const transformedScript = project.script.replace(/\?\?\?/g, '?');
      
      await Clipboard.setStringAsync(transformedScript);
      setIsCopied(true);
      
      // Reset the copied state after 2 seconds
      setTimeout(() => {
        setIsCopied(false);
      }, 2000);
    } catch (error) {
      console.error('Copy error:', error);
      Alert.alert('Error', 'Failed to copy script. Please try again.');
    }
  };

  const handleRegenerate = async () => {
    if (!projectId || !project || isRegenerating) return;

    setIsRegenerating(true);
    try {
      console.log('[result] Regenerating project editing for:', projectId);
      
      // Call the backend to create a new project with same assets but regenerated editing
      const result = await regenerateProjectEditing({
        sourceProjectId: projectId,
      });

      if (result.success && result.newProjectId) {
        console.log('[result] New project created:', result.newProjectId);
        
        // Optimistically add the new video to the feed with processing status
        const transformedScript = project.script?.replace(/\?\?\?/g, '?');
        addVideo({
          id: result.newProjectId,
          uri: '',
          prompt: project.prompt,
          script: transformedScript,
          createdAt: Date.now(),
          status: 'processing',
          projectId: result.newProjectId,
          thumbnailUrl: project.thumbnailUrl,
        });

        // Navigate to feed to see the new generating video
        router.replace('/(tabs)');
      } else {
        throw new Error('Failed to create regenerated project');
      }
    } catch (error) {
      console.error('[result] Regenerate error:', error);
      
      // Check for specific error types
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('FREE_TIER_LIMIT_REACHED') || errorMessage.includes('NO_CREDITS_AVAILABLE')) {
        // Show paywall for users who have run out of credits
        router.push('/paywall');
      } else {
        Alert.alert('Error', 'Failed to regenerate video. Please try again.');
      }
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleGoHome = () => {
    router.replace('/(tabs)');
  };

  if (!projectId) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: Colors.cream, fontSize: 18 }}>Error: No project ID</Text>
        <TouchableOpacity
          style={{ marginTop: 20, padding: 16, backgroundColor: Colors.ember, borderRadius: 100 }}
          onPress={() => router.replace('/(tabs)')}
        >
          <Text style={{ color: Colors.cream, fontFamily: Fonts.medium }}>Go to Feed</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!project) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={Colors.ember} />
        <Text style={{ color: Colors.cream, fontSize: 18, marginTop: 16 }}>Loading...</Text>
      </View>
    );
  }

  if (!videoUrl) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: Colors.cream, fontSize: 18 }}>Video not ready yet</Text>
        <TouchableOpacity
          style={{ marginTop: 20, padding: 16, backgroundColor: Colors.ember, borderRadius: 100 }}
          onPress={() => router.replace('/(tabs)')}
        >
          <Text style={{ color: Colors.cream, fontFamily: Fonts.medium }}>Go to Feed</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <GestureDetector gesture={panGesture}>
      <View style={styles.container}>
        <VideoView
          player={videoPlayer}
          style={styles.video}
          contentFit="cover"
          nativeControls={false}
        />

        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.8)', Colors.dark]}
          style={[styles.overlay, { paddingBottom: insets.bottom + 20 }]}
        >
          <View style={styles.content}>
            <View style={styles.header}>
              <Check size={32} color={Colors.ember} strokeWidth={3} />
              <Text style={styles.title}>Your reel is ready!</Text>
            </View>

            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={handleCopyScript}
                disabled={!project?.script}
                activeOpacity={0.8}
              >
                {isCopied ? (
                  <Check size={24} color={Colors.ember} strokeWidth={2} />
                ) : (
                  <Copy size={24} color={Colors.cream} strokeWidth={2} />
                )}
                <Text style={[
                  styles.secondaryButtonText,
                  isCopied && { color: Colors.ember }
                ]}>
                  {isCopied ? 'Copied!' : 'Copy Script'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={handleDownload}
                disabled={isDownloading}
                activeOpacity={0.8}
              >
                <Download size={24} color={Colors.cream} strokeWidth={2} />
                <Text style={styles.secondaryButtonText}>
                  {isDownloading ? 'Downloading...' : 'Download'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.regenerateButton}
                onPress={handleRegenerate}
                disabled={isRegenerating}
                activeOpacity={0.8}
              >
                {isRegenerating ? (
                  <ActivityIndicator size="small" color={Colors.ember} />
                ) : (
                  <RefreshCw size={24} color={Colors.ember} strokeWidth={2} />
                )}
                <Text style={styles.regenerateButtonText}>
                  {isRegenerating ? 'Regenerating...' : 'Regenerate'}
                </Text>
              </TouchableOpacity>
            </View>

            {isSaved && (
              <View style={styles.savedBadge}>
                <Check size={16} color={Colors.ember} strokeWidth={3} />
                <Text style={styles.savedText}>Saved to feed</Text>
              </View>
            )}
          </View>
        </LinearGradient>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.dark,
  },
  video: {
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 100,
  },
  content: {
    paddingHorizontal: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontFamily: Fonts.medium,
    color: Colors.cream,
    marginTop: 16,
    marginBottom: 4,
    textAlign: 'center',
  },
  actions: {
    gap: 12,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: Colors.darkElevated,
    borderRadius: 100,
    padding: 18,
    borderWidth: 2,
    borderColor: Colors.darkSurface,
  },
  secondaryButtonText: {
    fontSize: 18,
    fontFamily: Fonts.regular,
    color: Colors.cream,
  },
  regenerateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: 'rgba(243, 106, 63, 0.15)',
    borderRadius: 100,
    padding: 18,
    borderWidth: 2,
    borderColor: Colors.ember,
  },
  regenerateButtonText: {
    fontSize: 18,
    fontFamily: Fonts.regular,
    color: Colors.ember,
  },
  savedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    padding: 12,
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(243, 106, 63, 0.3)',
  },
  savedText: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.ember,
  },
});
