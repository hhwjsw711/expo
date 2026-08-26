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
  const createSequence = useAction(api.render.createSequence);
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
          // Music is optional — generation may fail, but we can still render without it
          const hasAllMediaAssets = !!(
            project.audioUrl && 
            project.videoUrls && project.videoUrls.length > 0
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
          // Priority 3: Trigger sequence creation if media assets are ready but sequence not started
          // NOTE: Previously auto-chained createSequence -> renderFinalVideo.
          //   Now only create the sequence. User previews/edits in video-preview, then taps Render.
          else if (
            project.status === 'completed' && 
            hasAllMediaAssets &&
            !project.renderedVideoUrl && 
            !project.renderProgress &&
            !project.sandboxId &&  // Only trigger if no sandbox yet (not mid-pipeline)
            !project.timelineJson &&  // Sequence not yet created
            !renderTriggered.current.has(video.id)
          ) {
            // Media assets ready, but sequence not created - trigger it!
            console.log('[VideoPolling] ✅ All media assets ready! Triggering sequence for:', video.id);
            
            renderTriggered.current.add(video.id);
            
            // Keep as processing - don't mark as failed even if action throws
            if (video.status === 'pending') {
              updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl);
            }
            
            // Step 1: Create sequence only (sandbox + upload + Claude + timeline.json)
            createSequence({ projectId: video.projectId as any })
              .then((result) => {
                if (!result?.success) {
                  console.warn('[VideoPolling] Sequence not started:', result?.error);
                  return;
                }
                console.log('[VideoPolling] ✅ Sequence created for:', video.id, '— user can preview/edit/render');
                // NOTE: Do NOT auto-trigger renderFinalVideo.
                // User will see the video in "processing" state until they open it and tap Render.
              })
              .catch((error) => {
                console.warn('[VideoPolling] Sequence error:', error);
              });
          }
          // Priority 3b: Sandbox exists but video not rendered — keep as processing
          // (previously auto-resumed renderFinalVideo; now user must tap Render in video-preview)
          else if (
            project.status === 'rendering' &&
            project.sandboxId &&
            !project.renderedVideoUrl
          ) {
            // If timelineJson exists, sequence is ready for preview/render — show as ready
            if (project.timelineJson) {
              if (video.status !== 'ready') {
                console.log('[VideoPolling] ✅ Sequence ready for preview:', video.id);
                updateVideoStatus(video.id, 'ready', undefined, undefined, project.thumbnailUrl);
              }
            } else {
              // Sequence still being created (Claude editing etc.)
              if (video.status === 'pending' || video.status === 'failed') {
                console.log('[VideoPolling] ⏳ Sequence ready, waiting for user to render:', video.id);
                updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl);
              }
            }
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
  }, [videos, updateVideoStatus, convex, createSequence]);
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

