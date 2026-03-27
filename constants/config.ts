/**
 * App Configuration
 * 
 * Toggle these flags to enable/disable features for dev vs prod builds
 */

/**
 * Test Run Mode Configuration
 * 
 * When enabled (true), the app will:
 * - Skip ALL API calls (no uploads, no AI script generation, no video rendering)
 * - Use predefined test script from testData.ts
 * - Use local video file from .maestro/test-data/
 * 
 * When disabled (false):
 * - Run the full production flow with all API calls
 * 
 * Set this to true when running Maestro tests or testing the UI flow.
 */
export const ENABLE_TEST_RUN_MODE = false;

// Set to false to hide style preference during onboarding and settings
// When hidden, the default style "professional" is used automatically
// This should be false when using Claude v2 pipeline (USE_CLAUDE_SCRIPT_GENERATION=true)
// as the v2 pipeline uses a fixed conversational style
export const ENABLE_STYLE_PREFERENCE = false;

// Default style used when ENABLE_STYLE_PREFERENCE is false
export const DEFAULT_STYLE = "professional";

// You can add more feature flags here as needed
// export const ENABLE_DEBUG_LOGGING = true;
// export const ENABLE_ANALYTICS = false;

