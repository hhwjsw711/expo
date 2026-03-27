import { useEffect, useRef } from 'react';
import { useConvex, useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useApp } from '@/contexts/AppContext';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Hook to poll for video generation status and update local state
 * This monitors pending videos and updates them when they're ready
 */
export function useVideoPolling() {
  const { videos, updateVideoStatus } = useApp();
  const checkedVideos = useRef(new Set<string>());
  const renderTriggered = useRef(new Set<string>());
  const convex = useConvex();
  const renderVideo = useAction(api.render.renderVideo);
  const pollingInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Get all pending/processing/preparing videos
    const pendingVideos = videos.filter(
      v => (v.status === 'pending' || v.status === 'processing' || v.status === 'preparing') && v.projectId
    );

    // If no pending videos, clear interval and return
    if (pendingVideos.length === 0) {
      if (pollingInterval.current) {
        clearInterval(pollingInterval.current);
        pollingInterval.current = null;
      }
      return;
    }

    // Poll function to check all pending videos
    const pollVideos = async () => {
      for (const video of pendingVideos) {
        try {
          const project = await convex.query(api.tasks.getProject, { id: video.projectId as any });
          
          if (!project) continue;

          // Check if all media assets are ready but video not rendered yet
          const hasAllMediaAssets = !!(
            project.audioUrl && 
            project.musicUrl
          );
          
          // ONLY mark as failed if backend explicitly sets status to 'failed'
          // Otherwise, keep showing processing/generating state
          
          // Priority 1: Check if backend explicitly marked as failed
          if (project.status === 'failed') {
            if (video.status !== 'failed') {
              console.log('[VideoPolling] ❌ Backend marked as FAILED:', video.id, 'Error:', project.error);
              updateVideoStatus(video.id, 'failed', undefined, project.error, project.thumbnailUrl);
              // Note: failure notification is handled by backend push notification (sendVideoFailedNotification in tasks.ts)
            }
          }
          // Priority 2: Check if video is completely ready (has renderedVideoUrl)
          else if (project.status === 'completed' && project.renderedVideoUrl) {
            // Video URL exists - verify it's actually accessible before marking as ready
            if (video.status !== 'ready') {
              // Validate that we have a non-empty video URL
              if (project.renderedVideoUrl && project.renderedVideoUrl.trim().length > 0) {
                // If not already preparing, mark as preparing first
                if (video.status !== 'preparing') {
                  console.log('[VideoPolling] ⏳ Video URL exists, verifying CDN accessibility:', video.id);
                  updateVideoStatus(video.id, 'preparing', project.renderedVideoUrl, undefined, project.thumbnailUrl);
                }

                // Verify the video URL is actually accessible from client
                try {
                  const verifyResponse = await fetch(project.renderedVideoUrl, {
                    method: 'HEAD',
                    cache: 'no-store',
                  });

                  if (verifyResponse.ok) {
                    console.log('[VideoPolling] ✅ Video READY and VERIFIED:', video.id);
                    console.log('[VideoPolling] Video URL:', project.renderedVideoUrl);
                    console.log('[VideoPolling] Thumbnail URL:', project.thumbnailUrl);
                    updateVideoStatus(video.id, 'ready', project.renderedVideoUrl, undefined, project.thumbnailUrl);
                    // Note: push notification is handled by backend (sendVideoReadyNotification in tasks.ts)
                  } else {
                    console.log('[VideoPolling] ⏳ Video URL not yet accessible (status:', verifyResponse.status, '):', video.id);
                    // Keep as preparing - will retry on next poll
                  }
                } catch (error) {
                  console.log('[VideoPolling] ⏳ Video URL verification failed (CDN propagating):', video.id, error);
                  // Keep as preparing - will retry on next poll
                }
              }
            }
          }
          // Priority 3: Trigger rendering if media assets are ready but rendering not started
          else if (
            project.status === 'completed' && 
            hasAllMediaAssets &&
            !project.renderedVideoUrl && 
            !project.renderProgress &&
            !renderTriggered.current.has(video.id)
          ) {
            // Media assets ready, but rendering not started - trigger it!
            console.log('[VideoPolling] ✅ All media assets ready! Triggering render for:', video.id);
            console.log('[VideoPolling]   - audioUrl:', project.audioUrl ? "✓" : "✗");
            console.log('[VideoPolling]   - musicUrl:', project.musicUrl ? "✓" : "✗");
            console.log('[VideoPolling]   - videoUrls:', project.videoUrls?.length || 0, "videos");
            
            renderTriggered.current.add(video.id);
            
            // Keep as processing - don't mark as failed even if action throws
            if (video.status === 'pending') {
              updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl);
            }
            
            // Trigger render - backend guard prevents duplicate renders
            // Any errors are non-critical since rendering continues via scheduled steps
            renderVideo({ projectId: video.projectId as any }).catch((error) => {
              console.warn('[VideoPolling] Render trigger returned error (non-critical, backend guards against duplicates):', error);
              // Don't mark as failed - rendering continues in background via scheduled steps
              // Backend guard prevents duplicate renders if multiple triggers happen simultaneously
            });
          }
          // Priority 4: Show processing for any intermediate states OR if completed but still rendering
          else if (
            project.status === 'processing' || 
            project.status === 'rendering' || 
            (project.status === 'completed' && !project.renderedVideoUrl)
          ) {
            // Keep showing processing state for all intermediate states
            // This also recovers videos from 'failed' status if backend is actually still working
            if (video.status === 'pending' || video.status === 'failed') {
              console.log('[VideoPolling] ⏳ Video generating (recovering from incorrect failed status):', video.id, 'Backend status:', project.status);
              updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl);
            }
          }
        } catch (error) {
          console.error('[VideoPolling] Error checking project:', video.projectId, error);
        }
      }
    };

    // Poll immediately
    pollVideos();

    // Then poll every 3 seconds
    if (!pollingInterval.current) {
      pollingInterval.current = setInterval(pollVideos, 3000);
    }

    // Cleanup interval on unmount or when dependencies change
    return () => {
      if (pollingInterval.current) {
        clearInterval(pollingInterval.current);
        pollingInterval.current = null;
      }
    };
  }, [videos, updateVideoStatus, convex, renderVideo]);
}

/**
 * Request notification permissions and get push token
 */
export async function registerForPushNotificationsAsync() {
  let token;
  
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF6B35',
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  
  if (finalStatus !== 'granted') {
    console.log('[Notifications] Failed to get push notification permissions');
    return null;
  }

  try {
    // Get the Expo push token
    // The projectId is automatically read from app.json's extra.eas.projectId
    const tokenData = await Notifications.getExpoPushTokenAsync();
    token = tokenData.data;
    console.log('[Notifications] Push token obtained:', token);
    return token;
  } catch (error) {
    console.error('[Notifications] Error getting push token:', error);
    return null;
  }
}

// Local notification helpers removed — notifications are now handled exclusively
// by the backend push notification system (sendVideoReadyNotification / sendVideoFailedNotification
// in tasks.ts) to avoid duplicate notifications from both systems firing independently.

