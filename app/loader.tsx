import { useLocalSearchParams, useRouter } from 'expo-router';
import { Sparkles } from 'lucide-react-native';
import { useEffect, useRef, useState, memo } from 'react';
import { Animated, StyleSheet, Text, View, Alert, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { Fonts } from '@/constants/typography';

export default function LoaderScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ projectId: string }>();
  const projectId = params.projectId as any;

  // Get project data
  const project = useQuery(api.tasks.getProject, projectId ? { id: projectId } : "skip");
  const renderVideo = useAction(api.render.renderVideo);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const renderTriggeredRef = useRef(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Timer effect - optimized to prevent unnecessary re-renders
  useEffect(() => {
    if (project?.submittedAt) {
      // Clear any existing timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      
      // Update immediately
      const elapsed = Math.floor((Date.now() - project.submittedAt) / 1000);
      setElapsedSeconds(elapsed);
      
      // Then update every second
      timerRef.current = setInterval(() => {
        const newElapsed = Math.floor((Date.now() - project.submittedAt) / 1000);
        setElapsedSeconds(newElapsed);
      }, 1000);
      
      return () => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      };
    } else {
      setElapsedSeconds(0);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [project?.submittedAt]);

  // Auto-trigger render when ALL media assets are ready (matches studio page logic)
  useEffect(() => {
    if (!project || !projectId) {
      return;
    }

    // Check if all required media assets are ready
    const hasAllMediaAssets = !!(
      project.audioUrl && 
      project.musicUrl
    );

    console.log('[loader] Asset check:', {
      hasAudio: !!project.audioUrl,
      hasMusic: !!project.musicUrl,
      hasAnimations: !!(project.videoUrls && project.videoUrls.length > 0),
      animationCount: project.videoUrls?.length || 0,
      status: project.status,
      hasRenderedVideoUrl: !!project.renderedVideoUrl,
      hasRenderProgress: !!project.renderProgress,
      renderTriggered: renderTriggeredRef.current,
    });

    // Only trigger render when status is completed AND all media assets exist
    if (
      project.status === "completed" && 
      hasAllMediaAssets &&
      !project.renderedVideoUrl && 
      !project.renderProgress && 
      !renderTriggeredRef.current
    ) {
      console.log('[loader] ✅ All media assets ready! Triggering render...');
      console.log('[loader]   - audioUrl:', project.audioUrl ? "✓" : "✗");
      console.log('[loader]   - musicUrl:', project.musicUrl ? "✓" : "✗");
      console.log('[loader]   - videoUrls:', project.videoUrls?.length || 0, "videos");
      
      renderTriggeredRef.current = true;
      
      renderVideo({ projectId })
        .then((result) => {
          if (!result?.success) {
            console.log('[loader] Render not started:', result?.message || 'Unknown reason');
            // Don't show error - this is likely due to duplicate render prevention
            // The render is either already in progress or already completed
          }
        })
        .catch((error) => {
          console.error('[loader] render error:', error);
          Alert.alert('Error', `Render failed: ${error}`);
          renderTriggeredRef.current = false; // Reset on error so user can retry
        });
    } else if (project.status === "completed" && !hasAllMediaAssets && !renderTriggeredRef.current) {
      console.log('[loader] ⏳ Waiting for all media assets...');
      console.log('[loader]   - audioUrl:', project.audioUrl ? "✓" : "✗");
      console.log('[loader]   - musicUrl:', project.musicUrl ? "✓" : "✗");
      console.log('[loader]   - videoUrls:', project.videoUrls?.length || 0, "videos");
    }
  }, [project, projectId, renderVideo]);

  // Check if video is ready or if render failed
  useEffect(() => {
    if (project?.renderedVideoUrl) {
      console.log('[loader] Video ready, navigating to result');
      router.replace({
        pathname: '/result',
        params: { projectId: projectId.toString() },
      });
    } else if (project?.status === 'failed') {
      const errorMessage = project.error || 'Video generation failed. Please try again.';
      console.error('[loader] Render failed:', errorMessage);
      
      // Extract a user-friendly error message
      let friendlyMessage = errorMessage;
      if (errorMessage.includes('delayRender') || errorMessage.includes('timeout')) {
        friendlyMessage = 'Render timed out. This usually happens when processing takes too long. Please try again with fewer or smaller media files.';
      } else if (errorMessage.includes('exit status 1')) {
        friendlyMessage = 'Render failed during video processing. Please try again.';
      }
      
      Alert.alert(
        'Render Failed',
        friendlyMessage,
        [
          {
            text: 'Go to Feed',
            onPress: () => router.replace('/(tabs)'),
            style: 'default',
          },
        ],
        { cancelable: false }
      );
    }
  }, [project?.renderedVideoUrl, project?.status, project?.error, projectId, router]);

  // Single smooth rotation animation - simplified for better performance
  useEffect(() => {
    // Reset animation value
    rotateAnim.setValue(0);
    
    // Start smooth continuous rotation
    Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 2000, // Smoother, faster rotation
        useNativeDriver: true,
        isInteraction: false, // Don't block interactions
      })
    ).start();
  }, [rotateAnim]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const rotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  if (!projectId) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No project ID</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[Colors.cream, Colors.creamMedium, Colors.cream]}
        style={styles.gradient}
      >
        <Animated.View
          style={[
            styles.iconContainer,
            {
              transform: [{ rotate }],
            },
          ]}
        >
          <Sparkles size={60} color={Colors.ember} strokeWidth={2} />
        </Animated.View>

        <Text style={styles.title}>Creating your reel</Text>
        <Text style={styles.subtitle}>This will only take a moment...</Text>

        <View style={styles.timerContainer}>
          <Text style={styles.timerLabel}>Time elapsed</Text>
          <Text style={styles.timerText}>{formatTime(elapsedSeconds)}</Text>
        </View>

        {(project?.generationProgress || project?.renderProgress) && (
          <Text style={styles.progressText}>
            {project.renderProgress || project.generationProgress}
          </Text>
        )}
        
        {project?.renderStep && (
          <Text style={styles.progressText}>
            Step: {project.renderStep}
            {project.renderStep === 'failed' && project.error && (
              <Text style={styles.errorText}> - {project.error}</Text>
            )}
          </Text>
        )}

        {project?.status === 'failed' && project?.error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Render Failed</Text>
            <Text style={styles.errorMessage}>
              {project.error.includes('delayRender') || project.error.includes('timeout')
                ? 'Render timed out. This usually happens when processing takes too long. Please try again with fewer or smaller media files.'
                : project.error.includes('exit status 1')
                ? 'Render failed during video processing. Please try again.'
                : project.error}
            </Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => router.replace('/(tabs)')}
              activeOpacity={0.7}
            >
              <Text style={styles.retryButtonText}>Go to Feed</Text>
            </TouchableOpacity>
          </View>
        )}
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  gradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  iconContainer: {
    marginBottom: 32,
    padding: 24,
    borderRadius: 100,
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
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
    marginBottom: 48,
    textAlign: 'center',
  },
  timerContainer: {
    width: '100%',
    alignItems: 'center',
    marginTop: 24,
  },
  timerLabel: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginBottom: 8,
  },
  timerText: {
    fontSize: 48,
    fontFamily: Fonts.medium,
    color: Colors.ember,
    fontVariant: ['tabular-nums'],
  },
  progressText: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 16,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 16,
    color: Colors.ink,
  },
  errorContainer: {
    marginTop: 32,
    padding: 20,
    backgroundColor: 'rgba(220, 38, 38, 0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(220, 38, 38, 0.3)',
    width: '100%',
    alignItems: 'center',
  },
  errorTitle: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.error,
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 16,
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
});
