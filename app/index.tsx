import { useRouter } from 'expo-router';
import { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  View,
  Text,
  Animated,
  ActivityIndicator,
  Dimensions,
  Easing,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { Fonts } from '@/constants/typography';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';
import { getScreenDimensions } from '@/lib/dimensions';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenDimensions();

// Base reel size for non-logged-in users
const REEL_SIZE_DEFAULT = SCREEN_WIDTH * 2;
// Larger reel size for logged-in users (no buttons shown)
const REEL_SIZE_LOGGED_IN = SCREEN_WIDTH * 2.5;

export default function IntroScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId, isLoading } = useApp();
  const [hasNavigated, setHasNavigated] = useState(false);
  const [showButtons, setShowButtons] = useState(false);

  // Dynamic reel size based on login state
  const isLoggedIn = !!userId;
  const reelSize = isLoggedIn ? REEL_SIZE_LOGGED_IN : REEL_SIZE_DEFAULT;

  // Animation values
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const reelRotation = useRef(new Animated.Value(0)).current;
  const titleFade = useRef(new Animated.Value(0)).current;
  const reelFade = useRef(new Animated.Value(0)).current;

  // Continuous reel rotation - start immediately and run forever
  useEffect(() => {
    const rotateAnimation = Animated.loop(
      Animated.timing(reelRotation, {
        toValue: 1,
        duration: 6000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    rotateAnimation.start();
    return () => rotateAnimation.stop();
  }, []);

  // Initial entrance animation – faster for returning users so the reel is
  // visible for the full duration of the brief splash screen.
  useEffect(() => {
    if (isLoading) return;

    const quick = !!userId;
    Animated.parallel([
      Animated.timing(titleFade, {
        toValue: 1,
        duration: quick ? 250 : 800,
        delay: quick ? 0 : 300,
        useNativeDriver: true,
      }),
      Animated.timing(reelFade, {
        toValue: 1,
        duration: quick ? 250 : 1000,
        delay: quick ? 0 : 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, [titleFade, reelFade, userId, isLoading]);

  // Navigate to the appropriate screen
  const navigateToNextScreen = () => {
    if (hasNavigated) return;
    setHasNavigated(true);

    if (userId) {
      if (ENABLE_TEST_RUN_MODE) {
        router.replace('/onboarding');
      } else {
        router.replace('/(tabs)');
      }
    } else {
      router.replace('/auth');
    }
  };

  // Handle navigation based on user state
  useEffect(() => {
    if (isLoading) return;

    if (userId) {
      // User is already authenticated
      if (ENABLE_TEST_RUN_MODE) {
        // Test mode: wait for user to tap anywhere on screen
        // Navigation will happen via handleScreenTap
        return;
      } else {
        // Normal mode: show intro for 2 seconds then go to feed
        const timer = setTimeout(() => {
          navigateToNextScreen();
        }, 2000);
        return () => clearTimeout(timer);
      }
    } else {
      // New user - show buttons after 1.5 seconds with fade-in animation
      const timer = setTimeout(() => {
        setShowButtons(true);
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }).start();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [fadeAnim, userId, isLoading]);

  // Handle tap on screen (for test mode when logged in)
  const handleScreenTap = () => {
    if (ENABLE_TEST_RUN_MODE && userId && !hasNavigated) {
      navigateToNextScreen();
    }
  };

  const spin = reelRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Show tap hint for test mode when logged in
  const showTapHint = ENABLE_TEST_RUN_MODE && isLoggedIn && !isLoading;
  // Show skip button for normal mode when logged in
  const showSkipButton = !ENABLE_TEST_RUN_MODE && isLoggedIn && !isLoading;

  return (
    <TouchableOpacity 
      style={styles.container} 
      activeOpacity={1}
      onPress={handleScreenTap}
      disabled={!showTapHint}
    >
      {/* Title at top left */}
      <Animated.View
        style={[
          styles.titleContainer,
          { paddingTop: insets.top + 40, opacity: titleFade },
        ]}
      >
        <Text style={styles.title}>Reelful</Text>
      </Animated.View>

      {/* Rotating film reel on right side */}
      <Animated.View
        style={[
          styles.reelContainer,
          {
            opacity: reelFade,
            // Dynamic sizing based on login state
            width: reelSize,
            height: reelSize,
            right: -reelSize * (isLoggedIn ? 0.54 : 0.52),
            top: isLoggedIn ? '52%' : '48%',
            marginTop: -reelSize * 0.5,
          },
        ]}
      >
        <Animated.Image
          source={require('../assets/images/reel.png')}
          style={[
            styles.reelImage,
            {
              transform: [{ rotate: spin }],
              width: reelSize * 0.95,
              height: reelSize * 0.95,
            },
          ]}
          resizeMode="contain"
        />
      </Animated.View>

      {/* Bottom section with button and terms */}
      {showButtons && (
        <Animated.View
          style={[
            styles.bottomSection,
            { paddingBottom: insets.bottom + 24, opacity: fadeAnim },
          ]}
        >
          {/* Get Started button */}
          <TouchableOpacity
            style={styles.button}
            onPress={() => {
              setHasNavigated(true);
              router.replace('/auth');
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.buttonText}>Get Started</Text>
          </TouchableOpacity>

          {/* Terms text */}
          <Text style={styles.termsText}>
            By tapping "Get Started", you agree to our{' '}
            <Text
              style={styles.termsLink}
              onPress={() => Linking.openURL('https://www.reelful.app/terms.html')}
            >
              Terms of Service
            </Text>
            {' '}and{' '}
            <Text
              style={styles.termsLink}
              onPress={() => Linking.openURL('https://www.reelful.app/privacy.html')}
            >
              Privacy Policy
            </Text>
          </Text>
        </Animated.View>
      )}

      {/* Loading indicator when checking auth */}
      {isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.ember} />
        </View>
      )}

      {/* Tap hint for test mode */}
      {showTapHint && (
        <Animated.View style={[styles.tapHintContainer, { opacity: reelFade }]}>
          <Text style={styles.tapHintText}>Tap anywhere to continue</Text>
        </Animated.View>
      )}

      {/* Skip intro button for normal mode */}
      {showSkipButton && (
        <Animated.View style={[styles.tapHintContainer, { opacity: reelFade }]}>
          <TouchableOpacity
            style={styles.skipButton}
            onPress={navigateToNextScreen}
            activeOpacity={0.7}
          >
            <Text style={styles.tapHintText}>Skip intro</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  titleContainer: {
    position: 'absolute',
    left: 32,
    zIndex: 10,
  },
  title: {
    fontSize: 70,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    letterSpacing: -1,
  },
  reelContainer: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
    // Dynamic values (width, height, right, top, marginTop) set inline
  },
  reelImage: {
    // Dynamic values (width, height) set inline
  },
  bottomSection: {
    position: 'absolute',
    bottom: -5,
    left: 24,
    right: 24,
    alignItems: 'center',
    gap: 16,
    zIndex: 10,
  },
  button: {
    width: '100%',
    height: 56,
    borderRadius: 100,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.ink,
  },
  buttonText: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.white,
    letterSpacing: 0.3,
  },
  termsText: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 300,
  },
  termsLink: {
    color: Colors.ink,
    textDecorationLine: 'underline',
  },
  loadingContainer: {
    position: 'absolute',
    bottom: 120,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  tapHintContainer: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  tapHintText: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  skipButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
});
