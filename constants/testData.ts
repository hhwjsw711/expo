/**
 * Test Data for Screenshot Automation
 * 
 * This file contains mock data that can be used during automated testing
 * to simulate various app states without requiring real backend data.
 * 
 * Usage:
 * 1. Import this data in screens when ENABLE_TEST_RUN_MODE is true
 * 2. Use the mock data to render screens with realistic content
 */

// Test credentials for automated login
export const TEST_CREDENTIALS = {
  phone: '0000000000',
  password: 'rYSHRfLTy8D07n',
};

// Mock user profile
export const MOCK_USER = {
  id: 'test-user-123',
  name: 'Kate',
  phone: '+10000000000',
  style: 'Professional',
  onboardingCompleted: true,
  voiceRecordingUri: null,
};

// Mock project for script review
export const MOCK_PROJECT = {
  id: 'test-project-123',
  userId: 'test-user-123',
  prompt: 'My amazing trip to San Francisco - visited the Golden Gate Bridge, explored Fisherman\'s Wharf, and had the best sourdough bread ever!',
  status: 'script_generated',
  script: `Hey everyone! So I just got back from the most incredible trip to San Francisco, and I have to share this with you.

First stop - the Golden Gate Bridge. I know, I know, it's such a tourist thing to do, but standing there, watching the fog roll in... it hits different when you're actually there.

Then I wandered down to Fisherman's Wharf. The sea lions were absolutely hilarious - just lounging around like they owned the place. Which, I guess they kind of do?

But the real highlight? The sourdough bread. Listen, I thought I knew what good bread tasted like. I was wrong. This changed everything.

San Francisco, you've got my heart. Can't wait to come back!`,
  fileUrls: [
    'https://example.com/golden-gate.jpg',
    'https://example.com/fishermans-wharf.jpg',
    'https://example.com/sourdough.jpg',
  ],
  thumbnailUrl: 'https://example.com/golden-gate.jpg',
  createdAt: new Date().toISOString(),
};

// Mock video result
export const MOCK_VIDEO_RESULT = {
  projectId: 'test-project-123',
  videoUrl: 'https://example.com/rendered-video.mp4',
  duration: 45,
  status: 'completed',
  renderProgress: 100,
};

// Mock feed items (past projects)
export const MOCK_FEED_ITEMS = [
  {
    id: 'project-1',
    thumbnailUrl: 'https://example.com/thumb-1.jpg',
    title: 'San Francisco Trip',
    duration: 45,
    createdAt: '2024-01-10T10:00:00Z',
    status: 'completed',
  },
  {
    id: 'project-2',
    thumbnailUrl: 'https://example.com/thumb-2.jpg',
    title: 'Birthday Party',
    duration: 32,
    createdAt: '2024-01-08T14:30:00Z',
    status: 'completed',
  },
  {
    id: 'project-3',
    thumbnailUrl: 'https://example.com/thumb-3.jpg',
    title: 'Weekend Hiking',
    duration: 28,
    createdAt: '2024-01-05T09:15:00Z',
    status: 'completed',
  },
];

// Mock subscription/paywall data
export const MOCK_SUBSCRIPTION = {
  isSubscribed: false,
  plan: null,
  features: {
    videosPerMonth: 3,
    videosRemaining: 1,
    maxVideoDuration: 60,
    hdExport: false,
    removeWatermark: false,
  },
};

/**
 * Test Mode Data
 * 
 * This data is used when ENABLE_TEST_RUN_MODE is true in config.ts
 * 
 * In test mode:
 * - NO API calls are made (no uploads, no AI, no rendering)
 * - The local video file is used directly
 * - The predefined script is displayed
 */
export const TEST_MODE_DATA = {
  // Prompt shown in the composer (for display purposes)
  prompt: 'Bay Bridge sunset view after work - the perfect end to a productive day.',
  
  // Pre-generated script (shown instead of calling AI script generation)
  script: `Just finished up work with this incredible Bay Bridge sunset view, and honestly it was exactly what I needed today. There's something about watching the city lights start to twinkle across the water that just puts everything in perspective. Sometimes the best office is wherever you can catch a moment like this.`,

  // Local video file path - set to null for production builds
  // The actual video file (assets/test-video.mp4) is excluded from TestFlight via .easignore
  // For local testing with ENABLE_TEST_RUN_MODE=true, add the video file to assets/
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  localVideoPath: require('../assets/test-video.mp4'),
  
  // Placeholder media files for the composer preview
  // These are just for UI display - no real files are uploaded in test mode
  mediaFiles: [
    {
      uri: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=Media+1',
      type: 'image' as const,
      id: 'test-media-1',
    },
    {
      uri: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=Media+2',
      type: 'image' as const,
      id: 'test-media-2',
    },
    {
      uri: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=Media+3',
      type: 'image' as const,
      id: 'test-media-3',
    },
  ],
};

// Legacy export for backward compatibility
export const E2E_TEST_PROJECT = TEST_MODE_DATA;

// Helper function to get mock data based on screen
export function getMockDataForScreen(screenName: string) {
  switch (screenName) {
    case 'feed':
      return { user: MOCK_USER, items: MOCK_FEED_ITEMS };
    case 'script-review':
      return { project: MOCK_PROJECT };
    case 'video-preview':
      return { project: MOCK_PROJECT, video: MOCK_VIDEO_RESULT };
    case 'result':
      return { project: MOCK_PROJECT, video: MOCK_VIDEO_RESULT };
    case 'settings':
      return { user: MOCK_USER, subscription: MOCK_SUBSCRIPTION };
    case 'paywall':
      return { subscription: MOCK_SUBSCRIPTION };
    default:
      return {};
  }
}
