import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, router, useGlobalSearchParams, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useCallback, useEffect, useRef } from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ConvexProvider, ConvexReactClient , useMutation } from "convex/react";
import { AppProvider, useApp } from "@/contexts/AppContext";
import { PaywallProvider } from "@/contexts/PaywallContext";
import * as Font from 'expo-font';
import * as Notifications from 'expo-notifications';
import { registerForPushNotificationsAsync } from "@/lib/videoPollingService";
import { api } from "@/convex/_generated/api";
import Constants from 'expo-constants';
import Colors from "@/constants/colors";
import IPhoneFrameWrapper from "@/components/IPhoneFrameWrapper";

SplashScreen.preventAutoHideAsync();

const foregroundNotificationContext: {
  pathname: string;
  appState: AppStateStatus;
  activeChatProjectId?: string;
} = {
  pathname: "",
  appState: AppState.currentState,
  activeChatProjectId: undefined,
};

// Configure notification behavior when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as { type?: string; projectId?: string };
    
    // Suppress script-ready notifications when user is actively on chat composer
    // (same chat, or unknown active project while composing a new chat).
    if (data?.type === 'script_ready') {
      const incomingProjectId = typeof data.projectId === "string" ? data.projectId : undefined;
      const isOnChatComposer =
        foregroundNotificationContext.appState === "active" &&
        foregroundNotificationContext.pathname === "/chat-composer";
      const isDifferentChat =
        !!incomingProjectId &&
        !!foregroundNotificationContext.activeChatProjectId &&
        incomingProjectId !== foregroundNotificationContext.activeChatProjectId;

      if (isOnChatComposer && !isDifferentChat) {
        return {
          shouldShowAlert: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
          shouldShowBanner: false,
          shouldShowList: false,
        };
      }

      return {
        shouldShowAlert: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      };
    }
    
    // Show other notifications (like video_ready) even when app is open
    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});

const queryClient = new QueryClient();

// Initialize Convex client
// Try multiple sources for the Convex URL
const convexUrl = 
  process.env.EXPO_PUBLIC_CONVEX_URL || 
  Constants.expoConfig?.extra?.convexUrl ||
  'https://industrious-ibex-578.convex.cloud';

console.log('[App] Initializing Convex client...');
console.log('[App] process.env.EXPO_PUBLIC_CONVEX_URL:', process.env.EXPO_PUBLIC_CONVEX_URL);
console.log('[App] Constants.expoConfig.extra.convexUrl:', Constants.expoConfig?.extra?.convexUrl);
console.log('[App] Final Convex URL:', convexUrl);

if (!process.env.EXPO_PUBLIC_CONVEX_URL) {
  console.warn('[App] EXPO_PUBLIC_CONVEX_URL is not set in process.env. Using fallback.');
}

const convex = new ConvexReactClient(convexUrl);
console.log('[App] Convex client created with URL:', convexUrl);

