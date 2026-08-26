/**
 * Centralized AI Prompts Configuration
 * 
 * This file contains all prompts used across different AI services.
 * Modify these prompts to change the behavior of AI generations without touching the service code.
 */

export const prompts = {
  /**
   * Script Generation (DeepSeek via OpenRouter / OpenAI compatible)
   * Used to generate 15-second social media video scripts
   */
  scriptGeneration: {
    system: (style: string = "professional") => `



You are a writing engine. Produce only the final script text for a 15-second short-form video (IG/TikTok/YouTube Shorts).

Hard constraints (must follow exactly):

- Output plain text only: no quotation marks, no brackets of any kind, no parentheses, no asterisks, no emojis, no hashtags, no markdown, no code fences, no labels or headings.

- Do not include stage directions or actions. Do not describe visuals. Do not add speaker names.

- Use 35–55 words, 3–5 sentences, with a concise hook as the first sentence.

- Tone: keep ${style}; avoid hype and filler.

- If company names or terms need context, add one short clause of background only.

- Add a clear why-it-matters/value takeaway.

- Do not mention "hook," "CTA," or any instructions. Do not address the user.

You may analyze attached images or video frames to infer context, but never describe them; reflect that understanding only through the wording of the script.

Before sending, remove any quotation marks, brackets, parentheses, emojis, labels, and directions. Send only the script text as continuous sentences.

`,
    user: (prompt: string, style: string = "professional") => `You are a social media manager creating a 15-second script. Use the info below. 

Remember: plain text only, no quotes, no brackets, no stage directions, no emojis.

Context:

- ${prompt}

- Style variable: ${style}

Return only the script text.

`,
  },

  /**
   * Music Generation
   * Used to generate background music for social media videos
   */
  musicGeneration: {
    prompt: (style: string = "professional") => `light background music for ${style} social media video`,
    // Alternative styles you can use:
    // funky: "modern jazz with improv elements and funky beats",
    // electronic: "upbeat synthwave with energetic electronic grooves",
    // lofi: "chill lo-fi hip-hop with mellow relaxing vibes",
    // cinematic: "inspiring cinematic orchestral score with emotional build",
    // acoustic: "warm indie pop with acoustic guitar tones",
  },

  /**
   * FAL AI Image Animation
   * Used to animate static images into videos
   */
  imageAnimation: {
    default: "slightly animate it",
    // More animation options:
    // subtle: "gentle camera movement with minimal animation",
    // dynamic: "dynamic camera movements with energetic motion",
    // smooth: "smooth cinematic pan and zoom",
    // dramatic: "dramatic parallax effect with depth",
  },

  /**
   * Claude Video Editor (Remotion)
   * Used by Claude Code agent to create video compositions in the E2B sandbox
   */
  videoEditor: {
    /**
     * Generates the prompt for Claude to edit videos using Remotion
     * @param userPrompt - The user's original project prompt for emotional context
     * @returns The full prompt for Claude video editor
     */
    generate: (userPrompt: string = 'create an engaging social media video') => `remotion.dev - edit the existing Main composition in src/Root.tsx using the media files in public/media/.

CRITICAL RULES:
1. Do NOT run "bun remotion render" - rendering is handled separately.
2. Do NOT run "bun add" to install any @remotion/* packages - they are already installed. Adding packages will cause version mismatch errors.
3. Do NOT call any external APIs or upload files anywhere.
4. Do NOT generate SRT files - subtitles.srt already exists in public/media/.
5. Edit the EXISTING composition with id="Main" in src/Root.tsx. Do NOT create new compositions with other names.

MEDIA FILES available in public/media/ (use ls to see them):
- video0.mp4, video1.mp4, ... (FAL-animated videos, silent, H264 MP4) - use staticFile('media/video0.mp4') etc.
- audio.mp3 (TTS voiceover) - use staticFile('media/audio.mp3')
- music.mp3 (background music, if present) - use staticFile('media/music.mp3')
- subtitles.srt (subtitle file) - use staticFile('media/subtitles.srt')

TASK:
1. Run: ls -la public/media/ to see all available files.
2. Run: ffprobe -v error -show_entries format=duration -of csv=p=0 public/media/audio.mp3 to get audio duration.
3. Extract first frame from each video: ffmpeg -i public/media/videoN.mp4 -vframes 1 -f image2 /tmp/frameN.jpg
4. Look at the frames to understand what's in each video.
5. Edit the Main composition in src/Root.tsx to create a video that:
   - Is portrait (e.g. 1080x1920)
   - Uses 30fps
   - Has durationInFrames matching the audio duration (duration_in_seconds * 30, rounded)
   - Selects 1-4 second segments from each video, organized in order based on the freeze frames
   - Starts with the most interesting shot
   - Includes the Audio component using audio.mp3 (the TTS voiceover) - this is REQUIRED
   - If music.mp3 exists, include it as background music at low volume
   - Bakes in subtitles from subtitles.srt (see https://www.remotion.dev/docs/recorder/exporting-subtitles#burn-subtitles)
   - Total duration of all video segments MUST equal the audio duration - NO frozen frames at the end

we use bun btw

composition should be portrait!

REMINDER: After editing src/Composition.tsx, you MUST write /home/user/timeline.json (see system prompt for format). This is required for the mobile app to preview and edit your composition.`,

  },
};

export default prompts;
