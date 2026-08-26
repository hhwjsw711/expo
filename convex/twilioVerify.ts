"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Verify OTP using Twilio Verify (production)
export const verifyTwilioOTP = action({
  args: {
    phone: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; userId?: Id<"users">; onboardingCompleted?: boolean }> => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!accountSid || !authToken || !verifyServiceSid) {
      throw new Error("Twilio Verify not configured");
    }

  let Twilio: any;
  try {
    Twilio = (await import("twilio")).default;
  } catch {
    throw new Error("twilio package not installed. Run: npm install twilio");
  }
  const client = Twilio(accountSid, authToken);

    try {
      const verificationCheck = await client.verify.v2
        .services(verifyServiceSid)
        .verificationChecks.create({
          to: args.phone,
          code: args.code,
        });

      if (verificationCheck.status === "approved") {
        const result = await ctx.runMutation(internal.users.getOrCreateUser, {
          phone: args.phone,
        });

        return {
          success: true,
          userId: result.userId,
          onboardingCompleted: result.onboardingCompleted,
        };
      } else {
        throw new Error("Invalid verification code");
      }
    } catch (error: any) {
      console.error("[twilioVerify] error:", error);
      throw new Error(`Verification failed: ${error.message}`);
    }
  },
});