function AppContent() {
  const { userId } = useApp();
  const updatePushToken = useMutation(api.users.updatePushToken);
  const notificationListener = useRef<Notifications.EventSubscription | null>(null);
  const responseListener = useRef<Notifications.EventSubscription | null>(null);
  const lastHandledNavigationRef = useRef<string | null>(null);
  const pathname = usePathname();
  const globalParams = useGlobalSearchParams<{ projectId?: string | string[] }>();
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const navigateToProjectChat = useCallback((projectId: string) => {
    const dedupeKey = `script_ready:${projectId}`;
    if (lastHandledNavigationRef.current === dedupeKey) {
      return;
    }
    lastHandledNavigationRef.current = dedupeKey;
    setTimeout(() => {
      if (lastHandledNavigationRef.current === dedupeKey) {
        lastHandledNavigationRef.current = null;
      }
    }, 1500);

    const currentProjectId = Array.isArray(globalParams.projectId)
      ? globalParams.projectId[0]
      : globalParams.projectId;

    if (pathname === '/chat-composer' && currentProjectId === projectId) {
      return;
    }

    router.navigate({
      pathname: '/chat-composer',
      params: { projectId },
    });
  }, [globalParams.projectId, pathname]);

  useEffect(() => {
    // Register for push notifications when user is authenticated
    if (userId) {
      registerForPushNotificationsAsync()
        .then(async (token) => {
          if (token) {
            console.log('[App] Registering push token with backend...');
            try {
              await updatePushToken({ userId, pushToken: token });
              console.log('[App] Push token registered successfully');
            } catch (error) {
              console.error('[App] Failed to register push token:', error);
            }
          }
        })
        .catch((error) => {
          console.error('[App] Error registering for push notifications:', error);
        });
    }
  }, [userId]);

  useEffect(() => {
    const currentProjectId = Array.isArray(globalParams.projectId)
      ? globalParams.projectId[0]
      : globalParams.projectId;

    foregroundNotificationContext.pathname = pathname;
    foregroundNotificationContext.appState = appStateRef.current;
    foregroundNotificationContext.activeChatProjectId =
      pathname === "/chat-composer" && currentProjectId ? String(currentProjectId) : undefined;
  }, [pathname, globalParams.projectId]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
      foregroundNotificationContext.appState = nextState;
    });

    return () => subscription.remove();
  }, []);

  // Handle notification taps (when user taps on a notification)
  useEffect(() => {
    // Handle notifications received while app is in foreground
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      console.log('[App] Notification received in foreground:', notification);
    });

    // Handle notification taps (user interaction)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data as { type?: string; projectId?: string };
      console.log('[App] Notification tapped:', data);

      if (data?.type === 'script_ready' && data?.projectId) {
        // Navigate to chat composer to view/refine the script
        console.log('[App] Navigating to chat-composer for project:', data.projectId);
        navigateToProjectChat(data.projectId as string);
      } else if (data?.type === 'video_ready') {
        if (data?.projectId) {
          // Navigate to video preview screen
          console.log('[App] Navigating to video-preview for project:', data.projectId);
          router.push({
            pathname: '/video-preview',
            params: { projectId: data.projectId as string },
          });
        } else {
          // No projectId (older local notification) — navigate to feed where user can see the ready video
          console.log('[App] video_ready notification without projectId, navigating to feed');
          router.navigate('/(tabs)');
        }
      } else if (data?.type === 'video_failed') {
        if (data?.projectId) {
          // Navigate to chat composer so user can retry
          console.log('[App] Navigating to chat-composer for failed project:', data.projectId);
          navigateToProjectChat(data.projectId as string);
        } else {
          // No projectId — navigate to feed
          console.log('[App] video_failed notification without projectId, navigating to feed');
          router.navigate('/(tabs)');
        }
      }
    });

    return () => {
      if (notificationListener.current) {
        notificationListener.current.remove();
      }
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [navigateToProjectChat]);

  return (
    <Stack screenOptions={{
      headerShown: false,
      contentStyle: { backgroundColor: Colors.dark },
    }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
      <Stack.Screen name="chat-composer" options={{ gestureEnabled: false }} />
      <Stack.Screen name="video-preview" options={{ gestureEnabled: false }} />
      <Stack.Screen name="video-editor" options={{ gestureEnabled: false, animation: 'slide_from_right' }} />
      <Stack.Screen name="loader" options={{ gestureEnabled: false }} />
      <Stack.Screen name="result" options={{ gestureEnabled: false, animation: 'none' }} />
      <Stack.Screen 
        name="settings" 
        options={{ 
          presentation: Platform.OS === 'web' ? 'card' : 'transparentModal',
          animation: 'none',
          contentStyle: { backgroundColor: 'transparent' }
        }} 
      />
      <Stack.Screen 
        name="paywall" 
        options={{ 
          presentation: Platform.OS === 'web' ? 'card' : 'transparentModal',
          animation: Platform.OS === 'web' ? 'none' : 'fade',
          contentStyle: { backgroundColor: 'transparent' },
        }} 
      />
      <Stack.Screen 
        name="profile" 
        options={{ 
          animation: 'slide_from_right',
        }} 
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, setFontsLoaded] = React.useState(false);

  useEffect(() => {
    async function loadFonts() {
      try {
        await Font.loadAsync({
          'PPNeueMontreal-Book': require('../assets/fonts/PPNeueMontreal-Book.otf'),
          'PPNeueMontreal-Medium': require('../assets/fonts/PPNeueMontreal-Medium.otf'),
          'PPNeueMontreal-Bold': require('../assets/fonts/PPNeueMontreal-Bold.otf'),
          'PPNeueMontreal-Italic': require('../assets/fonts/PPNeueMontreal-Italic.otf'),
          'Inter_400Regular': require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
          'Inter_600SemiBold': require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
          'Inter_700Bold': require('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'),
        });
        setFontsLoaded(true);
      } catch (error) {
        console.error('[App] Error loading fonts:', error);
        setFontsLoaded(true); // Continue even if fonts fail
      }
    }
    loadFonts();
  }, []);

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {
        // Ignore error - can happen when modal is presented
      });
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <IPhoneFrameWrapper>
      <ConvexProvider client={convex}>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1, backgroundColor: Colors.dark }}>
            <AppProvider>
              <PaywallProvider>
                <AppContent />
              </PaywallProvider>
            </AppProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ConvexProvider>
    </IPhoneFrameWrapper>
  );
}
