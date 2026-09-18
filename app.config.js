module.exports = ({ config }) => {
  // Get the Convex URL from environment variables or use dev URL.
  // The dev deployment (vibrant-chinchilla-116) contains the backdoor test
  // user and all test data. Production is only used when explicitly set via
  // EXPO_PUBLIC_CONVEX_URL in the build environment (e.g. EAS Production).
  const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL || 'https://vibrant-chinchilla-116.convex.cloud';

  console.log('[app.config.js] Convex URL:', convexUrl);

  return {
    ...config,
    name: 'Wordream',
    slug: 'wordream',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: 'wordream',
    userInterfaceStyle: 'automatic',
    newArchEnabled: false,
    splash: {
      image: './assets/images/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#FAF9F5',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'app.wordream',
      infoPlist: {
        UIBackgroundModes: ['audio'],
        NSMicrophoneUsageDescription: 'Allow $(PRODUCT_NAME) to access your microphone',
        NSPhotoLibraryUsageDescription: 'Allow $(PRODUCT_NAME) to access your photos',
        NSCameraUsageDescription: 'Allow $(PRODUCT_NAME) to access your camera',
        NSPhotoLibraryAddUsageDescription: 'Allow $(PRODUCT_NAME) to save photos.',
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/adaptive-icon.png',
        backgroundColor: '#FAF9F5',
      },
      package: 'app.wordream',
      permissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.CAMERA',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.INTERNET',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
        'android.permission.ACCESS_MEDIA_LOCATION',
      ],
    },
    web: {
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      [
        'expo-build-properties',
        {
          ios: {
            // Exclude react-native-maps from iOS autolinking (transitive dependency not compatible with RN 0.81)
            excludedAutolinkedLibraries: ['react-native-maps'],
          },
        },
      ],
      [
        'expo-router',
        {},
      ],
      [
        'expo-notifications',
        {
          color: '#F36A3F',
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission: 'The app accesses your photos to let you share them with your friends.',
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission: 'Allow $(PRODUCT_NAME) to access your photos.',
          savePhotosPermission: 'Allow $(PRODUCT_NAME) to save photos.',
          isAccessMediaLocationEnabled: true,
        },
      ],
      'expo-font',
      'expo-web-browser',
      'expo-video',
      'expo-asset',
      'expo-image',
      'expo-splash-screen',
      'expo-status-bar',
      'expo-audio',
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      eas: {
        projectId: '95ef7fac-84a1-4ef8-a6f2-c13576620add',
      },
      // Make convexUrl available through extra - always include it
      convexUrl: convexUrl,
    },
  };
};

