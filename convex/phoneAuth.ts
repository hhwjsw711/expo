"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

// Generate a 6-digit OTP code (for development mode)
function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP using Twilio Verify (production)
// Uses dynamic import with try/catch so the twilio package is only needed
// when USE_TWILIO_VERIFY is true (production). In dev mode, OTP is logged to console.
async function sendVerifyOTP(phone: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !verifyServiceSid) {
    throw new Error(
      "Twilio Verify not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID."
    );
  }

  let Twilio: any;
  try {
    Twilio = (await import("twilio")).default;
  } catch {
    throw new Error(
      "twilio package not installed. Run: npm install twilio"
    );
  }
  const client = Twilio(accountSid, authToken);

  try {
    await client.verify.v2
      .services(verifyServiceSid)
      .verifications.create({
        to: phone,
        channel: "sms",
      });
  } catch (error: any) {
    console.error("Twilio Verify error:", error);
    throw new Error(`Failed to send verification: ${error.message}`);
  }
}

// Send OTP code via SMS
export const sendOTP = action({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    // Rate limit FIRST, before any Twilio call: a per-phone 60s cooldown
    // bounds SMS-bombing and Twilio cost attacks on both delivery paths.
    const rateLimit = await ctx.runMutation(
      internal.users.internalCheckOtpRateLimit,
      { phone: args.phone }
    );
    if (!rateLimit.ok) {
      const retryAfterSec = Math.ceil(rateLimit.retryAfterMs / 1000);
      console.warn(`[phoneAuth] rate limited ${args.phone}: retry in ${retryAfterSec}s`);
      return {
        success: false,
        message: `Please wait ${retryAfterSec}s before requesting another code.`,
        rateLimited: true,
        useTwilioVerify: false,
      };
    }

    const useTwilioVerify =
      process.env.USE_TWILIO_VERIFY === "true" ||
      process.env.NODE_ENV === "production";

    if (useTwilioVerify) {
      try {
        await sendVerifyOTP(args.phone);
        console.log(`[phoneAuth] Twilio Verify OTP sent to ${args.phone}`);
        return {
          success: true,
          message: "OTP sent via SMS",
          useTwilioVerify: true,
        };
      } catch (error: any) {
        console.error("[phoneAuth] Twilio Verify failed:", error);
        // In production, do not fall back to dev mode — throw the error
        if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_OTP_FALLBACK !== "true") {
          throw new Error(`Failed to send verification: ${error.message}`);
        }
        // In development or when fallback is explicitly allowed, use dev mode
        console.warn("[phoneAuth] Falling back to dev mode OTP");
        const code = generateOTP();
        const expiresAt = Date.now() + 10 * 60 * 1000;
        await ctx.runMutation(internal.users.storeOTP, {
          phone: args.phone,
          code,
          expiresAt,
        });
        console.log(`[phoneAuth] OTP for ${args.phone}: ${code} (dev fallback)`);
        return {
          success: true,
          message: "OTP sent (check console)",
          error: error.message,
          useTwilioVerify: false,
        };
      }
    } else {
      // Development mode: generate and store OTP locally
      const code = generateOTP();
      const expiresAt = Date.now() + 10 * 60 * 1000;

      await ctx.runMutation(internal.users.storeOTP, {
        phone: args.phone,
        code,
        expiresAt,
      });

      console.log(`[phoneAuth] OTP for ${args.phone}: ${code}`);
      return {
        success: true,
        message: "OTP logged to console (development mode)",
        useTwilioVerify: false,
      };
    }
  },
});
