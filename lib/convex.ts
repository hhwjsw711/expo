import { ConvexReactClient } from "convex/react";
import Constants from 'expo-constants';

// Single source of truth for the Convex client instance.
// AppContext calls setAuth/clearAuth on this instance,
// and _layout.tsx passes it to ConvexProvider so all UI
// hooks (useQuery, useMutation, useAction) share the same
// client — ensuring JWT is attached to every request.
const convexUrl =
  process.env.EXPO_PUBLIC_CONVEX_URL ||
  Constants.expoConfig?.extra?.convexUrl ||
  'https://quick-echidna-290.convex.cloud';

if (!process.env.EXPO_PUBLIC_CONVEX_URL) {
  console.warn(
    '[convex] EXPO_PUBLIC_CONVEX_URL not set. Falling back to:',
    convexUrl
  );
}

export const convex = new ConvexReactClient(convexUrl);

export default convex;
