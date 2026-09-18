export type StylePreference = 'Playful' | 'Professional' | 'Dreamy';

// Backend style mapping
export type BackendStyle = 'playful' | 'professional' | 'travel';

// Video generation phases for progress UI
export type GenerationPhase = 
  | 'preparing_media'  // FAL animations, TTS, music generation
  | 'video_agent'      // Claude editing the sequence
  | 'composing'        // FFMPEG/Remotion rendering
  | 'finalizing'       // Uploading to R2, getting URL
  | null;              // Not generating

export interface UserProfile {
  name: string;
  style: StylePreference;
  voiceRecordingUri?: string;
}

export interface Video {
  id: string;
  uri: string;
  prompt: string;
  name?: string; // AI-generated project name (e.g., "Summer Vibes")
  script?: string; // The actual generated script
  createdAt: number;
  status: 'draft' | 'pending' | 'processing' | 'preparing' | 'ready' | 'failed';
  projectId?: string;
  error?: string;
  thumbnailUrl?: string; // Thumbnail image URL for grid display
  duration?: number; // Video duration in seconds
}

// Chat message types for conversational script refinement
export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  projectId: string;
  role: ChatMessageRole;
  content: string;
  mediaIds?: string[];
  mediaUrls?: string[]; // Populated URLs for display
  isEdited?: boolean;
  originalContent?: string;
  createdAt: number;
  messageIndex?: number; // 1-10 for user messages
}

// Local chat message for UI before syncing with backend
export interface LocalChatMessage {
  id: string; // Temporary local ID
  role: ChatMessageRole;
  content: string;
  mediaUris?: Array<{ uri: string; type: 'image' | 'video'; storageId?: string }>;
  isEdited?: boolean;
  createdAt: number;
  isLoading?: boolean; // For AI response loading state
  isError?: boolean; // Script generation failed — show retry affordance
}

// Convex types placeholder - will be replaced with generated types
export type ConvexId<T extends string> = string & { __tableName: T };
