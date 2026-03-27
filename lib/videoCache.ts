/**
 * Video Cache Utility
 * 
 * Caches remote videos locally to avoid re-downloading the same video repeatedly.
 * Uses project ID or URL hash as cache key.
 */

import * as FileSystem from 'expo-file-system/legacy';

// Cache directory for videos
const VIDEO_CACHE_DIR = `${FileSystem.cacheDirectory}video-cache/`;

// Cache metadata file to track cached videos and their info
const CACHE_METADATA_FILE = `${VIDEO_CACHE_DIR}metadata.json`;

// Maximum cache size in bytes (500MB default)
const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024;

// Cache entry metadata
interface CacheEntry {
  key: string;
  localPath: string;
  remoteUrl: string;
  size: number;
  cachedAt: number;
  lastAccessedAt: number;
}

interface CacheMetadata {
  entries: Record<string, CacheEntry>;
  totalSize: number;
}

/**
 * Simple string hash function (djb2 algorithm)
 * No external dependencies needed
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // Convert to positive hex string
  return (hash >>> 0).toString(16);
}

/**
 * Initialize the cache directory
 */
async function ensureCacheDir(): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(VIDEO_CACHE_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(VIDEO_CACHE_DIR, { intermediates: true });
  }
}

/**
 * Load cache metadata from disk
 */
async function loadCacheMetadata(): Promise<CacheMetadata> {
  try {
    const metaInfo = await FileSystem.getInfoAsync(CACHE_METADATA_FILE);
    if (metaInfo.exists) {
      const content = await FileSystem.readAsStringAsync(CACHE_METADATA_FILE);
      return JSON.parse(content);
    }
  } catch (error) {
    console.log('[VideoCache] Failed to load metadata, starting fresh');
  }
  return { entries: {}, totalSize: 0 };
}

/**
 * Save cache metadata to disk
 */
async function saveCacheMetadata(metadata: CacheMetadata): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(
      CACHE_METADATA_FILE,
      JSON.stringify(metadata, null, 2)
    );
  } catch (error) {
    console.error('[VideoCache] Failed to save metadata:', error);
  }
}

/**
 * Generate a cache key from a URL or project ID
 */
function generateCacheKey(url: string, projectId?: string): string {
  // Prefer project ID if available (more stable than URL which may change)
  if (projectId) {
    return `project_${projectId}`;
  }
  
  // Fall back to URL hash
  const hash = simpleHash(url);
  return `url_${hash}`;
}

/**
 * Get the local path for a cache key
 */
function getCachePath(key: string): string {
  return `${VIDEO_CACHE_DIR}${key}.mp4`;
}

/**
 * Evict old entries to make room for new content (LRU eviction)
 */
