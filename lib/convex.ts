import { ConvexReactClient } from "convex/react";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  console.warn(
    "EXPO_PUBLIC_CONVEX_URL not set. Please add it to your .env file."
  );
}

export const convex = new ConvexReactClient(convexUrl || "");

export default convex;

