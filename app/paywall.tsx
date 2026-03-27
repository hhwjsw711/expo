import { useRouter } from 'expo-router';
import { useCallback, useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  Dimensions,
  TextInput,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  PanResponder,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import Colors from '@/constants/colors';
import { Fonts } from '@/constants/typography';
import { usePaywall, CREDIT_PACKS, CreditPackType } from '@/contexts/PaywallContext';
import { useApp } from '@/contexts/AppContext';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';
import * as Haptics from 'expo-haptics';
import { getScreenDimensions } from '@/lib/dimensions';

type PlanType = 'monthly' | 'annual';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenDimensions();
const CONFETTI_COUNT = 150;
// Confetti colors adjusted for light background
const CONFETTI_COLORS = ['#F36A3F', '#F58560', '#E05530', '#262626', '#636363', '#D4A574', '#C9B8A8'];

// Confetti particle component
function ConfettiParticle({ delay, startX }: { delay: number; startX: number }) {
  const translateY = useRef(new Animated.Value(-20)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const rotate = useRef(new Animated.Value(0)).current;
  
  const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
  const size = 6 + Math.random() * 12;
  const horizontalDrift = (Math.random() - 0.5) * 120;
  
  useEffect(() => {
    const duration = 1500 + Math.random() * 1000;
    
    Animated.sequence([
      Animated.delay(delay),
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: SCREEN_HEIGHT + 50,
          duration,
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: horizontalDrift,
          duration,
          useNativeDriver: true,
        }),
        Animated.timing(rotate, {
          toValue: 360 * (2 + Math.random() * 3),
          duration,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [delay, translateY, translateX, rotate, horizontalDrift]);
  
  const rotateInterpolate = rotate.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '360deg'],
  });
  
  return (
    <Animated.View
      style={[
        styles.confettiParticle,
        {
          left: startX,
          width: size,
          height: size * 0.6,
          backgroundColor: color,
          transform: [
            { translateY },
            { translateX },
            { rotate: rotateInterpolate },
          ],
        },
      ]}
    />
  );
}

// Confetti container component
function Confetti({ show }: { show: boolean }) {
  if (!show) return null;
  
  const particles = Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
    id: i,
    delay: Math.random() * 800,
    startX: Math.random() * SCREEN_WIDTH,
  }));
  
  return (
    <View style={styles.confettiContainer} pointerEvents="none">
      {particles.map((particle) => (
        <ConfettiParticle
          key={particle.id}
          delay={particle.delay}
          startX={particle.startX}
        />
      ))}
    </View>
  );
}

// Simple bullet dot component
function BulletDot() {
  return <View style={styles.bulletDot} />;
}

