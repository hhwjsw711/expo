import { ConvexReactClient } from "convex/react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  console.warn(
    "EXPO_PUBLIC_CONVEX_URL not set. Please add it to your .env file."
  );
}

export const convex = new ConvexReactClient(convexUrl || "");

// JWT auth: call convex.setAuth(jwt) after login. Convex automatically
// attaches the token to every request and refreshes it before expiry.
// Note: ConvexReactClient.setAuth expects an AuthTokenFetcher (async fn)
// returning the token (or null). We read the JWT from AsyncStorage so the
// client can re-fetch it on refresh.
const JWT_STORAGE_KEY = "@reelfull_jwt";

export async function getStoredJwt(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(JWT_STORAGE_KEY);
  } catch (error) {
    console.error("Error reading jwt from storage:", error);
    return null;
  }
}

export function setAuthToken(token: string | null) {
  if (token) {
    // Persist so the fetcher can re-read it on refresh
    AsyncStorage.setItem(JWT_STORAGE_KEY, token).catch((error) =>
      console.error("Error saving jwt:", error)
    );
    convex.setAuth(() => getStoredJwt());
  } else {
    convex.clearAuth();
  }
}

export default convex;

