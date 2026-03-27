import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserProfile, Video, ConvexId } from '@/types';

const USER_KEY = '@reelfull_user';
const USER_ID_KEY = '@reelfull_userId';
const VIDEOS_KEY = '@reelfull_videos';

export const [AppProvider, useApp] = createContextHook(() => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [userId, setUserId] = useState<ConvexId<"users"> | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [syncedFromBackend, setSyncedFromBackend] = useState(false);
  const [backendUser, setBackendUser] = useState<any>(null);
  const [recentlyDeletedIds, setRecentlyDeletedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [userData, userIdData, videosData] = await Promise.all([
        AsyncStorage.getItem(USER_KEY),
        AsyncStorage.getItem(USER_ID_KEY),
        AsyncStorage.getItem(VIDEOS_KEY),
      ]);

      if (userData) {
        try {
          setUser(JSON.parse(userData));
        } catch (e) {
          console.error('Error parsing user data:', e);
          await AsyncStorage.removeItem(USER_KEY);
        }
      }
      
      if (userIdData) {
        try {
          setUserId(userIdData as ConvexId<"users">);
        } catch (e) {
          console.error('Error parsing userId:', e);
          await AsyncStorage.removeItem(USER_ID_KEY);
        }
      }
      
      if (videosData) {
        try {
          const parsed = JSON.parse(videosData);
          setVideos(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          console.error('Error parsing videos data:', e);
          await AsyncStorage.removeItem(VIDEOS_KEY);
          setVideos([]);
        }
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Sync user profile from backend when backendUser changes
  const syncUserFromBackend = useCallback((backendUserData: any) => {
    if (!backendUserData) return;
    
    console.log('[AppContext] Syncing user from backend:', backendUserData);
    
    // Map backend user data to local UserProfile format
    const userProfile: UserProfile = {
      name: backendUserData.name || '',
      style: mapBackendStyleToLocal(backendUserData.preferredStyle),
      voiceRecordingUri: backendUserData.voiceRecordingUrl,
    };
    
    // Update local state and storage
    setUser(userProfile);
    setBackendUser(backendUserData);
    AsyncStorage.setItem(USER_KEY, JSON.stringify(userProfile)).catch((err) => {
      console.error('[AppContext] Error saving user to storage:', err);
    });
  }, []);

  // Helper function to map backend style to local style
  const mapBackendStyleToLocal = (backendStyle?: string): 'Playful' | 'Professional' | 'Dreamy' => {
    if (backendStyle === 'playful') return 'Playful';
    if (backendStyle === 'professional') return 'Professional';
    if (backendStyle === 'travel') return 'Dreamy';
    return 'Playful'; // default
  };

  const syncVideosFromBackend = useCallback(async (backendProjects: any[]) => {
    try {
      console.log('[sync] Syncing videos from backend, count:', backendProjects.length);
      
      // Helper function to transform script: replace "???" with "?"
      const transformScript = (script?: string) => script?.replace(/\?\?\?/g, '?');
      
      // Convert backend projects to Video format
      const backendVideos: Video[] = backendProjects
        .filter(project => project.status === 'completed' && project.renderedVideoUrl)
        .map(project => ({
          id: project._id,
          uri: project.renderedVideoUrl || '',
          prompt: project.prompt,
          name: project.name, // AI-generated project name
          script: transformScript(project.script),
          createdAt: project.createdAt,
          status: 'ready' as const,
          projectId: project._id,
          thumbnailUrl: project.thumbnailUrl, // Include thumbnail URL for grid display
          duration: project.duration, // Video duration in seconds
        }));

      // Add draft videos (not yet approved by user)
      const draftVideos: Video[] = backendProjects
        .filter(project => project.status === 'draft')
        .map(project => ({
          id: project._id,
          uri: '',
          prompt: project.prompt,
          name: project.name, // AI-generated project name
          script: transformScript(project.script),
          createdAt: project.createdAt,
          status: 'draft' as const,
          projectId: project._id,
          thumbnailUrl: project.thumbnailUrl, // Include thumbnail URL for draft videos
        }));

      // Add pending/processing videos
      const processingVideos: Video[] = backendProjects
        .filter(project => 
          (project.status === 'processing' || project.status === 'rendering' || project.status === 'script_generating') && 
          !project.renderedVideoUrl
        )
        .map(project => ({
          id: project._id,
          uri: '',
          prompt: project.prompt,
          name: project.name, // AI-generated project name
          script: transformScript(project.script),
          createdAt: project.createdAt,
          status:
            project.status === 'rendering'
              ? 'processing' as const
              : 'pending' as const,
          projectId: project._id,
          thumbnailUrl: project.thumbnailUrl, // Include thumbnail URL even for processing videos
        }));

      // Add failed videos
      const failedVideos: Video[] = backendProjects
        .filter(project => project.status === 'failed')
        .map(project => ({
          id: project._id,
          uri: '',
          prompt: project.prompt,
          name: project.name, // AI-generated project name
          script: transformScript(project.script),
          createdAt: project.createdAt,
          status: 'failed' as const,
          projectId: project._id,
          error: project.error || project.renderError || 'Generation failed',
          thumbnailUrl: project.thumbnailUrl, // Include thumbnail URL even for failed videos
        }));

      // Filter out recently deleted videos to prevent them from reappearing during sync
      const backendVideoList = [...backendVideos, ...draftVideos, ...processingVideos, ...failedVideos]
        .filter(v => !recentlyDeletedIds.has(v.id));
      
      // Merge with existing local videos (in case there are any new ones not in backend yet)
      setVideos(currentVideos => {
        // Create a map of backend videos by ID for quick lookup
        const backendVideoMap = new Map(backendVideoList.map(v => [v.id, v]));
        
        // Keep local videos that aren't in the backend yet (and not recently deleted)
        const localOnlyVideos = currentVideos.filter(v => 
          !backendVideoMap.has(v.id) && !recentlyDeletedIds.has(v.id)
        );
        
        // Merge: backend videos take precedence, then add local-only videos
        const mergedVideos = [...backendVideoList, ...localOnlyVideos];
        
        console.log('[sync] Merged videos - Backend:', backendVideoList.length, 'Local only:', localOnlyVideos.length, 'Total:', mergedVideos.length);
        
        // Save to AsyncStorage
        AsyncStorage.setItem(VIDEOS_KEY, JSON.stringify(mergedVideos)).catch((err) => {
          console.error('[sync] Error saving merged videos:', err);
        });
        
        return mergedVideos;
      });
      
      setSyncedFromBackend(true);
    } catch (error) {
      console.error('[sync] Error syncing videos from backend:', error);
    }
  }, [recentlyDeletedIds]);

  const saveUser = useCallback(async (profile: UserProfile) => {
    try {
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(profile));
      setUser(profile);
    } catch (error) {
      console.error('Error saving user:', error);
    }
  }, []);

  const addVideo = useCallback(async (video: Video) => {
    try {
      console.log('Adding video to storage:', video);
      
      setVideos((prevVideos) => {
        // Check if video already exists and update it
        const existingIndex = prevVideos.findIndex(v => v.id === video.id);
        let updatedVideos;
        
        if (existingIndex !== -1) {
          // Update existing video
          updatedVideos = [...prevVideos];
          updatedVideos[existingIndex] = video;
          console.log('Updated existing video:', video.id);
        } else {
          // Add new video
          updatedVideos = [video, ...prevVideos];
          console.log('Added new video:', video.id);
        }
        
        AsyncStorage.setItem(VIDEOS_KEY, JSON.stringify(updatedVideos)).catch((err) => {
          console.error('Error saving videos to storage:', err);
        });
        return updatedVideos;
      });
      
      console.log('Video operation successful');
    } catch (error) {
      console.error('Error adding video:', error);
    }
  }, []);

  const updateVideoStatus = useCallback(async (videoId: string, status: Video['status'], uri?: string, error?: string, thumbnailUrl?: string) => {
    try {
      setVideos((prevVideos) => {
        const updatedVideos = prevVideos.map(video => {
          if (video.id === videoId) {
            const updated = {
              ...video,
              status,
            };
            
            // Only update uri if provided
            if (uri !== undefined) {
              updated.uri = uri;
            }
            
            // Only update error if provided
            if (error !== undefined) {
              updated.error = error;
            }
            
            // Only update thumbnailUrl if provided (preserve existing if not)
            if (thumbnailUrl !== undefined) {
              updated.thumbnailUrl = thumbnailUrl;
            }
            
            return updated;
          }
          return video;
        });
        
        AsyncStorage.setItem(VIDEOS_KEY, JSON.stringify(updatedVideos)).catch((err) => {
          console.error('Error saving videos to storage:', err);
        });
        return updatedVideos;
      });
    } catch (error) {
      console.error('Error updating video status:', error);
    }
  }, []);

  const deleteVideo = useCallback(async (videoId: string) => {
    try {
      // Add to recently deleted set to prevent sync from re-adding it
      setRecentlyDeletedIds(prev => new Set(prev).add(videoId));
      
      // Remove from local state
      setVideos((prevVideos) => {
        const updatedVideos = prevVideos.filter(video => video.id !== videoId);
        AsyncStorage.setItem(VIDEOS_KEY, JSON.stringify(updatedVideos)).catch((err) => {
          console.error('Error saving videos to storage:', err);
        });
        return updatedVideos;
      });
      
      // Clear from recently deleted after delay (allows backend sync to complete)
      setTimeout(() => {
        setRecentlyDeletedIds(prev => {
          const next = new Set(prev);
          next.delete(videoId);
          return next;
        });
      }, 5000);
    } catch (error) {
      console.error('Error deleting video:', error);
    }
  }, []);

  const saveUserId = useCallback(async (id: ConvexId<"users">) => {
    try {
      await AsyncStorage.setItem(USER_ID_KEY, id);
      setUserId(id);
    } catch (error) {
      console.error('Error saving userId:', error);
    }
  }, []);

  const clearData = useCallback(async () => {
    try {
      await AsyncStorage.multiRemove([USER_KEY, USER_ID_KEY, VIDEOS_KEY]);
      setUser(null);
      setUserId(null);
      setVideos([]);
      setSyncedFromBackend(false);
    } catch (error) {
      console.error('Error clearing data:', error);
    }
  }, []);

  return useMemo(() => ({
    user,
    userId,
    videos,
    isLoading,
    syncedFromBackend,
    backendUser,
    saveUser,
    saveUserId,
    addVideo,
    updateVideoStatus,
    deleteVideo,
    clearData,
    syncVideosFromBackend,
    syncUserFromBackend,
  }), [user, userId, videos, isLoading, syncedFromBackend, backendUser, saveUser, saveUserId, addVideo, updateVideoStatus, deleteVideo, clearData, syncVideosFromBackend, syncUserFromBackend]);
});