async function evictOldEntries(
  metadata: CacheMetadata,
  requiredSpace: number
): Promise<CacheMetadata> {
  const targetSize = MAX_CACHE_SIZE_BYTES - requiredSpace;
  
  if (metadata.totalSize <= targetSize) {
    return metadata;
  }

  console.log(`[VideoCache] Evicting entries to free space. Current: ${formatBytes(metadata.totalSize)}, Target: ${formatBytes(targetSize)}`);

  // Sort entries by last accessed time (oldest first)
  const sortedEntries = Object.values(metadata.entries).sort(
    (a, b) => a.lastAccessedAt - b.lastAccessedAt
  );

  let currentSize = metadata.totalSize;
  const entriesToDelete: string[] = [];

  for (const entry of sortedEntries) {
    if (currentSize <= targetSize) break;
    
    entriesToDelete.push(entry.key);
    currentSize -= entry.size;
    
    // Delete the file
    try {
      await FileSystem.deleteAsync(entry.localPath, { idempotent: true });
      console.log(`[VideoCache] Evicted: ${entry.key}`);
    } catch (error) {
      console.error(`[VideoCache] Failed to delete ${entry.key}:`, error);
    }
  }

  // Remove from metadata
  for (const key of entriesToDelete) {
    delete metadata.entries[key];
  }
  
  metadata.totalSize = currentSize;
  return metadata;
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Check if a video is cached and return the local path if so
 */
export async function getCachedVideoPath(
  remoteUrl: string,
  projectId?: string
): Promise<string | null> {
  try {
    await ensureCacheDir();
    const key = generateCacheKey(remoteUrl, projectId);
    const metadata = await loadCacheMetadata();
    
    const entry = metadata.entries[key];
    if (!entry) {
      return null;
    }

    // Verify the file still exists
    const fileInfo = await FileSystem.getInfoAsync(entry.localPath);
    if (!fileInfo.exists) {
      // File was deleted externally, clean up metadata
      delete metadata.entries[key];
      metadata.totalSize = Math.max(0, metadata.totalSize - entry.size);
      await saveCacheMetadata(metadata);
      return null;
    }

    // Update last accessed time
    entry.lastAccessedAt = Date.now();
    await saveCacheMetadata(metadata);
    
    console.log(`[VideoCache] Cache hit for ${key}`);
    return entry.localPath;
  } catch (error) {
    console.error('[VideoCache] Error checking cache:', error);
    return null;
  }
}

/**
 * Download and cache a video, returning the local path
 * If already cached, returns the cached path immediately
 */
export async function cacheVideo(
  remoteUrl: string,
  projectId?: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  try {
    await ensureCacheDir();
    const key = generateCacheKey(remoteUrl, projectId);
    
    // Check if already cached
    const cachedPath = await getCachedVideoPath(remoteUrl, projectId);
    if (cachedPath) {
      return cachedPath;
    }

    const localPath = getCachePath(key);
    console.log(`[VideoCache] Downloading video to cache: ${key}`);

    // Download the video
    const downloadResumable = FileSystem.createDownloadResumable(
      remoteUrl,
      localPath,
      {},
      (downloadProgress) => {
        const progress = downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite;
        onProgress?.(progress);
      }
    );

    const result = await downloadResumable.downloadAsync();
    
    if (!result || result.status !== 200) {
      throw new Error(`Download failed with status: ${result?.status}`);
    }

    // Get file size
    const fileInfo = await FileSystem.getInfoAsync(localPath);
    const fileSize = fileInfo.exists && fileInfo.size ? fileInfo.size : 0;

    // Load and update metadata
    let metadata = await loadCacheMetadata();
    
    // Evict old entries if needed
    metadata = await evictOldEntries(metadata, fileSize);

    // Add new entry
    metadata.entries[key] = {
      key,
      localPath,
      remoteUrl,
      size: fileSize,
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
    metadata.totalSize += fileSize;

    await saveCacheMetadata(metadata);
    
    console.log(`[VideoCache] Cached ${key} (${formatBytes(fileSize)}). Total cache: ${formatBytes(metadata.totalSize)}`);
    
    return localPath;
  } catch (error) {
    console.error('[VideoCache] Failed to cache video:', error);
    // Return the remote URL as fallback
    return remoteUrl;
  }
}

/**
 * Get the video URL to use - returns cached local path if available, otherwise remote URL
 * This is the main function to use for video playback
 */
export async function getVideoUrl(
  remoteUrl: string,
  projectId?: string
): Promise<string> {
  if (!remoteUrl) {
    return remoteUrl;
  }
  
  // If it's already a local file, return as-is
  if (remoteUrl.startsWith('file://')) {
    return remoteUrl;
  }

  // Check for cached version
  const cachedPath = await getCachedVideoPath(remoteUrl, projectId);
  if (cachedPath) {
    return cachedPath;
  }

  // Return remote URL - video will be cached on next explicit cache call
  return remoteUrl;
}

/**
 * Pre-cache a video in the background (non-blocking)
 * Use this to start caching as soon as you know the video URL
 */
export function preCacheVideo(
  remoteUrl: string,
  projectId?: string
): void {
  if (!remoteUrl || remoteUrl.startsWith('file://')) {
    return;
  }
  
  // Start caching in the background
  cacheVideo(remoteUrl, projectId).catch((error) => {
    console.log('[VideoCache] Background pre-cache failed:', error);
  });
}

/**
 * Remove a specific video from cache
 */
export async function removeCachedVideo(
  remoteUrl: string,
  projectId?: string
): Promise<void> {
  try {
    await ensureCacheDir();
    const key = generateCacheKey(remoteUrl, projectId);
    const metadata = await loadCacheMetadata();
    
    const entry = metadata.entries[key];
    if (!entry) {
      return;
    }

    // Delete the file
    await FileSystem.deleteAsync(entry.localPath, { idempotent: true });
    
    // Update metadata
    metadata.totalSize = Math.max(0, metadata.totalSize - entry.size);
    delete metadata.entries[key];
    await saveCacheMetadata(metadata);
    
    console.log(`[VideoCache] Removed ${key} from cache`);
  } catch (error) {
    console.error('[VideoCache] Failed to remove cached video:', error);
  }
}

/**
 * Clear the entire video cache
 */
export async function clearVideoCache(): Promise<void> {
  try {
    await FileSystem.deleteAsync(VIDEO_CACHE_DIR, { idempotent: true });
    console.log('[VideoCache] Cache cleared');
  } catch (error) {
    console.error('[VideoCache] Failed to clear cache:', error);
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  totalSize: number;
  totalSizeFormatted: string;
  entryCount: number;
  maxSize: number;
  maxSizeFormatted: string;
}> {
  try {
    await ensureCacheDir();
    const metadata = await loadCacheMetadata();
    
    return {
      totalSize: metadata.totalSize,
      totalSizeFormatted: formatBytes(metadata.totalSize),
      entryCount: Object.keys(metadata.entries).length,
      maxSize: MAX_CACHE_SIZE_BYTES,
      maxSizeFormatted: formatBytes(MAX_CACHE_SIZE_BYTES),
    };
  } catch (error) {
    return {
      totalSize: 0,
      totalSizeFormatted: '0 B',
      entryCount: 0,
      maxSize: MAX_CACHE_SIZE_BYTES,
      maxSizeFormatted: formatBytes(MAX_CACHE_SIZE_BYTES),
    };
  }
}
