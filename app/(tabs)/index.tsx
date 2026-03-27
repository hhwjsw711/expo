import { useRouter } from 'expo-router';
import { Loader2, AlertCircle, FileText, Zap, Clock, Calendar, Plus , Trash2 } from 'lucide-react-native';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Dimensions,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
  Animated,
  RefreshControl,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';
import { useApp } from '@/contexts/AppContext';
import { usePaywall } from '@/contexts/PaywallContext';
import { Video as VideoType } from '@/types';
import { useVideoPolling, registerForPushNotificationsAsync } from '@/lib/videoPollingService';
import { Fonts } from '@/constants/typography';
import { getScreenDimensions } from '@/lib/dimensions';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenDimensions();
const ITEM_SPACING = 12;
const ITEM_WIDTH = (SCREEN_WIDTH - ITEM_SPACING * 3) / 2;
const THUMBNAIL_HEIGHT = ITEM_WIDTH * 1.4; // Thumbnail aspect ratio
const CARD_HEIGHT = THUMBNAIL_HEIGHT + 47; // Extra space for metadata below
const ACTION_SHEET_HEIGHT = 44; // Approximate height of the delete button

// Bottom padding to account for the FAB
const FAB_BOTTOM_PADDING = 100;

// Height of the floating segmented tab control
const SEGMENTED_TAB_HEIGHT = 60;

// Helper function to format duration (seconds to "M:SS" format)
const formatDuration = (seconds?: number): string | null => {
  if (seconds === undefined || seconds === null) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// Helper function to format date ("Jan 12" for current year, "Jan 12, 2024" for other years)
const formatVideoDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const currentYear = now.getFullYear();
  const videoYear = date.getFullYear();
  
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate();
  
  if (videoYear === currentYear) {
    return `${month} ${day}`;
  } else {
    return `${month} ${day}, ${videoYear}`;
  }
};

