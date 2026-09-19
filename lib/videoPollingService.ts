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
  } as any),
});

// ─── Polling configuration: exponential backoff ─────────────────────────────
// Starts at MIN_POLL_INTERVAL_MS and grows by BACKOFF_FACTOR on each poll that
// finds no state change, up to MAX_POLL_INTERVAL_MS. Any state change (video
// progressed / ready / failed) resets the interval to the minimum so we react
// quickly to changes while staying quiet during long renders.
const MIN_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 15000;
const BACKOFF_FACTOR = 1.5;

// Terminal states where a video is removed from the renderTriggered set.
// Keeps the set bounded and lets a failed/purged video be re-triggered later
// if the same project goes through the pipeline again.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['ready', 'failed']);

/**
 * Hook to poll for video generation status and update local state
 * This monitors pending videos and updates them when they're ready
 */
export function useVideoPolling() {
  const { videos, updateVideoStatus } = useApp();
  const renderTriggered = useRef(new Set<string>());
  // Re-trigger budget for sequences left in "retry available" state by
  // transient timeouts (sandbox kept alive by render.ts).
  const sequenceRetryCount = useRef(new Map<string, number>());
  const SEQUENCE_MAX_RETRIES = 2;
  // E2E TEST: last observed poll state per project — only log on change.
  const lastPollStateRef = useRef(new Map<string, string>());
  const convex = useConvex();
  const createSequence = useAction(api.render.createSequence);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPollingRef = useRef(false);

  useEffect(() => {
    // Clean up renderTriggered entries that reached a terminal state.
    // Also drops entries whose video no longer exists (e.g. deleted).
    for (const id of renderTriggered.current) {
      const video = videos.find(v => v.id === id);
      if (!video || TERMINAL_STATUSES.has(video.status)) {
        renderTriggered.current.delete(id);
        sequenceRetryCount.current.delete(id);
      }
    }

    // Get all pending/processing/preparing videos
    const pendingVideos = videos.filter(
      v => (v.status === 'pending' || v.status === 'processing' || v.status === 'preparing') && v.projectId
    );

    // If no pending videos, clear the timer and return
    if (pendingVideos.length === 0) {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      isPollingRef.current = false;
      return;
    }

    let pollIntervalMs = MIN_POLL_INTERVAL_MS;

    // Poll function to check all pending videos.
    // Returns true if any video changed state (so the caller shrinks backoff).
    const pollVideos = async (): Promise<boolean> => {
      let anyStateChanged = false;
      for (const video of pendingVideos) {
        try {
          const project = await convex.query(api.tasks.getProject, { id: video.projectId as any });
          
          if (!project) continue;

          // Check if all media assets are ready but video not rendered yet
          // Music is optional — generation may fail, but we can still render without it
          // videoUrls contains FAL-animated clips for images; for video-only
          // projects videoUrls may be empty (user's original videos are in
          // project.files), so we also accept projects that have uploaded
          // video files in fileMetadata.
          const hasVideoFiles = (project.fileMetadata ?? []).some(
            (m: any) => typeof m?.contentType === 'string' && m.contentType.startsWith('video/'),
          );
          const hasAllMediaAssets = !!(
            project.audioUrl &&
            ((project.videoUrls && project.videoUrls.length > 0) || hasVideoFiles)
          );

          // E2E TEST LOG: print the poll state only when something changed
          // vs the last poll for this project, to avoid spamming.
          const projKey = video.projectId ?? video.id;
          const stateKey = `${project.status}|${!!project.audioUrl}|${project.videoUrls?.length ?? 0}|${!!project.sandboxId}|${!!project.timelineJson}|${!!project.renderedVideoUrl}|${project.renderProgress?.step ?? 'none'}`;
          const lastKey = lastPollStateRef.current.get(projKey);
          if (stateKey !== lastKey) {
            lastPollStateRef.current.set(projKey, stateKey);
            console.log(
              '[VideoPolling][STATE]', projKey.substring(0, 8),
              'status:', project.status,
              '| audio:', !!project.audioUrl,
              '| videoUrls:', project.videoUrls?.length ?? 0,
              '| hasVideoFiles:', hasVideoFiles,
              '| allMedia:', hasAllMediaAssets,
              '| sandbox:', !!project.sandboxId,
              '| timeline:', !!project.timelineJson,
              '| rendered:', !!project.renderedVideoUrl,
              '| step:', project.renderProgress?.step ?? 'none',
            );
          }
          
          // ONLY mark as failed if backend explicitly sets status to 'failed'
          // Otherwise, keep showing processing/generating state
          
          // Priority 1: Check if backend explicitly marked as failed
          if (project.status === 'failed') {
            if (video.status !== 'failed') {
              console.log('[VideoPolling] ❌ Backend marked as FAILED:', video.id, 'Error:', project.error);
              updateVideoStatus(video.id, 'failed', undefined, project.error ?? undefined, project.thumbnailUrl ?? undefined);
              anyStateChanged = true;
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
                  updateVideoStatus(video.id, 'preparing', project.renderedVideoUrl, undefined, project.thumbnailUrl ?? undefined);
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
                    updateVideoStatus(video.id, 'ready', project.renderedVideoUrl, undefined, project.thumbnailUrl ?? undefined);
                    anyStateChanged = true;
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
          //
          // Also handles DEADLOCK STATE A: a transient error before sandbox
          // creation left the project with status 'completed' + 'retry available'
          // but no sandboxId and no timelineJson. The old condition required
          // !renderProgress, which blocked retries. Now we also accept
          // 'retry available' and apply the same retry budget as 3b-RETRY.
          else if (
            project.status === 'completed' &&
            hasAllMediaAssets &&
            !project.renderedVideoUrl &&
            (!project.renderProgress || project.renderProgress?.step === 'retry available') &&
            !project.sandboxId &&  // Only trigger if no sandbox yet (not mid-pipeline)
            !project.timelineJson &&  // Sequence not yet created
            !renderTriggered.current.has(video.id)
          ) {
            // If this is a retry (not a fresh trigger), check the budget
            const isRetry = project.renderProgress?.step === 'retry available';
            if (isRetry) {
              const retries = sequenceRetryCount.current.get(video.id) ?? 0;
              if (retries >= SEQUENCE_MAX_RETRIES) {
                console.log('[VideoPolling] ⏳ Retry budget exhausted for:', video.id);
              } else {
                sequenceRetryCount.current.set(video.id, retries + 1);
                console.log(`[VideoPolling] 🔄 Retrying sequence (attempt ${retries + 1}/${SEQUENCE_MAX_RETRIES}) for:`, video.id);
              }
            }
            // Only proceed if not exhausted (isRetry && exhausted falls through to Priority 4)
            const shouldTrigger = !isRetry || (sequenceRetryCount.current.get(video.id) ?? 0) <= SEQUENCE_MAX_RETRIES;
            if (shouldTrigger) {
              // Media assets ready, but sequence not created - trigger it!
              console.log('[VideoPolling] ✅ All media assets ready! Triggering sequence for:', video.id);

              renderTriggered.current.add(video.id);
              anyStateChanged = true;

              // Keep as processing - don't mark as failed even if action throws
              if (video.status === 'pending') {
                updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl ?? undefined);
              }

              // Step 1: Create sequence only (sandbox + upload + Claude + timeline.json)
              createSequence({ projectId: video.projectId as any })
                .then((result) => {
                  if (!result?.success) {
                    console.warn('[VideoPolling] Sequence not started:', result?.error);
                    renderTriggered.current.delete(video.id);
                    return;
                  }
                  console.log('[VideoPolling] ✅ Sequence created for:', video.id, '— user can preview/edit/render');
                  // NOTE: Do NOT auto-trigger renderFinalVideo.
                  // User will see the video in "processing" state until they open it and tap Render.
                })
                .catch((error) => {
                  console.warn('[VideoPolling] Sequence error:', error);
                  renderTriggered.current.delete(video.id);
                });
            }
          }
          // Priority 3b-RETRY: A transient timeout left a live sandbox with
          // "retry available" — nothing else consumes this state, so
          // re-trigger createSequence here (it reuses the existing sandbox).
          // render.ts releases the lock on transient errors (status back to
          // "completed"), but this branch also tolerates legacy rows stuck
          // in "rendering" (pre-fix data). MUST be evaluated BEFORE 3b —
          // 3b matches any rendering+sandbox row and would swallow this.
          // Bounded by SEQUENCE_MAX_RETRIES to avoid retry loops.
          else if (
            (project.status === 'completed' || project.status === 'rendering') &&
            project.sandboxId &&
            !project.renderedVideoUrl &&
            !project.timelineJson &&
            project.renderProgress?.step === 'retry available' &&
            !renderTriggered.current.has(video.id)
          ) {
            const retries = sequenceRetryCount.current.get(video.id) ?? 0;
            if (retries < SEQUENCE_MAX_RETRIES) {
              sequenceRetryCount.current.set(video.id, retries + 1);
              renderTriggered.current.add(video.id);
              anyStateChanged = true;
              console.log(`[VideoPolling] 🔄 Retrying sequence (attempt ${retries + 1}/${SEQUENCE_MAX_RETRIES}) for:`, video.id);
              updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl ?? undefined);
              createSequence({ projectId: video.projectId as any })
                .then((result) => {
                  if (!result?.success) {
                    console.warn('[VideoPolling] Sequence retry not started:', result?.error);
                    renderTriggered.current.delete(video.id);
                    return;
                  }
                  console.log('[VideoPolling] ✅ Sequence retry created for:', video.id);
                })
                .catch((error) => {
                  console.warn('[VideoPolling] Sequence retry error:', error);
                  renderTriggered.current.delete(video.id);
                });
            } else {
              console.log('[VideoPolling] ⏳ Retry budget exhausted for:', video.id);
            }
          }
          // Priority 3-FORK: a timeline EXISTS but the sandbox is gone —
          // route it through createSequence (Branch B) to rebuild.
          // Two sources reach this state:
          //   a) saveEditorChanges forks the project as status 'processing'
          //      WITH a timelineJson payload (the user's edited timeline).
          //      No other branch advances it: Priority 3 below requires
          //      'completed' without timelineJson, so the fork would sit in
          //      Priority 4 displaying "processing" forever — the edit →
          //      re-render journey deadlocks.
          //   b) renderFinalVideo found the sandbox expired: it clears the
          //      sandboxId, sets status back to 'completed' and marks step
          //      'retry available'. Priority 3 also skips it (timelineJson
          //      present), so without this branch the project deadlocks in
          //      "Ready to Render" with no sandbox behind it.
          // Branch B regenerates the composition from the timeline without
          // re-running Claude, so both cases are fast and deterministic.
          else if (
            (project.status === 'processing' ||
             (project.status === 'completed' && project.renderProgress?.step === 'retry available')) &&
            project.timelineJson &&
            hasAllMediaAssets &&
            !project.renderedVideoUrl &&
            !project.sandboxId &&
            !renderTriggered.current.has(video.id)
          ) {
            // Apply the same retry budget as 3b-RETRY to prevent
            // infinite sandbox create/destroy cycles on persistent errors.
            const retries = sequenceRetryCount.current.get(video.id) ?? 0;
            if (retries >= SEQUENCE_MAX_RETRIES) {
              console.log('[VideoPolling] ⏳ Fork retry budget exhausted for:', video.id);
            } else {
              sequenceRetryCount.current.set(video.id, retries + 1);
              console.log(`[VideoPolling] ✅ Timeline ready, rebuilding sequence (Branch B, attempt ${retries + 1}/${SEQUENCE_MAX_RETRIES}):`, video.id);
              renderTriggered.current.add(video.id);
              anyStateChanged = true;
              if (video.status === 'pending') {
                updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl ?? undefined);
              }
              createSequence({ projectId: video.projectId as any })
                .then((result) => {
                  if (!result?.success) {
                    console.warn('[VideoPolling] Fork sequence not started:', result?.error);
                    renderTriggered.current.delete(video.id);
                    return;
                  }
                  console.log('[VideoPolling] ✅ Fork sequence created for:', video.id);
                })
                .catch((error) => {
                  console.warn('[VideoPolling] Fork sequence error:', error);
                  renderTriggered.current.delete(video.id);
                });
            }
          }
          // Priority 3b-RECOVER: Sandbox exists AND timeline exists but
          // status is "completed" + "retry available" — a transient error
          // after Claude produced the timeline left the project in a state
          // no other branch matches. The sandbox and timeline are valid,
          // so the user can preview and render. Mark as ready.
          else if (
            (project.status === 'completed' || project.status === 'rendering') &&
            project.sandboxId &&
            project.timelineJson &&
            !project.renderedVideoUrl &&
            project.renderProgress?.step === 'retry available'
          ) {
            if (video.status !== 'ready') {
              console.log('[VideoPolling] ✅ Recovering: sandbox+timeline ready, marking as ready:', video.id);
              updateVideoStatus(video.id, 'ready', undefined, undefined, project.thumbnailUrl ?? undefined);
              anyStateChanged = true;
            }
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
                updateVideoStatus(video.id, 'ready', undefined, undefined, project.thumbnailUrl ?? undefined);
                anyStateChanged = true;
              }
            } else {
              // Sequence still being created (Claude editing etc.)
              if (video.status === 'pending' || video.status === 'failed') {
                console.log('[VideoPolling] ⏳ Sequence being created, waiting for user to render:', video.id);
                updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl ?? undefined);
                anyStateChanged = true;
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
              updateVideoStatus(video.id, 'processing', undefined, undefined, project.thumbnailUrl ?? undefined);
              anyStateChanged = true;
            }
          }
        } catch (error) {
          console.error('[VideoPolling] Error checking project:', video.projectId, error);
        }
      }
      return anyStateChanged;
    };

    // Schedule the next poll using exponential backoff.
    // Using setTimeout chains (instead of setInterval) guarantees the previous
    // poll has finished before the next one starts — no overlapping requests.
    const scheduleNext = () => {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      pollTimer.current = setTimeout(async () => {
        // Safety guard: if a previous poll is somehow still running, skip
        // this tick rather than overlapping it, but still schedule the next.
        if (isPollingRef.current) {
          scheduleNext();
          return;
        }
        isPollingRef.current = true;
        try {
          const changed = await pollVideos();
          if (changed) {
            // State changed — resume fast polling to react quickly
            pollIntervalMs = MIN_POLL_INTERVAL_MS;
          } else {
            // No change — back off exponentially, bounded
            pollIntervalMs = Math.min(pollIntervalMs * BACKOFF_FACTOR, MAX_POLL_INTERVAL_MS);
          }
        } finally {
          isPollingRef.current = false;
        }
        scheduleNext();
      }, pollIntervalMs);
    };

    // Poll immediately, then start the backoff loop
    pollVideos()
      .then(() => scheduleNext())
      .catch(() => scheduleNext());

    // Cleanup timer on unmount or when dependencies change
    return () => {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      isPollingRef.current = false;
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