export default function PaywallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useApp();
  const {
    monthlyPackage,
    annualPackage,
    purchasePackage,
    restorePurchases,
    isLoading,
    subscriptionState,
    markPaywallCompleted,
    purchaseCredits,
    getCreditPackPrice,
  } = usePaywall();
  
  const updateSubscriptionStatus = useMutation(api.users.updateSubscriptionStatus);
  
  const videoGenerationStatus = useQuery(
    api.users.getVideoGenerationStatus,
    userId ? { userId } : "skip"
  );
  
  const hasReachedLimit = videoGenerationStatus?.hasReachedLimit ?? false;
  
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('annual');
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [selectedCreditPack, setSelectedCreditPack] = useState<CreditPackType>('PACK_10');
  const [isPurchasingCredits, setIsPurchasingCredits] = useState(false);
  
  const showCreditsView = ENABLE_TEST_RUN_MODE 
    ? false 
    : (videoGenerationStatus?.isPremium ?? subscriptionState.isPro);
  
  const [promoCode, setPromoCode] = useState('');
  const [isApplyingPromo, setIsApplyingPromo] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoSuccess, setPromoSuccess] = useState<string | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  
  const redeemPromoCode = useMutation(api.users.redeemPromoCode);

  useEffect(() => {
    const keyboardWillShow = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setIsKeyboardVisible(true)
    );
    const keyboardWillHide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setIsKeyboardVisible(false)
    );

    return () => {
      keyboardWillShow.remove();
      keyboardWillHide.remove();
    };
  }, []);
  
  const scrollViewRef = useRef<ScrollView>(null);
  
  // Animated values for slide gesture
  const translateY = useRef(new Animated.Value(600)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  // Animate modal in on mount
  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, [translateY, backdropOpacity]);

  const closeModal = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 600,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start(() => {
      router.back();
    });
  };

  // PanResponder for swipe-to-dismiss
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Only respond to downward gestures
        return gestureState.dy > 10;
      },
      onPanResponderMove: (_, gestureState) => {
        // Only allow downward drag
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy);
          backdropOpacity.setValue(Math.max(0.3, 1 - gestureState.dy / 600));
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        // If swiped down far enough or with velocity, close modal
        if (gestureState.dy > 150 || gestureState.vy > 0.5) {
          closeModal();
        } else {
          // Spring back to original position
          Animated.parallel([
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: true,
              tension: 100,
              friction: 8,
            }),
            Animated.spring(backdropOpacity, {
              toValue: 1,
              useNativeDriver: true,
              tension: 100,
              friction: 8,
            }),
          ]).start();
        }
      },
    })
  ).current;

  const navigateAfterSuccess = useCallback((delay: number = 0) => {
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 600,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start(() => {
        router.back();
      });
    }, delay);
  }, [translateY, backdropOpacity, router]);

  const handleSelectPlan = useCallback((plan: PlanType) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedPlan(plan);
  }, []);

  const handleSubscribe = useCallback(async () => {
    Keyboard.dismiss();
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    
    const pkg = selectedPlan === 'monthly' ? monthlyPackage : annualPackage;
    
    if (!pkg) {
      console.log('[Paywall] No package available for selected plan');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsPurchasing(true);
    
    try {
      const success = await purchasePackage(pkg);
      if (success) {
        markPaywallCompleted();
        
        if (userId) {
          try {
            await updateSubscriptionStatus({
              userId,
              isPremium: true,
              subscriptionExpiresAt: subscriptionState.expirationDate || undefined,
              subscriptionType: selectedPlan === 'monthly' ? 'monthly' : 'annual',
            });
            console.log('[Paywall] Subscription status synced to backend');
          } catch (syncError) {
            console.error('[Paywall] Failed to sync subscription status:', syncError);
          }
        }
        
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setShowConfetti(true);
        navigateAfterSuccess(2500);
      }
    } finally {
      setIsPurchasing(false);
    }
  }, [selectedPlan, monthlyPackage, annualPackage, purchasePackage, navigateAfterSuccess, userId, updateSubscriptionStatus, subscriptionState, markPaywallCompleted]);

  const handleRestore = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsRestoring(true);
    
    try {
      const success = await restorePurchases();
      if (success) {
        markPaywallCompleted();
        
        if (userId) {
          try {
            await updateSubscriptionStatus({
              userId,
              isPremium: true,
              subscriptionExpiresAt: subscriptionState.expirationDate || undefined,
            });
            console.log('[Paywall] Subscription status synced to backend after restore');
          } catch (syncError) {
            console.error('[Paywall] Failed to sync subscription status:', syncError);
          }
        }
        
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setShowConfetti(true);
        navigateAfterSuccess(2500);
      }
    } finally {
      setIsRestoring(false);
    }
  }, [restorePurchases, navigateAfterSuccess, userId, updateSubscriptionStatus, subscriptionState, markPaywallCompleted]);

  const handleApplyPromoCode = useCallback(async () => {
    if (!promoCode.trim()) {
      setPromoError('Please enter a promo code');
      return;
    }
    
    if (!userId) {
      setPromoError('Please sign in first');
      return;
    }
    
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsApplyingPromo(true);
    setPromoError(null);
    setPromoSuccess(null);
    
    try {
      // In test mode, accept any promo code without hitting the backend
      if (ENABLE_TEST_RUN_MODE) {
        console.log(`[Paywall][TestMode] Accepting promo code "${promoCode.trim()}" without backend validation`);
        markPaywallCompleted();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPromoSuccess('Premium activated for 30 days! (Test Mode)');
        setShowConfetti(true);
        navigateAfterSuccess(2500);
        return;
      }

      const result = await redeemPromoCode({
        userId,
        code: promoCode.trim(),
      });
      
      if (result.success) {
        markPaywallCompleted();
        
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPromoSuccess(`Premium activated for ${result.durationDays} days!`);
        setShowConfetti(true);
        navigateAfterSuccess(2500);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPromoError(result.error || 'Failed to apply promo code');
      }
    } catch (err) {
      console.error('[Paywall] Error applying promo code:', err);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPromoError('Failed to apply promo code');
    } finally {
      setIsApplyingPromo(false);
    }
  }, [promoCode, userId, redeemPromoCode, navigateAfterSuccess, markPaywallCompleted]);

  const handlePurchaseCredits = useCallback(async () => {
    Keyboard.dismiss();
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsPurchasingCredits(true);
    
    try {
      const success = await purchaseCredits(selectedCreditPack);
      if (success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setShowConfetti(true);
        navigateAfterSuccess(2500);
      }
    } finally {
      setIsPurchasingCredits(false);
    }
  }, [selectedCreditPack, purchaseCredits, navigateAfterSuccess]);

  const monthlyPrice = monthlyPackage?.product?.priceString || '$9.99';
  const annualPrice = annualPackage?.product?.priceString || '$79.99';
  const annualMonthlyPrice = annualPackage?.product?.price 
    ? `$${(annualPackage.product.price / 12).toFixed(2)}`
    : '$3.33';

  const features = [
    '10 videos per month or 150 videos per year',
    'Buy more credits anytime',
  ];

  if (isLoading) {
    return (
      <View style={styles.modalBackdrop}>
        <View style={styles.modalContainer}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={Colors.ember} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <Animated.View style={[styles.modalBackdrop, { opacity: backdropOpacity }]}>
      <TouchableOpacity 
        style={styles.backdropTouchable} 
        activeOpacity={1}
        onPress={closeModal}
      />
      <Animated.View
        style={[
          styles.modalContainer,
          { transform: [{ translateY }] },
        ]}
        {...panResponder.panHandlers}
      >
          {/* Drag Handle */}
          <View style={styles.dragHandle} />

          {/* Close Button */}
          <View style={styles.closeButtonContainer}>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={closeModal}
              activeOpacity={0.7}
            >
              <Text style={styles.closeButtonText}>×</Text>
            </TouchableOpacity>
          </View>

          <KeyboardAvoidingView
            style={styles.keyboardAvoidingView}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={0}
          >
            <ScrollView
              ref={scrollViewRef}
              style={styles.scrollView}
              contentContainerStyle={[
                styles.scrollContent,
                isKeyboardVisible && { paddingBottom: 120 }
              ]}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              bounces={isKeyboardVisible}
              scrollEnabled={isKeyboardVisible}
            >
              {/* Hero Section */}
              <View style={styles.heroSection}>
                <Text style={styles.title}>
                  {showCreditsView ? 'Buy More Credits' : 'Unlock Reelful Pro'}
                </Text>
                <Text style={styles.subtitle}>
                  {showCreditsView 
                    ? "Add extra video credits to your account. Credits never expire!"
                    : hasReachedLimit 
                      ? "You've used all 3 free videos. Subscribe to continue creating stunning videos!"
                      : "Create stunning videos with AI"
                  }
                </Text>
                
                {/* Show current credits for Pro users */}
                {showCreditsView && videoGenerationStatus && (
                  <View style={styles.currentCreditsDisplay}>
                    <Text style={styles.currentCreditsLabel}>Your Credits: </Text>
                    <Text style={styles.currentCreditsValue}>
                      {videoGenerationStatus.totalCreditsRemaining}
                    </Text>
                  </View>
                )}
              </View>

              {showCreditsView ? (
                <>
                  {/* Credit Packs for Pro users */}
                  <View style={styles.creditPacksSection}>
                    <Text style={styles.sectionTitle}>Choose a Credit Pack</Text>
                    
                    <TouchableOpacity
                      style={[
                        styles.creditPackCard,
                        selectedCreditPack === 'PACK_10' && styles.cardSelected,
                      ]}
                      onPress={() => setSelectedCreditPack('PACK_10')}
                      activeOpacity={0.8}
                    >
                      <View style={styles.cardHeader}>
                        <View style={[
                          styles.radioButton,
                          selectedCreditPack === 'PACK_10' && styles.radioButtonSelected,
                        ]}>
                          {selectedCreditPack === 'PACK_10' && (
                            <View style={styles.radioButtonInner} />
                          )}
                        </View>
                        <View style={styles.cardInfo}>
                          <Text style={styles.cardTitle}>10 Credits</Text>
                          <Text style={styles.cardPrice}>{getCreditPackPrice('PACK_10')}</Text>
                        </View>
                      </View>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.creditPackCard,
                        selectedCreditPack === 'PACK_20' && styles.cardSelected,
                      ]}
                      onPress={() => setSelectedCreditPack('PACK_20')}
                      activeOpacity={0.8}
                    >
                      <View style={styles.cardHeader}>
                        <View style={[
                          styles.radioButton,
                          selectedCreditPack === 'PACK_20' && styles.radioButtonSelected,
                        ]}>
                          {selectedCreditPack === 'PACK_20' && (
                            <View style={styles.radioButtonInner} />
                          )}
                        </View>
                        <View style={styles.cardInfo}>
                          <Text style={styles.cardTitle}>20 Credits</Text>
                          <Text style={styles.cardPrice}>{getCreditPackPrice('PACK_20')}</Text>
                        </View>
                      </View>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.creditPackCard,
                        selectedCreditPack === 'PACK_50' && styles.cardSelected,
                      ]}
                      onPress={() => setSelectedCreditPack('PACK_50')}
                      activeOpacity={0.8}
                    >
                      <View style={styles.cardHeader}>
                        <View style={[
                          styles.radioButton,
                          selectedCreditPack === 'PACK_50' && styles.radioButtonSelected,
                        ]}>
                          {selectedCreditPack === 'PACK_50' && (
                            <View style={styles.radioButtonInner} />
                          )}
                        </View>
                        <View style={styles.cardInfo}>
                          <Text style={styles.cardTitle}>50 Credits</Text>
                          <Text style={styles.cardPrice}>{getCreditPackPrice('PACK_50')}</Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  </View>

                  {/* Credit Pack Features */}
                  <View style={styles.featuresSection}>
                    <View style={styles.featureRow}>
                      <BulletDot />
                      <Text style={styles.featureText}>Credits never expire</Text>
                    </View>
                    <View style={styles.featureRow}>
                      <BulletDot />
                      <Text style={styles.featureText}>Stack with subscription credits</Text>
                    </View>
                  </View>

                  {/* Footer for Credits */}
                  <View style={styles.footer}>
                    <TouchableOpacity
                      style={styles.primaryButton}
                      onPress={handlePurchaseCredits}
                      disabled={isPurchasingCredits}
                      activeOpacity={0.8}
                    >
                      {isPurchasingCredits ? (
                        <ActivityIndicator size="small" color={Colors.white} />
                      ) : (
                        <Text style={styles.primaryButtonText}>
                          Buy {CREDIT_PACKS[selectedCreditPack].credits} Credits
                        </Text>
                      )}
                    </TouchableOpacity>

                    <Text style={styles.legalText}>
                      One-time purchase. Credits added immediately.
                    </Text>
                  </View>
                </>
              ) : (
                <>
                  {/* Features */}
                  <View style={styles.featuresSection}>
                    {features.map((feature, index) => (
                      <View key={index} style={styles.featureRow}>
                        <BulletDot />
                        <Text style={styles.featureText}>{feature}</Text>
                      </View>
                    ))}
                  </View>

                  {/* Plans */}
                  <View style={styles.plansSection}>
                    <TouchableOpacity
                      style={[
                        styles.planCard,
                        selectedPlan === 'annual' && styles.cardSelected,
                      ]}
                      onPress={() => handleSelectPlan('annual')}
                      activeOpacity={0.8}
                    >
                      <View style={styles.saveBadge}>
                        <Text style={styles.saveBadgeText}>SAVE 33%</Text>
                      </View>
                      <View style={styles.cardHeader}>
                        <View style={[
                          styles.radioButton,
                          selectedPlan === 'annual' && styles.radioButtonSelected,
                        ]}>
                          {selectedPlan === 'annual' && (
                            <View style={styles.radioButtonInner} />
                          )}
                        </View>
                        <View style={styles.planInfo}>
                          <Text style={styles.cardTitle}>Annual</Text>
                          <Text style={styles.cardPrice}>
                            {annualPrice}
                            <Text style={styles.pricePeriod}>/year</Text>
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.planSubtext}>
                        Just {annualMonthlyPrice}/month, billed annually
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.planCard,
                        selectedPlan === 'monthly' && styles.cardSelected,
                      ]}
                      onPress={() => handleSelectPlan('monthly')}
                      activeOpacity={0.8}
                    >
                      <View style={styles.cardHeader}>
                        <View style={[
                          styles.radioButton,
                          selectedPlan === 'monthly' && styles.radioButtonSelected,
                        ]}>
                          {selectedPlan === 'monthly' && (
                            <View style={styles.radioButtonInner} />
                          )}
                        </View>
                        <View style={styles.planInfo}>
                          <Text style={styles.cardTitle}>Monthly</Text>
                          <Text style={styles.cardPrice}>
                            {monthlyPrice}
                            <Text style={styles.pricePeriod}>/month</Text>
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  </View>

                  {/* Promo Code Section */}
                  <View style={styles.promoSection}>
                    <View style={styles.promoHeader}>
                      <Text style={styles.promoLabel}>Have a promo code?</Text>
                      <Text style={styles.promoDescription}>
                        Valid for 1 month from activation, then charged monthly
                      </Text>
                    </View>
                    <View style={styles.promoInputRow}>
                      <TextInput
                        style={styles.promoInput}
                        placeholder="Enter code"
                        placeholderTextColor={Colors.gray400}
                        value={promoCode}
                        onChangeText={(text) => {
                          setPromoCode(text);
                          setPromoError(null);
                          setPromoSuccess(null);
                        }}
                        onFocus={() => {
                          setTimeout(() => {
                            scrollViewRef.current?.scrollToEnd({ animated: true });
                          }, 300);
                        }}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        editable={!isApplyingPromo}
                      />
                      <TouchableOpacity
                        style={[
                          styles.promoApplyButton,
                          (!promoCode.trim() || isApplyingPromo) && styles.promoApplyButtonDisabled,
                        ]}
                        onPress={handleApplyPromoCode}
                        disabled={!promoCode.trim() || isApplyingPromo}
                        activeOpacity={0.7}
                      >
                        {isApplyingPromo ? (
                          <ActivityIndicator size="small" color={Colors.white} />
                        ) : (
                          <Text style={styles.promoApplyText}>Apply</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                    {promoError && (
                      <Text style={styles.promoErrorText}>{promoError}</Text>
                    )}
                    {promoSuccess && (
                      <View style={styles.promoSuccessRow}>
                        <Text style={styles.promoSuccessCheckmark}>✓</Text>
                        <Text style={styles.promoSuccessText}>{promoSuccess}</Text>
                      </View>
                    )}
                  </View>

                  {/* Footer */}
                  <View style={styles.footer}>
                    <TouchableOpacity
                      style={styles.primaryButton}
                      onPress={handleSubscribe}
                      disabled={isPurchasing}
                      activeOpacity={0.8}
                    >
                      {isPurchasing ? (
                        <ActivityIndicator size="small" color={Colors.white} />
                      ) : (
                        <Text style={styles.primaryButtonText}>Subscribe Now</Text>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.restoreButton}
                      onPress={handleRestore}
                      disabled={isRestoring}
                    >
                      {isRestoring ? (
                        <ActivityIndicator size="small" color={Colors.textSecondary} />
                      ) : (
                        <Text style={styles.restoreText}>Restore Purchases</Text>
                      )}
                    </TouchableOpacity>

                    <Text style={styles.legalText}>
                      Cancel anytime. Subscription auto-renews unless canceled at least 24 hours before the end of the current period.
                    </Text>
                  </View>
                </>
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        </Animated.View>

      {/* Confetti overlay */}
      <Confetti show={showConfetti} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  backdropTouchable: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  modalContainer: {
    backgroundColor: Colors.cream,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: '85%',
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  dragHandle: {
    width: 40,
    height: 5,
    backgroundColor: Colors.creamDarker,
    borderRadius: 3,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  closeButtonContainer: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 8,
  },
  closeButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 28,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    lineHeight: 32,
  },
  keyboardAvoidingView: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  
  // Hero Section
  heroSection: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 16,
  },
  currentCreditsDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
    borderRadius: 12,
  },
  currentCreditsLabel: {
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  currentCreditsValue: {
    fontSize: 20,
    fontFamily: Fonts.medium,
    fontWeight: '700',
    color: Colors.ember,
  },
  
  // Section Title
  sectionTitle: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 12,
    textAlign: 'center',
  },
  
  // Features Section
  featuresSection: {
    marginBottom: 20,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  bulletDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.ember,
    marginRight: 12,
  },
  featureText: {
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    flex: 1,
  },
  
  // Cards (Plans & Credit Packs)
  plansSection: {
    gap: 10,
    marginBottom: 20,
  },
  creditPacksSection: {
    marginBottom: 20,
  },
  planCard: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 14,
    padding: 16,
    borderWidth: 2,
    borderColor: Colors.creamDark,
    position: 'relative',
    overflow: 'hidden',
  },
  creditPackCard: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 14,
    padding: 16,
    borderWidth: 2,
    borderColor: Colors.creamDark,
    marginBottom: 10,
  },
  cardSelected: {
    borderColor: Colors.ember,
    backgroundColor: 'rgba(243, 106, 63, 0.08)',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardInfo: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  planInfo: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 2,
  },
  cardPrice: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    fontWeight: '700',
    color: Colors.ink,
  },
  pricePeriod: {
    fontSize: 13,
    fontWeight: '400',
    color: Colors.textSecondary,
  },
  planSubtext: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginTop: 8,
    marginLeft: 34,
  },
  saveBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: Colors.ember,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  saveBadgeText: {
    fontSize: 10,
    fontFamily: Fonts.medium,
    fontWeight: '700',
    color: Colors.white,
    letterSpacing: 0.5,
  },
  
  // Radio Button
  radioButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.creamDarker,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  radioButtonSelected: {
    borderColor: Colors.ember,
  },
  radioButtonInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.ember,
  },
  
  // Promo Section
  promoSection: {
    marginTop: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.creamDark,
  },
  promoHeader: {
    marginBottom: 12,
  },
  promoLabel: {
    fontSize: 14,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    marginBottom: 4,
  },
  promoDescription: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    lineHeight: 16,
  },
  promoInputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  promoInput: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    borderWidth: 1,
    borderColor: Colors.creamDark,
  },
  promoApplyButton: {
    backgroundColor: Colors.ember,
    borderRadius: 100,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 70,
  },
  promoApplyButtonDisabled: {
    backgroundColor: 'rgba(243, 106, 63, 0.4)',
  },
  promoApplyText: {
    fontSize: 14,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.white,
  },
  promoErrorText: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.error,
    marginTop: 8,
  },
  promoSuccessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  promoSuccessCheckmark: {
    fontSize: 14,
    color: Colors.success,
    fontWeight: '600',
  },
  promoSuccessText: {
    fontSize: 12,
    fontFamily: Fonts.regular,
    color: Colors.success,
  },
  
  // Footer
  footer: {
    marginTop: 0,
    paddingTop: 16,
  },
  primaryButton: {
    backgroundColor: Colors.ember,
    borderRadius: 100,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  primaryButtonText: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    fontWeight: '600',
    color: Colors.white,
    letterSpacing: 0.3,
  },
  restoreButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  restoreText: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  legalText: {
    fontSize: 11,
    fontFamily: Fonts.regular,
    color: Colors.gray400,
    textAlign: 'center',
    lineHeight: 15,
    marginTop: 2,
  },
  
  // Confetti
  confettiContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  confettiParticle: {
    position: 'absolute',
    top: -20,
    borderRadius: 2,
  },
});