function VideoThumbnail({ 
  item, 
  onPress, 
  onLongPress,
  isSelected
}: { 
  item: VideoType; 
  onPress: () => void;
  onLongPress: (event: any) => void;
  isSelected: boolean;
}) {
  const router = useRouter();
  const spinAnim = useRef(new Animated.Value(0)).current;
  const thumbnailRef = useRef<View>(null);
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const lastPressTimeRef = useRef<number>(0);
  
  const formattedDuration = formatDuration(item.duration);
  const formattedDate = formatVideoDate(item.createdAt);

  const isImageUrl = (url?: string) => {
    if (!url) return false;
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const videoExtensions = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
    const lowerUrl = url.toLowerCase();
    
    if (videoExtensions.some(ext => lowerUrl.includes(ext))) {
      return false;
    }
    
    if (lowerUrl.includes('convex.cloud/api/storage/')) {
      return true;
    }
    
    return imageExtensions.some(ext => lowerUrl.includes(ext));
  };

  const effectiveThumbnailUrl = isImageUrl(item.thumbnailUrl) ? item.thumbnailUrl : undefined;
  const shouldUseVideoPreview = !effectiveThumbnailUrl && item.uri && item.status === 'ready';

  const thumbnailPlayer = useVideoPlayer(
    shouldUseVideoPreview ? item.uri : null,
    (player) => {
      if (player && shouldUseVideoPreview) {
        player.muted = true;
      }
    }
  );

  useEffect(() => {
    const urlType = item.thumbnailUrl 
      ? (isImageUrl(item.thumbnailUrl) ? 'image' : 'video/other') 
      : 'missing';
    const displayText = item.name || item.prompt;
    console.log(`[Thumbnail] ${displayText}: status=${item.status}, thumbnailUrl=${urlType}, using=${effectiveThumbnailUrl ? 'image' : (shouldUseVideoPreview ? 'video' : 'placeholder')}`);
  }, [item.thumbnailUrl, item.status, item.name, item.prompt, effectiveThumbnailUrl, shouldUseVideoPreview]);

  const handleLongPress = (event: any) => {
    if (thumbnailRef.current) {
      thumbnailRef.current.measure((x, y, width, height, pageX, pageY) => {
        onLongPress({ pageX, pageY, width, height });
      });
    }
  };

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: isSelected ? 1.05 : 1,
      useNativeDriver: true,
      tension: 100,
      friction: 8,
    }).start();
  }, [isSelected, scaleAnim]);

  useEffect(() => {
    if (item.status === 'pending' || item.status === 'processing' || item.status === 'preparing') {
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

      return () => {
        animation.stop();
      };
    }
  }, [item.status, spinAnim]);

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Render thumbnail content based on status
  const renderThumbnailContent = () => {
    if (item.status === 'draft') {
      if (effectiveThumbnailUrl) {
        return (
          <>
            <Image
              source={effectiveThumbnailUrl}
              style={styles.thumbnail}
              contentFit="cover"
              cachePolicy="disk"
              transition={200}
            />
            <LinearGradient
              colors={['#FFEEE8', "#FAF9F5"]}
              locations={[0, 1]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.draftOverlay}
            >
              <FileText size={28} color={Colors.ink} strokeWidth={2} />
              <Text style={styles.draftTextPlaceholder}>Draft</Text>
            </LinearGradient>
          </>
        );
      }
      return (
        <LinearGradient
          colors={['#FFEEE8', Colors.creamLight]}
          locations={[0, 1]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.draftThumbnail}
        >
          <FileText size={28} color={Colors.ink} strokeWidth={2} />
          <Text style={styles.draftTextPlaceholder}>Draft</Text>
        </LinearGradient>
      );
    }

    if (item.status === 'pending' || item.status === 'processing' || item.status === 'preparing') {
      const statusText = item.status === 'pending'
        ? 'Queued...'
        : item.status === 'preparing'
          ? 'Preparing...'
          : 'Generating...';

      if (effectiveThumbnailUrl) {
        return (
          <>
            <Image
              source={effectiveThumbnailUrl}
              style={styles.thumbnail}
              contentFit="cover"
              cachePolicy="disk"
              transition={200}
            />
            <View style={styles.processingOverlay}>
              <Animated.View style={{ transform: [{ rotate: spin }] }}>
                <Loader2 size={32} color={Colors.ember} strokeWidth={2} />
              </Animated.View>
              <Text style={styles.processingText}>{statusText}</Text>
              <Text style={styles.processingHintTextOverlay}>Takes a couple of minutes.{'\n'}You can leave the app.</Text>
            </View>
          </>
        );
      }
      return (
        <View style={styles.processingThumbnail}>
          <Animated.View style={{ transform: [{ rotate: spin }] }}>
            <Loader2 size={32} color={Colors.ember} strokeWidth={2} />
          </Animated.View>
          <Text style={styles.processingText}>{statusText}</Text>
          <Text style={styles.processingHintText}>Takes a couple of minutes.{'\n'}You can leave the app.</Text>
        </View>
      );
    }

    if (item.status === 'failed') {
      if (effectiveThumbnailUrl) {
        return (
          <>
            <Image
              source={effectiveThumbnailUrl}
              style={styles.thumbnail}
              contentFit="cover"
              cachePolicy="disk"
              transition={200}
            />
            <View style={styles.errorOverlay}>
              <AlertCircle size={28} color={Colors.white} strokeWidth={2} />
              <Text style={styles.errorText}>Failed</Text>
            </View>
          </>
        );
      }
      return (
        <View style={styles.errorThumbnail}>
          <AlertCircle size={28} color={Colors.error} strokeWidth={2} />
          <Text style={styles.errorText}>Failed</Text>
        </View>
      );
    }

    // Ready status
    if (effectiveThumbnailUrl) {
      return (
        <Image
          source={effectiveThumbnailUrl}
          style={styles.thumbnail}
          contentFit="cover"
          cachePolicy="disk"
          transition={200}
        />
      );
    }
    if (shouldUseVideoPreview) {
      return (
        <VideoView
          player={thumbnailPlayer}
          style={styles.thumbnail}
          contentFit="cover"
          nativeControls={false}
        />
      );
    }
    return (
      <View style={styles.noThumbnailContainer}>
        <Text style={styles.noThumbnailText}>No Thumbnail</Text>
      </View>
    );
  };

  // Handle press based on status with double-tap prevention
  const handlePress = () => {
    const now = Date.now();
    // Prevent double-tap by ignoring presses within 500ms of the last press
    if (now - lastPressTimeRef.current < 500) {
      return;
    }
    lastPressTimeRef.current = now;
    
    if (item.status === 'failed') {
      if (item.projectId) {
        // Navigate to chat composer so user can retry
        router.push({
          pathname: '/chat-composer',
          params: { projectId: item.projectId },
        });
      } else {
        Alert.alert('Generation Failed', item.error || 'Video generation failed. Please try again.');
      }
      return;
    }
    // Allow tapping on processing/pending videos to view generation progress
    onPress();
  };

  return (
    <Animated.View
      ref={thumbnailRef}
      style={[
        styles.cardContainer,
        {
          transform: [{ scale: scaleAnim }],
          zIndex: isSelected ? 1000 : 1,
        }
      ]}
      collapsable={false}
    >
      <TouchableOpacity
        style={styles.cardTouchable}
        onPress={handlePress}
        onLongPress={handleLongPress}
        activeOpacity={0.9}
        delayLongPress={500}
      >
        {/* Thumbnail Card */}
        <View style={styles.thumbnailCard}>
          {renderThumbnailContent()}
          {isSelected && <View style={styles.selectedBorder} />}
        </View>

        {/* Metadata Section - Outside the thumbnail */}
        <View style={styles.metadataContainer}>
          <Text style={styles.cardTitle} numberOfLines={1} ellipsizeMode="tail">
            {item.name || item.prompt}
          </Text>
          <View style={styles.metadataRow}>
            {formattedDuration && (
              <View style={styles.metadataItem}>
                <Clock size={12} color={Colors.textSecondary} strokeWidth={2} />
                <Text style={styles.metadataText}>{formattedDuration}</Text>
              </View>
            )}
            <View style={styles.metadataItem}>
              <Calendar size={12} color={Colors.textSecondary} strokeWidth={2} />
              <Text style={styles.metadataText}>{formattedDate}</Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function FeedTab() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { videos, deleteVideo, userId, syncedFromBackend, syncVideosFromBackend, syncUserFromBackend } = useApp();
  const { subscriptionState, hasCompletedPaywallThisSession } = usePaywall();
  const [actionSheetVideo, setActionSheetVideo] = useState<VideoType | null>(null);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [actionSheetPosition, setActionSheetPosition] = useState({ pageX: 0, pageY: 0, width: 0, height: 0, columnIndex: 0 });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'projects' | 'drafts'>('projects');
  const tabIndicatorAnim = useRef(new Animated.Value(0)).current;
  const navigationLockRef = useRef<{ key: string; startedAt: number } | null>(null);
  
  const hasPendingVideos = useMemo(() =>
    videos.some(v => v.status === 'pending' || v.status === 'processing' || v.status === 'preparing'),
    [videos]
  );
  
  const backendUser = useQuery(
    api.users.getCurrentUser,
    userId ? { userId } : "skip"
  );
  
  const backendProjects = useQuery(
    api.tasks.getProjects,
    userId ? { userId } : "skip"
  );
  
  const deleteProjectMutation = useMutation(api.tasks.deleteProject);
  const getFreshVideoUrl = useAction(api.tasks.getFreshProjectVideoUrl);
  
  const videoGenerationStatus = useQuery(
    api.users.getVideoGenerationStatus,
    userId ? { userId } : "skip"
  );

  useEffect(() => {
    if (backendUser && userId) {
      console.log('[feed] Syncing user profile from backend');
      syncUserFromBackend(backendUser);
    }
  }, [backendUser, userId, syncUserFromBackend]);

  useEffect(() => {
    if (backendProjects && userId) {
      console.log('[feed] Backend projects updated, syncing...', backendProjects.length, 'projects');
      syncVideosFromBackend(backendProjects);
      if (isRefreshing) {
        setIsRefreshing(false);
      }
    }
  }, [backendProjects, userId, syncVideosFromBackend, isRefreshing]);

  const sortedVideos = useMemo(() => {
    return [...videos].sort((a, b) => b.createdAt - a.createdAt);
  }, [videos]);

  // Pre-filter videos for both tabs (not dependent on activeTab to prevent re-renders)
  const projectVideos = useMemo(() => {
    return sortedVideos.filter(v => v.status !== 'draft');
  }, [sortedVideos]);

  const draftVideos = useMemo(() => {
    return sortedVideos.filter(v => v.status === 'draft');
  }, [sortedVideos]);

  // Animate tab indicator when tab changes
  useEffect(() => {
    Animated.spring(tabIndicatorAnim, {
      toValue: activeTab === 'projects' ? 0 : 1,
      useNativeDriver: true,
      tension: 300,
      friction: 30,
    }).start();
  }, [activeTab, tabIndicatorAnim]);

  const handleRefresh = useCallback(() => {
    console.log('[feed] User initiated refresh');
    setIsRefreshing(true);
  }, []);
  
  useVideoPolling();

  useEffect(() => {
    registerForPushNotificationsAsync();
  }, []);

  const actionSheetBackdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (showActionSheet) {
      actionSheetBackdropOpacity.setValue(0);
      
      Animated.timing(actionSheetBackdropOpacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
    }
  }, [showActionSheet, actionSheetBackdropOpacity]);

  const closeActionSheet = () => {
    Animated.timing(actionSheetBackdropOpacity, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(() => {
      setShowActionSheet(false);
      setActionSheetVideo(null);
      actionSheetBackdropOpacity.setValue(0);
    });
  };

  const tryAcquireNavigationLock = useCallback((key: string) => {
    const now = Date.now();
    const lock = navigationLockRef.current;
    // Keep lock long enough to survive laggy async work before push.
    if (lock && now - lock.startedAt < 3500) {
      return false;
    }
    navigationLockRef.current = { key, startedAt: now };
    return true;
  }, []);

  const releaseNavigationLock = useCallback((key: string, delayMs = 0) => {
    const unlock = () => {
      if (navigationLockRef.current?.key === key) {
        navigationLockRef.current = null;
      }
    };
    if (delayMs > 0) {
      setTimeout(unlock, delayMs);
      return;
    }
    unlock();
  }, []);

  const renderItem = useCallback(({ item, index }: { item: VideoType; index: number }) => {
    const columnIndex = index % 2; // 0 for left column, 1 for right column
    
    return (
      <VideoThumbnail 
        item={item} 
        isSelected={actionSheetVideo?.id === item.id}
        onPress={async () => {
          const lockKey = item.id;
          if (!tryAcquireNavigationLock(lockKey)) {
            return;
          }

          if (item.status === 'draft' && item.projectId) {
            router.push({
              pathname: '/chat-composer',
              params: { projectId: item.projectId },
            });
            releaseNavigationLock(lockKey, 750);
          }
          else if (item.status === 'ready' && item.uri && item.uri.length > 0) {
            let videoUrl = item.uri;
            if (item.projectId) {
              console.log('[feed] Fetching fresh URL for video...');
              try {
                const freshUrl = await getFreshVideoUrl({ projectId: item.projectId as any });
                if (freshUrl) {
                  console.log('[feed] Got fresh URL');
                  videoUrl = freshUrl;
                }
              } catch (error) {
                console.error('[feed] Failed to fetch fresh URL:', error);
              }
            }
            router.push({
              pathname: '/video-preview',
              params: {
                videoId: item.id,
                videoUri: videoUrl,
                prompt: item.prompt,
                script: item.script || '',
                projectId: item.projectId || '',
                thumbnailUrl: item.thumbnailUrl || '',
              },
            });
            releaseNavigationLock(lockKey, 750);
          } else if (item.status === 'ready' && (!item.uri || item.uri.length === 0)) {
            Alert.alert('Error', 'Video is not available. Please try again or contact support.');
            releaseNavigationLock(lockKey);
          } else if (item.status === 'pending' || item.status === 'processing' || item.status === 'preparing') {
            // Navigate to video-preview in generating mode to show progress
            if (item.projectId) {
              router.push({
                pathname: '/video-preview',
                params: {
                  videoId: item.id,
                  videoUri: '', // No video yet
                  prompt: item.prompt,
                  script: item.script || '',
                  projectId: item.projectId,
                  thumbnailUrl: item.thumbnailUrl || '',
                  isGenerating: 'true',
                },
              });
              releaseNavigationLock(lockKey, 750);
            } else {
              releaseNavigationLock(lockKey);
            }
          } else {
            releaseNavigationLock(lockKey);
          }
        }}
        onLongPress={(position) => {
          setActionSheetVideo(item);
          setActionSheetPosition({ ...position, columnIndex });
          setShowActionSheet(true);
        }}
      />
    );
  }, [actionSheetVideo?.id, router, getFreshVideoUrl, tryAcquireNavigationLock, releaseNavigationLock]);

  const handleCreateNew = useCallback(() => {
    const generatedCount = videoGenerationStatus?.generatedCount ?? 0;
    const limit = videoGenerationStatus?.limit ?? 3;
    
    const hasReachedLimit = ENABLE_TEST_RUN_MODE 
      ? generatedCount >= limit 
      : (videoGenerationStatus?.hasReachedLimit ?? false);
    
    const hasAccess = ENABLE_TEST_RUN_MODE 
      ? hasCompletedPaywallThisSession 
      : subscriptionState.isPro;
    
    if (hasReachedLimit && !hasAccess) {
      router.push('/paywall');
      return;
    }
    
    router.push('/chat-composer');
  }, [videoGenerationStatus, subscriptionState.isPro, hasCompletedPaywallThisSession, router]);

  const renderProjectsEmpty = useCallback(() => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyTitle}>Start a project!</Text>
      <Text style={styles.emptySubtitle}>
        Upload your photos and videos and let the magic begin!
      </Text>
      <TouchableOpacity
        style={styles.startCreatingButton}
        onPress={handleCreateNew}
        activeOpacity={0.8}
      >
        <Text style={styles.startCreatingText}>Start Creating</Text>
      </TouchableOpacity>
    </View>
  ), [handleCreateNew]);

  const renderDraftsEmpty = useCallback(() => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyTitle}>No drafts yet</Text>
      <Text style={styles.emptySubtitle}>
        Your unfinished projects will appear here
      </Text>
    </View>
  ), []);

  const getCreditsDisplay = () => {
    if (!videoGenerationStatus) return null;
    
    const { isPremium, totalCreditsRemaining } = videoGenerationStatus;
    
    if (isPremium) {
      return { count: totalCreditsRemaining, label: 'credits' };
    }
    
    return { count: totalCreditsRemaining, label: 'videos left' };
  };

  const creditsDisplay = getCreditsDisplay();

  // Get user's first initial for avatar
  const userInitial = backendUser?.name?.charAt(0)?.toUpperCase() || 'U';

  // Handle FAB press - navigate to composer
  const handleFabPress = useCallback(() => {
    const generatedCount = videoGenerationStatus?.generatedCount ?? 0;
    const limit = videoGenerationStatus?.limit ?? 3;
    
    const hasReachedLimit = ENABLE_TEST_RUN_MODE 
      ? generatedCount >= limit 
      : (videoGenerationStatus?.hasReachedLimit ?? false);
    
    const hasAccess = ENABLE_TEST_RUN_MODE 
      ? hasCompletedPaywallThisSession 
      : subscriptionState.isPro;
    
    if (hasReachedLimit && !hasAccess) {
      router.push('/paywall');
      return;
    }
    
    router.push('/chat-composer');
  }, [videoGenerationStatus, subscriptionState.isPro, hasCompletedPaywallThisSession, router]);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>Gallery</Text>
          <View style={styles.headerRight}>
            {creditsDisplay && (
              <TouchableOpacity
                style={styles.creditsCounter}
                onPress={() => router.push('/paywall')}
                activeOpacity={0.8}
              >
                <Zap size={14} color={Colors.ember} strokeWidth={2.5} />
                <Text style={styles.creditsCounterText}>
                  {creditsDisplay.count}
                </Text>
              </TouchableOpacity>
            )}
            {/* Profile Avatar */}
            <TouchableOpacity
              style={styles.profileAvatar}
              onPress={() => router.push('/profile')}
              activeOpacity={0.8}
            >
              <Text style={styles.profileAvatarText}>{userInitial}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Content area with floating tab */}
      <View style={styles.contentArea}>
        {/* Floating Oval Segmented Tab Control */}
        <View style={styles.tabContainer}>
          <BlurView intensity={80} tint="light" style={styles.tabBackground}>
            <Animated.View
              style={[
                styles.tabIndicator,
                {
                  transform: [
                    {
                      translateX: tabIndicatorAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, (SCREEN_WIDTH - 80 - 10) / 2],
                      }),
                    },
                  ],
                },
              ]}
            />
            <TouchableOpacity
              style={styles.tabButton}
              onPress={() => setActiveTab('projects')}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, activeTab === 'projects' && styles.tabTextActive]}>
                Projects
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tabButton}
              onPress={() => setActiveTab('drafts')}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, activeTab === 'drafts' && styles.tabTextActive]}>
                Drafts
              </Text>
            </TouchableOpacity>
          </BlurView>
        </View>

        {/* Dual FlatLists to prevent reload on tab switch */}
        <View style={styles.listsContainer}>
          <View style={[styles.listWrapper, { opacity: activeTab === 'projects' ? 1 : 0, zIndex: activeTab === 'projects' ? 1 : 0 }]} pointerEvents={activeTab === 'projects' ? 'auto' : 'none'}>
            <FlatList
              data={projectVideos}
              renderItem={renderItem}
              keyExtractor={(item) => item.id}
              numColumns={2}
              columnWrapperStyle={styles.row}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.grid, { paddingTop: SEGMENTED_TAB_HEIGHT + 8, paddingBottom: FAB_BOTTOM_PADDING }]}
              ListEmptyComponent={renderProjectsEmpty}
              refreshControl={
                <RefreshControl
                  refreshing={isRefreshing}
                  onRefresh={handleRefresh}
                  tintColor={Colors.ember}
                  colors={[Colors.ember]}
                />
              }
            />
          </View>
          <View style={[styles.listWrapper, { opacity: activeTab === 'drafts' ? 1 : 0, zIndex: activeTab === 'drafts' ? 1 : 0 }]} pointerEvents={activeTab === 'drafts' ? 'auto' : 'none'}>
            <FlatList
              data={draftVideos}
              renderItem={renderItem}
              keyExtractor={(item) => item.id}
              numColumns={2}
              columnWrapperStyle={styles.row}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.grid, { paddingTop: SEGMENTED_TAB_HEIGHT + 8, paddingBottom: FAB_BOTTOM_PADDING }]}
              ListEmptyComponent={renderDraftsEmpty}
              refreshControl={
                <RefreshControl
                  refreshing={isRefreshing}
                  onRefresh={handleRefresh}
                  tintColor={Colors.ember}
                  colors={[Colors.ember]}
                />
              }
            />
          </View>
        </View>
      </View>

      {/* Action Sheet Modal */}
      {showActionSheet && (
        <View style={styles.actionSheetWrapper} pointerEvents="box-none">
          <Animated.View 
            style={[
              styles.actionSheetBackdrop,
              { opacity: actionSheetBackdropOpacity }
            ]}
            pointerEvents="box-none"
          >
            <TouchableOpacity 
              style={styles.backdropTouchable} 
              activeOpacity={1}
              onPress={closeActionSheet}
            />
          </Animated.View>
          <View
            style={[
              styles.actionSheetContainer,
              {
                position: 'absolute',
                left: actionSheetPosition.columnIndex === 1
                  ? actionSheetPosition.pageX - 108
                  : actionSheetPosition.pageX + actionSheetPosition.width + 8,
                // Position above the video if it's near the bottom of the screen
                top: actionSheetPosition.pageY + actionSheetPosition.height + ACTION_SHEET_HEIGHT + FAB_BOTTOM_PADDING > SCREEN_HEIGHT
                  ? actionSheetPosition.pageY - ACTION_SHEET_HEIGHT + 10 // Above the video
                  : actionSheetPosition.pageY + actionSheetPosition.height - 38, // Below the video (original)
              },
            ]}
          >
            <TouchableOpacity
              style={styles.actionSheetOption}
              onPress={async () => {
                if (!actionSheetVideo) return;
                closeActionSheet();
                
                setTimeout(async () => {
                  try {
                    // Trigger smooth layout animation before deleting
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    
                    // Delete from local state first for immediate UI feedback
                    deleteVideo(actionSheetVideo.id);
                    
                    // Then delete from backend
                    if (actionSheetVideo.projectId) {
                      await deleteProjectMutation({ id: actionSheetVideo.projectId as any });
                    }
                  } catch (error) {
                    console.error('Error deleting video:', error);
                    Alert.alert('Error', 'Failed to delete video. Please try again.');
                  }
                }, 200);
              }}
              activeOpacity={0.7}
            >
              <View style={styles.actionSheetOptionContent}>
                <Trash2 size={18} color={Colors.error} strokeWidth={2} />
                <Text style={styles.actionSheetOptionTextDelete}>Delete</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Floating Action Button (FAB) */}
      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
        onPress={handleFabPress}
        activeOpacity={0.8}
      >
        <Plus size={28} color={Colors.white} strokeWidth={2.5} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  header: {
    paddingLeft: 24,
    paddingRight: ITEM_SPACING,
    paddingBottom: 10,
    backgroundColor: Colors.cream,
  },
  headerContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 32,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    letterSpacing: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  creditsCounter: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(243, 106, 63, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 4,
  },
  creditsCounterText: {
    fontSize: 14,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.ember,
  },
  grid: {
    padding: ITEM_SPACING,
  },
  contentArea: {
    flex: 1,
    position: 'relative',
  },
  listsContainer: {
    flex: 1,
    position: 'relative',
  },
  listWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Floating Oval Segmented Tab Control
  tabContainer: {
    position: 'absolute',
    top: 8,
    left: 40,
    right: 40,
    zIndex: 100,
  },
  tabBackground: {
    flexDirection: 'row',
    backgroundColor: 'rgba(250, 249, 245, 0.85)',
    borderRadius: 28,
    padding: 4,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(38, 38, 38, 0.04)',
  },
  tabIndicator: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
    width: (SCREEN_WIDTH - 80 - 10) / 2, // 80 = margins, 8 = padding, 2 = border
    backgroundColor: Colors.white,
    borderRadius: 24,
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    zIndex: 1,
  },
  tabText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: 'rgba(38, 38, 38, 0.5)',
    letterSpacing: 0.6,
  },
  tabTextActive: {
    color: Colors.ink,
    fontFamily: Fonts.medium,
    fontWeight: '500',
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: ITEM_SPACING,
  },
  // New card-based layout
  cardContainer: {
    width: ITEM_WIDTH,
    height: CARD_HEIGHT,
    backgroundColor: Colors.white,
    borderRadius: 10,
    padding: 8,
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardTouchable: {
    flex: 1,
  },
  thumbnailCard: {
    width: '100%',
    height: THUMBNAIL_HEIGHT - 16, // Account for padding
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: Colors.creamDark,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
  },
  metadataContainer: {
    paddingTop: 8,
    paddingHorizontal: 0,
  },
  cardTitle: {
    fontSize: 15,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 4,
  },
  metadataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  metadataItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metadataText: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  // Legacy styles (kept for compatibility)
  thumbnailContainer: {
    width: ITEM_WIDTH,
    height: ITEM_WIDTH * 1.5,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: Colors.creamDark,
  },
  errorThumbnail: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.creamDark,
  },
  errorText: {
    fontSize: 12,
    fontFamily: Fonts.medium,
    color: Colors.ember,
    marginTop: 8,
    textAlign: 'center',
  },
  processingThumbnail: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.creamMedium,
    gap: 12,
  },
  processingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  processingText: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.ember,
  },
  processingHintText: {
    fontSize: 10,
    fontFamily: Fonts.regular,
    color: Colors.inkMuted,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  processingHintTextOverlay: {
    fontSize: 10,
    fontFamily: Fonts.regular,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  draftThumbnail: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  draftOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  draftText: {
    fontSize: 13,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  draftTextPlaceholder: {
    fontSize: 13,
    fontFamily: Fonts.medium,
    color: Colors.ink,
  },
  errorOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  noThumbnailContainer: {
    flex: 1,
    backgroundColor: Colors.creamMedium,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noThumbnailText: {
    color: Colors.textSecondary,
    fontFamily: Fonts.regular,
    fontSize: 12,
  },
  emptyContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    marginTop: 100,
  },
  emptyTitle: {
    fontSize: 24,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    marginBottom: 12,
  },
  emptySubtitle: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  startCreatingButton: {
    marginTop: 32,
    backgroundColor: Colors.ember,
    paddingHorizontal: 48,
    paddingVertical: 18,
    borderRadius: 100,
    height: 64,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Colors.ember,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  startCreatingText: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.white,
    textAlign: 'center',
  },
  backdropTouchable: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  actionSheetWrapper: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999,
  },
  actionSheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  actionSheetContainer: {
    width: 100,
    backgroundColor: Colors.white,
    borderRadius: 10,
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 10,
  },
  actionSheetOption: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  actionSheetOptionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionSheetOptionTextDelete: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.error,
    fontWeight: '600',
  },
  thumbnailTouchable: {
    width: '100%',
    height: '100%',
  },
  selectedBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 3,
    borderColor: Colors.ember,
    borderRadius: 10,
    pointerEvents: 'none',
  },
  // Profile Avatar in header
  profileAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.ember,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileAvatarText: {
    fontSize: 14,
    fontFamily: Fonts.medium,
    color: Colors.white,
    fontWeight: '600',
  },
  // Floating Action Button (FAB) - Squircle
  fab: {
    position: 'absolute',
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 16, // Squircle shape
    backgroundColor: Colors.ember,
    justifyContent: 'center',
    alignItems: 'center',
    // Dark shadow for visibility over gallery
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 12,
    zIndex: 100,
  },
});
