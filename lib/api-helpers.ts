/**
 * API Helper Functions for Convex Integration
 * 
 * This file contains reusable helper functions for common API operations
 */

import { Id } from "@/convex/_generated/dataModel";
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

/**
 * Run async tasks with a concurrency limit.
 * Preserves result order matching the input array.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
  return results;
}

/**
 * Extract asset ID from a ph:// URI
 * @param uri - The ph:// URI
 * @returns The asset ID or null
 */
function extractAssetId(uri: string): string | null {
  // ph://CC95F08C-88C3-4012-9D6D-64A413D254B3/L0/001
  // or ph://ED7AC36B-A150-4C38-BB8C-B6D696F4F2ED/L0/001
  const match = uri.match(/^ph:\/\/([A-F0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * Ensure a file is available locally (handles iCloud optimized storage)
 * On iOS, files may be stored in iCloud and not fully downloaded locally.
 * 
 * Strategy:
 * 1. For file:// URIs - verify file exists and has content
 * 2. For ph:// URIs - try to get localUri via MediaLibrary (with permission check)
 * 3. If all else fails, return original URI and let fetch handle it
 * 
 * @param uri - The file URI (may be ph://, assets-library://, or file://)
 * @param type - The media type for generating the filename
 * @param providedAssetId - Optional asset ID from expo-image-picker
 * @returns Local file URI that can be safely fetched
 */
export async function ensureLocalFile(uri: string, type: "image" | "video", providedAssetId?: string): Promise<string> {
  // Only special handling needed on iOS
  if (Platform.OS !== 'ios') {
    return uri;
  }

  console.log(`[ensureLocalFile] Processing: ${uri.substring(0, 60)}...`);
  console.log(`[ensureLocalFile] AssetId provided: ${providedAssetId || 'none'}`);

  // For file:// URIs, verify the file exists and has content
  if (uri.startsWith('file://')) {
    try {
      const fileInfo = await FileSystem.getInfoAsync(uri);
      console.log(`[ensureLocalFile] File info:`, { exists: fileInfo.exists, size: fileInfo.size });
      
      if (fileInfo.exists && fileInfo.size && fileInfo.size > 0) {
        console.log(`[ensureLocalFile] ✓ File ready: ${formatFileSize(fileInfo.size)}`);
        return uri;
      } else if (fileInfo.exists && (!fileInfo.size || fileInfo.size === 0)) {
        // File exists but is empty - likely still downloading from iCloud
        console.log('[ensureLocalFile] File exists but is empty - may be downloading from iCloud');
        throw new Error('This video is still downloading from iCloud. Please wait for the download to complete in the Photos app, then try again.');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('iCloud')) {
        throw error;
      }
      console.log('[ensureLocalFile] File check error:', error);
    }
  }

  // For ph:// URIs, try to get the local file path via MediaLibrary
  if (uri.startsWith('ph://') && providedAssetId) {
    console.log(`[ensureLocalFile] Attempting MediaLibrary lookup for asset: ${providedAssetId}`);
    
    try {
      // First check if we have permission
      const { status } = await MediaLibrary.getPermissionsAsync();
      console.log(`[ensureLocalFile] MediaLibrary permission status: ${status}`);
      
      if (status !== 'granted') {
        // Request permission if not granted
        const { status: newStatus } = await MediaLibrary.requestPermissionsAsync();
        if (newStatus !== 'granted') {
          console.log('[ensureLocalFile] MediaLibrary permission denied');
          throw new Error('Photo library access is required to upload videos. Please grant permission in Settings.');
        }
      }

      // Try to get asset info
      const assetInfo = await MediaLibrary.getAssetInfoAsync(providedAssetId);
      
      if (assetInfo) {
        console.log(`[ensureLocalFile] Asset info received:`, {
          localUri: assetInfo.localUri?.substring(0, 50),
          uri: assetInfo.uri?.substring(0, 50),
        });

        // Use localUri if available
        if (assetInfo.localUri) {
          const fileInfo = await FileSystem.getInfoAsync(assetInfo.localUri);
          if (fileInfo.exists && fileInfo.size && fileInfo.size > 0) {
            console.log(`[ensureLocalFile] ✓ Using localUri: ${formatFileSize(fileInfo.size)}`);
            return assetInfo.localUri;
          }
        }

        // Try uri property
        if (assetInfo.uri && assetInfo.uri.startsWith('file://')) {
          const fileInfo = await FileSystem.getInfoAsync(assetInfo.uri);
          if (fileInfo.exists && fileInfo.size && fileInfo.size > 0) {
            console.log(`[ensureLocalFile] ✓ Using asset.uri: ${formatFileSize(fileInfo.size)}`);
            return assetInfo.uri;
          }
        }
      }
    } catch (error) {
      // Log but don't throw - we'll try the original URI as fallback
      console.log('[ensureLocalFile] MediaLibrary lookup failed:', error);
      
      // Check if this is an iCloud-specific error
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('3164') || errorMessage.includes('PHPhotos')) {
        console.log('[ensureLocalFile] PHPhotos error detected - video likely in iCloud');
        throw new Error('This video is stored in iCloud and not downloaded to your device. Please open the Photos app, find this video, and wait for it to fully download before trying again.');
      }
      
      if (error instanceof Error && (error.message.includes('iCloud') || error.message.includes('permission'))) {
        throw error;
      }
    }
  }

  // Return original URI as last resort
  console.log('[ensureLocalFile] Using original URI as fallback');
  return uri;
}

/**
 * Clean up temporary local files created during upload
 * @param localUris - Array of local file URIs to clean up
 */
async function cleanupLocalFiles(localUris: string[]): Promise<void> {
  for (const uri of localUris) {
    if (uri.startsWith(FileSystem.cacheDirectory || '')) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        console.log(`[cleanup] Deleted temp file: ${uri}`);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Upload a file to Convex storage
 * @param generateUploadUrl - Convex mutation function to get upload URL
 * @param fileUri - Local file URI
 * @param contentType - MIME type (e.g., 'audio/mp3', 'image/jpeg', 'video/mp4')
 * @returns Storage ID
 */
export async function uploadFileToConvex(
  generateUploadUrl: () => Promise<string>,
  fileUri: string,
  contentType?: string
): Promise<Id<"_storage">> {
  // 1. Generate upload URL
  const uploadUrl = await generateUploadUrl();

  // 2. Fetch file and convert to blob
  const response = await fetch(fileUri);
  const blob = await response.blob();

  // 3. Upload to Convex
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": contentType || blob.type,
    },
    body: blob,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Upload failed: ${uploadResponse.statusText}`);
  }

  // 4. Get and return storage ID
  const { storageId } = await uploadResponse.json();
  return storageId as Id<"_storage">;
}

/**
 * Upload multiple media files to Convex storage (LEGACY - use uploadMediaFilesToR2 instead)
 * @param generateUploadUrl - Convex mutation function to get upload URL
 * @param mediaUris - Array of media items with URI, type, and optional assetId for iCloud files
 * @returns Array of upload metadata
 * @deprecated Use uploadMediaFilesToR2 for direct R2 uploads and bandwidth savings
 */
export async function uploadMediaFiles(
  generateUploadUrl: () => Promise<string>,
  mediaUris: Array<{ uri: string; type: "image" | "video"; assetId?: string }>
): Promise<
  Array<{
    storageId: Id<"_storage">;
    filename: string;
    contentType: string;
    size: number;
  }>
> {
  const uploads = [];
  const localFilesToCleanup: string[] = [];

  try {
    for (const media of mediaUris) {
      try {
        // 1. Generate upload URL
        const uploadUrl = await generateUploadUrl();

        // 2. Ensure file is available locally (handles iCloud optimized storage)
        console.log(`[uploadMediaFiles] Processing ${media.type}: ${media.uri.substring(0, 50)}...`);
        const localUri = await ensureLocalFile(media.uri, media.type, media.assetId);
        
        // Track local files for cleanup
        if (localUri !== media.uri) {
          localFilesToCleanup.push(localUri);
        }

        // 3. Fetch file from local URI
        let blob: Blob;
        try {
          const response = await fetch(localUri);
          if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
          }
          blob = await response.blob();
        } catch (fetchError) {
          const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
          console.error('[uploadMediaFiles] Fetch error:', errorMessage);
          
          // Check for iCloud-related errors
          if (errorMessage.includes('3164') || errorMessage.includes('PHPhotos') || errorMessage.includes('operation couldn\'t be completed')) {
            throw new Error('This video is stored in iCloud and not available on your device. Please open the Photos app, find this video, and wait for it to fully download before trying again.');
          }
          throw fetchError;
        }

        // 4. Validate blob has content
        if (blob.size === 0) {
          throw new Error('This video appears to still be downloading from iCloud. Please wait for the download to complete in the Photos app, then try again.');
        }

        console.log(`[uploadMediaFiles] Fetched ${media.type}, size: ${formatFileSize(blob.size)}`);

        // 5. Determine content type
        const contentType = media.type === "video" ? "video/mp4" : "image/jpeg";

        // 6. Upload to Convex
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: blob,
        });

        if (!uploadResponse.ok) {
          throw new Error(`Upload failed: ${uploadResponse.statusText}`);
        }

        const { storageId } = await uploadResponse.json();

        // 7. Add metadata
        uploads.push({
          storageId: storageId as Id<"_storage">,
          filename: `${media.type}_${Date.now().toString().slice(0, 13)}.${media.type === "video" ? "mp4" : "jpg"}`,
          contentType,
          size: blob.size,
        });

        console.log(`[uploadMediaFiles] ✓ Uploaded ${media.type}: ${storageId}`);
      } catch (error) {
        console.error(`[uploadMediaFiles] Failed to upload ${media.type}:`, error);
        throw error;
      }
    }

    return uploads;
  } finally {
    // Clean up temporary local files
    await cleanupLocalFiles(localFilesToCleanup);
  }
}

/**
 * Upload multiple media files directly to R2 (RECOMMENDED - bypasses Convex for maximum savings)
 * @param generateR2UploadUrls - Convex mutation function to get R2 upload URLs
 * @param mediaUris - Array of media items with URI, type, and optional assetId for iCloud files
 * @param projectId - Optional project ID for organized storage
 * @returns Array of upload metadata with R2 keys and URLs
 */
export async function uploadMediaFilesToR2(
  generateR2UploadUrls: (files: Array<{ filename: string; contentType: string }>, projectId?: string) => Promise<Array<{
    filename: string;
    uploadUrl: string;
    key: string;
    r2Url?: string;
  }>>,
  mediaUris: Array<{ uri: string; type: "image" | "video"; filename?: string; assetId?: string }>,
  projectId?: string
): Promise<
  Array<{
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
    r2Url?: string;
  }>
> {
  console.log(`[R2] Uploading ${mediaUris.length} files directly to R2...`);
  
  // 1. Prepare file metadata
  const fileMetadata = mediaUris.map((media, index) => {
    const ext = media.type === "video" ? "mp4" : "jpg";
    const filename = media.filename || `${media.type}_${Date.now().toString().slice(0, 13)}_${index}.${ext}`;
    const contentType = media.type === "video" ? "video/mp4" : "image/jpeg";
    
    return { filename, contentType };
  });

  // 2. Generate R2 upload URLs for all files
  const uploadUrls = await generateR2UploadUrls(fileMetadata, projectId);
  
  const uploads = [];
  const localFilesToCleanup: string[] = [];

  try {
    // 3. Upload each file directly to R2
    for (let i = 0; i < mediaUris.length; i++) {
      const media = mediaUris[i];
      const uploadInfo = uploadUrls[i];
      
      try {
        console.log(`[R2] Processing ${uploadInfo.filename}...`);
        
        // Ensure file is available locally (handles iCloud optimized storage)
        const localUri = await ensureLocalFile(media.uri, media.type, media.assetId);
        
        // Track local files for cleanup
        if (localUri !== media.uri) {
          localFilesToCleanup.push(localUri);
        }

        // Fetch file from local URI
        let blob: Blob;
        try {
          const response = await fetch(localUri);
          if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
          }
          blob = await response.blob();
        } catch (fetchError) {
          const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
          console.error('[R2] Fetch error:', errorMessage);
          
          // Check for iCloud-related errors
          if (errorMessage.includes('3164') || errorMessage.includes('PHPhotos') || errorMessage.includes('operation couldn\'t be completed')) {
            throw new Error('This video is stored in iCloud and not available on your device. Please open the Photos app, find this video, and wait for it to fully download before trying again.');
          }
          throw fetchError;
        }

        // Validate blob has content
        if (blob.size === 0) {
          throw new Error('This video appears to still be downloading from iCloud. Please wait for the download to complete in the Photos app, then try again.');
        }

        console.log(`[R2] Uploading ${uploadInfo.filename} (${formatFileSize(blob.size)})...`);

        // Upload directly to R2
        const uploadResponse = await fetch(uploadInfo.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": fileMetadata[i].contentType,
          },
          body: blob,
        });

        if (!uploadResponse.ok) {
          throw new Error(`R2 upload failed: ${uploadResponse.statusText}`);
        }

        uploads.push({
          filename: uploadInfo.filename,
          contentType: fileMetadata[i].contentType,
          size: blob.size,
          r2Key: uploadInfo.key,
          r2Url: uploadInfo.r2Url,
        });

        console.log(`[R2] ✓ Uploaded ${uploadInfo.filename} to R2`);
      } catch (error) {
        console.error(`[R2] Failed to upload ${uploadInfo.filename}:`, error);
        throw error;
      }
    }

    console.log(`[R2] Successfully uploaded ${uploads.length} files to R2`);
    return uploads;
  } finally {
    // Clean up temporary local files
    await cleanupLocalFiles(localFilesToCleanup);
  }
}

/**
 * Upload a single media file directly to R2 using a pre-generated upload URL.
 * Designed for use with runWithConcurrency for parallel uploads.
 */
export async function uploadSingleMediaFileToR2(
  media: { uri: string; type: "image" | "video"; assetId?: string },
  uploadInfo: { filename: string; uploadUrl: string; key: string; r2Url?: string },
  contentType: string
): Promise<{
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
  r2Url?: string;
}> {
  const localUri = await ensureLocalFile(media.uri, media.type, media.assetId);
  const localFilesToCleanup: string[] = [];
  if (localUri !== media.uri) localFilesToCleanup.push(localUri);

  try {
    let blob: Blob;
    try {
      const response = await fetch(localUri);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
      }
      blob = await response.blob();
    } catch (fetchError) {
      const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
      if (
        errorMessage.includes('3164') ||
        errorMessage.includes('PHPhotos') ||
        errorMessage.includes("operation couldn't be completed")
      ) {
        throw new Error(
          'This video is stored in iCloud and not available on your device. ' +
          'Please open the Photos app, find this video, and wait for it to fully download before trying again.'
        );
      }
      throw fetchError;
    }

    if (blob.size === 0) {
      throw new Error(
        'This video appears to still be downloading from iCloud. ' +
        'Please wait for the download to complete in the Photos app, then try again.'
      );
    }

    console.log(`[R2-single] Uploading ${uploadInfo.filename} (${formatFileSize(blob.size)})...`);

    const uploadResponse = await fetch(uploadInfo.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: blob,
    });

    if (!uploadResponse.ok) {
      throw new Error(`R2 upload failed: ${uploadResponse.statusText}`);
    }

    console.log(`[R2-single] ✓ Uploaded ${uploadInfo.filename}`);
    return {
      filename: uploadInfo.filename,
      contentType,
      size: blob.size,
      r2Key: uploadInfo.key,
      r2Url: uploadInfo.r2Url,
    };
  } finally {
    await cleanupLocalFiles(localFilesToCleanup);
  }
}

/**
 * Map app style preference to backend style
 */
export function mapStyleToBackend(
  style: "Playful" | "Professional" | "Dreamy"
): "playful" | "professional" | "travel" {
  const styleMap = {
    Playful: "playful",
    Professional: "professional",
    Dreamy: "travel",
  } as const;

  return styleMap[style];
}

/**
 * Map backend style to app style preference
 */
export function mapStyleToApp(
  style: "playful" | "professional" | "travel"
): "Playful" | "Professional" | "Dreamy" {
  const styleMap = {
    playful: "Playful",
    professional: "Professional",
    travel: "Dreamy",
  } as const;

  return styleMap[style];
}

/**
 * Calculate video generation progress based on project data
 */
export function calculateProgress(project: {
  script?: string;
  audioUrl?: string;
  musicUrl?: string;
  videoUrls?: string[];
}): {
  progress: number;
  stage: "script" | "audio" | "music" | "videos" | "complete";
  assetsReady: {
    script: boolean;
    audio: boolean;
    music: boolean;
    videos: boolean;
  };
} {
  const assetsReady = {
    script: !!project.script,
    audio: !!project.audioUrl,
    music: !!project.musicUrl,
    videos: (project.videoUrls?.length || 0) > 0,
  };

  const completedAssets = Object.values(assetsReady).filter(Boolean).length;
  const progress = (completedAssets / 4) * 100;

  // Determine current stage
  let stage: "script" | "audio" | "music" | "videos" | "complete";
  if (!assetsReady.script) {
    stage = "script";
  } else if (!assetsReady.audio) {
    stage = "audio";
  } else if (!assetsReady.music) {
    stage = "music";
  } else if (!assetsReady.videos) {
    stage = "videos";
  } else {
    stage = "complete";
  }

  return { progress, stage, assetsReady };
}

/**
 * Format phone number for backend (E.164 format)
 * @param phoneNumber - Raw phone number input
 * @param countryCode - Country code (default: "+1" for US)
 * @returns Formatted phone number
 */
export function formatPhoneNumber(
  phoneNumber: string,
  countryCode: string = "+1"
): string {
  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, "");

  // If it already starts with country code, return as is
  if (phoneNumber.startsWith("+")) {
    return phoneNumber;
  }

  // Add country code
  return `${countryCode}${digits}`;
}

/**
 * Validate OTP code format
 */
export function validateOTP(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/**
 * Format project creation timestamp
 */
export function formatProjectDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

/**
 * Get status display info
 */
export function getStatusInfo(
  status?: "processing" | "completed" | "failed" | "rendering"
): {
  label: string;
  color: string;
  icon: string;
} {
  switch (status) {
    case "processing":
      return { label: "Processing", color: "#FF6B35", icon: "⏳" };
    case "completed":
      return { label: "Ready", color: "#4CAF50", icon: "✓" };
    case "failed":
      return { label: "Failed", color: "#F44336", icon: "✗" };
    case "rendering":
      return { label: "Rendering", color: "#FFC107", icon: "🎬" };
    default:
      return { label: "Unknown", color: "#9E9E9E", icon: "?" };
  }
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`Attempt ${attempt + 1} failed:`, lastError.message);

      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("All retry attempts failed");
}

/**
 * Safe API call wrapper with error handling
 */
export async function safeAPICall<T>(
  apiCall: () => Promise<T>,
  errorMessage: string = "Operation failed"
): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    const data = await apiCall();
    return { success: true, data };
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : String(error) || errorMessage;
    console.error(errorMessage, errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Check if project is ready for viewing
 */
export function isProjectReady(project: {
  status?: string;
  videoUrls?: string[];
  renderedVideoUrl?: string;
}): boolean {
  if (project.status !== "completed") return false;
  return !!(project.renderedVideoUrl || (project.videoUrls?.length || 0) > 0);
}

/**
 * Get the best video URL from project
 * Prioritizes renderedVideoUrl over first videoUrl
 */
export function getProjectVideoUrl(project: {
  videoUrls?: string[];
  renderedVideoUrl?: string;
}): string | null {
  return (
    project.renderedVideoUrl ||
    (project.videoUrls && project.videoUrls.length > 0
      ? project.videoUrls[0]
      : null)
  );
}

/**
 * Estimate time remaining based on stage
 */
export function estimateTimeRemaining(
  stage: "script" | "audio" | "music" | "videos" | "complete"
): string {
  const estimates = {
    script: "~30 seconds",
    audio: "~20 seconds",
    music: "~15 seconds",
    videos: "~2 minutes",
    complete: "Done!",
  };

  return estimates[stage];
}

/**
 * Get friendly stage name for display
 */
export function getStageName(
  stage: "script" | "audio" | "music" | "videos" | "complete"
): string {
  const names = {
    script: "Writing script",
    audio: "Generating voiceover",
    music: "Creating background music",
    videos: "Animating images",
    complete: "Finalizing video",
  };

  return names[stage];
}

/**
 * Debounce function for search/input
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * Extract file extension from URI
 */
export function getFileExtension(uri: string): string {
  const match = uri.match(/\.([^./?]+)($|\?)/);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Check if file is a video based on URI
 */
export function isVideo(uri: string): boolean {
  const videoExtensions = ["mp4", "mov", "avi", "mkv", "webm"];
  const ext = getFileExtension(uri);
  return videoExtensions.includes(ext);
}

/**
 * Check if file is an image based on URI
 */
export function isImage(uri: string): boolean {
  const imageExtensions = ["jpg", "jpeg", "png", "gif", "webp", "heic"];
  const ext = getFileExtension(uri);
  return imageExtensions.includes(ext);
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

