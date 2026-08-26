"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

// Minimal R2 storage stub.
// The full implementation uses Cloudflare R2 for direct file uploads from mobile.
// Since R2 credentials are not configured, this fallback uses Convex's built-in
// file storage to generate upload URLs instead.
//
// To enable real R2 storage:
//   1. Install @convex-dev/r2 component
//   2. Set R2 credentials: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   3. Replace this file with the full r2Storage.ts implementation

// Fallback: generate Convex upload URLs in place of R2 presigned URLs.
// The frontend expects: { filename, uploadUrl, key, r2Url? }
// We provide Convex upload URLs. The frontend will try PUT first, then fall back to POST
// (Convex upload URLs require POST). The frontend extracts storageId from the POST response
// and passes it to importR2FileToConvexStorage.
export const generateMultipleR2UploadUrls = action({
  args: {
    files: v.array(
      v.object({
        filename: v.string(),
        contentType: v.string(),
      })
    ),
  },
  handler: async (ctx, { files }) => {
    console.log("[r2Storage] Generating upload URLs for", files.length, "files (using Convex storage fallback)");

    const results = [];
    for (const file of files) {
      // ctx.storage.generateUploadUrl() is only available in mutations, not actions.
      // Use the generateUploadUrl mutation from tasks.ts via runMutation.
      const uploadUrl: string = await ctx.runMutation(api.tasks.generateUploadUrl, {});
      // Generate a pseudo R2 key for compatibility with frontend logic
      const key = `uploads/${Date.now()}-${Math.random().toString(36).substring(2)}-${file.filename}`;
      results.push({
        filename: file.filename,
        uploadUrl,
        key,
        r2Url: undefined, // No R2 URL in fallback mode
      });
    }

    return results;
  },
});
