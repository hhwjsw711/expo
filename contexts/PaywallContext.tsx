import createContextHook from '@nkzw/create-context-hook';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Platform, Alert } from 'react-native';
import Purchases, { 
  PurchasesPackage, 
  CustomerInfo, 
  PurchasesOffering,
  LOG_LEVEL,
  PurchasesStoreProduct,
} from 'react-native-purchases';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useApp } from './AppContext';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';

const RC_API_KEY = process.env.EXPO_PUBLIC_RC_KEY || '';

// Credit pack definitions - matching backend
export const CREDIT_PACKS = {
  PACK_10: { credits: 10, priceInCents: 999, productId: 'credits_10', priceString: '$9.99' },
  PACK_20: { credits: 20, priceInCents: 1999, productId: 'credits_20', priceString: '$19.99' },
  PACK_50: { credits: 50, priceInCents: 4999, productId: 'credits_50', priceString: '$49.99' },
} as const;

export type CreditPackType = keyof typeof CREDIT_PACKS;

export interface SubscriptionState {
  isSubscribed: boolean;
  isPro: boolean;
  activeSubscription: string | null;
  expirationDate: string | null;
  subscriptionType: 'monthly' | 'annual' | null;
}

export const [PaywallProvider, usePaywall] = createContextHook(() => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [offerings, setOfferings] = useState<PurchasesOffering | null>(null);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const syncedRef = useRef(false);
  const [creditProducts, setCreditProducts] = useState<PurchasesStoreProduct[]>([]);
  
  // Session-level flag for test mode: tracks if user completed paywall this session
  // Resets on app reload, allowing paywall to show again
  const [hasCompletedPaywallThisSession, setHasCompletedPaywallThisSession] = useState(false);
  
  // Get userId from AppContext for syncing subscription status
  const { userId } = useApp();
  
  // Mutation to sync subscription status to backend
  const updateSubscriptionStatus = useMutation(api.users.updateSubscriptionStatus);
  
  // Mutation to purchase credits
  const purchaseCreditsMutation = useMutation(api.users.purchaseCredits);

  useEffect(() => {
    initializePurchases();
  }, []);

  // Check if running in web/browser context
  const isWebPlatform = Platform.OS === 'web' || typeof document !== 'undefined';

  const initializePurchases = async () => {
    try {
      if (isWebPlatform) {
        console.log('[Paywall] Web platform detected, skipping RevenueCat initialization');
        setIsLoading(false);
        setIsInitialized(true);
        return;
      }

      if (!RC_API_KEY) {
        console.warn('[Paywall] RevenueCat API key not found');
        setError('RevenueCat API key not configured');
        setIsLoading(false);
        return;
      }

      console.log('[Paywall] Initializing RevenueCat...');
      Purchases.setLogLevel(LOG_LEVEL.DEBUG);
      
      await Purchases.configure({ apiKey: RC_API_KEY });
      console.log('[Paywall] RevenueCat configured successfully');
      
      setIsInitialized(true);
      
      await fetchOfferings();
      await fetchCustomerInfo();
      await fetchCreditProducts();
      
    } catch (err) {
      console.error('[Paywall] Error initializing RevenueCat:', err);
      setError(err instanceof Error ? err.message : 'Failed to initialize purchases');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchCreditProducts = async () => {
    try {
      // Skip on web - use consistent web platform check
      if (isWebPlatform) {
        console.log('[Paywall] Skipping credit products fetch on web');
        return;
      }
      
      console.log('[Paywall] Fetching credit products...');
      const productIds = Object.values(CREDIT_PACKS).map(pack => pack.productId);
      const products = await Purchases.getProducts(productIds);
      setCreditProducts(products);
      console.log('[Paywall] Credit products fetched:', products.map(p => p.identifier));
    } catch (err: any) {
      // Silently handle web platform errors - this is expected
      if (err?.message?.includes('not supported on web')) {
        console.log('[Paywall] Credit products not available on web platform');
        return;
      }
      console.error('[Paywall] Error fetching credit products:', err);
      // Non-critical error, don't set error state
    }
  };

  const fetchOfferings = async () => {
    try {
      console.log('[Paywall] Fetching offerings...');
      const offerings = await Purchases.getOfferings();
      console.log('[Paywall] Offerings fetched:', offerings);
      
      if (offerings.current) {
        setOfferings(offerings.current);
        console.log('[Paywall] Current offering:', offerings.current.identifier);
        console.log('[Paywall] Available packages:', offerings.current.availablePackages.map(p => p.identifier));
      } else {
        console.warn('[Paywall] No current offering available');
      }
    } catch (err) {
      console.error('[Paywall] Error fetching offerings:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch offerings');
    }
  };

  const fetchCustomerInfo = async () => {
    try {
      if (isWebPlatform) return;
      
      console.log('[Paywall] Fetching customer info...');
      const info = await Purchases.getCustomerInfo();
      setCustomerInfo(info);
      console.log('[Paywall] Customer info fetched:', {
        activeSubscriptions: info.activeSubscriptions,
        entitlements: Object.keys(info.entitlements.active),
      });
    } catch (err) {
      console.error('[Paywall] Error fetching customer info:', err);
    }
  };

  const purchasePackage = useCallback(async (pkg: PurchasesPackage): Promise<boolean> => {
    try {
      if (isWebPlatform) {
        console.log('[Paywall] Purchases not available on web');
        return false;
      }

      console.log('[Paywall] Purchasing package:', pkg.identifier);
      const { customerInfo: newCustomerInfo } = await Purchases.purchasePackage(pkg);
      setCustomerInfo(newCustomerInfo);
      
      // Check for any active entitlements (pro, premium, etc.)
      const activeEntitlements = Object.keys(newCustomerInfo.entitlements.active);
      const hasActiveEntitlement = activeEntitlements.length > 0;
      const hasProAccess = newCustomerInfo.entitlements.active['pro'] !== undefined;
      
      console.log('[Paywall] Purchase successful!');
      console.log('[Paywall] Active entitlements:', activeEntitlements);
      console.log('[Paywall] Has pro entitlement:', hasProAccess);
      console.log('[Paywall] Active subscriptions:', newCustomerInfo.activeSubscriptions);
      
      // Purchase succeeded if transaction completed - return true
      // The entitlement might take a moment to propagate, but purchase was successful
      return true;
    } catch (err: any) {
      if (err.userCancelled) {
        console.log('[Paywall] User cancelled purchase');
        return false;
      }
      console.error('[Paywall] Error purchasing package:', err);
      setError(err instanceof Error ? err.message : 'Purchase failed');
      return false;
    }
  }, []);

  const restorePurchases = useCallback(async (): Promise<boolean> => {
    try {
      if (isWebPlatform) {
        console.log('[Paywall] Restore not available on web');
        return false;
      }

      console.log('[Paywall] Restoring purchases...');
      const restoredInfo = await Purchases.restorePurchases();
      setCustomerInfo(restoredInfo);
      
      // Check for any active entitlements or subscriptions
      const activeEntitlements = Object.keys(restoredInfo.entitlements.active);
      const hasActiveSubscription = restoredInfo.activeSubscriptions.length > 0;
      const hasAccess = activeEntitlements.length > 0 || hasActiveSubscription;
      
      console.log('[Paywall] Restore complete!');
      console.log('[Paywall] Active entitlements:', activeEntitlements);
      console.log('[Paywall] Active subscriptions:', restoredInfo.activeSubscriptions);
      console.log('[Paywall] Has access:', hasAccess);
      
      return hasAccess;
    } catch (err) {
      console.error('[Paywall] Error restoring purchases:', err);
      setError(err instanceof Error ? err.message : 'Restore failed');
      return false;
    }
  }, []);

  const identifyUser = useCallback(async (userId: string) => {
    try {
      if (isWebPlatform) return;
      
      console.log('[Paywall] Identifying user:', userId);
      await Purchases.logIn(userId);
      await fetchCustomerInfo();
    } catch (err) {
      console.error('[Paywall] Error identifying user:', err);
    }
  }, [isWebPlatform]);

  // Mark paywall as completed for this session (used in test mode)
  const markPaywallCompleted = useCallback(() => {
    console.log('[Paywall] Marking paywall as completed for this session');
    setHasCompletedPaywallThisSession(true);
  }, []);

  // Purchase credit pack
  const purchaseCredits = useCallback(async (packType: CreditPackType): Promise<boolean> => {
    if (!userId) {
      Alert.alert('Error', 'Please sign in first');
      return false;
    }

    const pack = CREDIT_PACKS[packType];
    
    try {
      if (isWebPlatform) {
        // For web, directly record the purchase (would need a web payment solution)
        console.log('[Paywall] Web credit purchase not supported yet');
        Alert.alert('Not Available', 'Credit purchases are not available on web');
        return false;
      }

      // Find the product
      const product = creditProducts.find(p => p.identifier === pack.productId);
      
      if (product) {
        // Purchase through RevenueCat
        console.log('[Paywall] Purchasing credit pack via RevenueCat:', pack.productId);
        const { customerInfo: newCustomerInfo } = await Purchases.purchaseStoreProduct(product);
        setCustomerInfo(newCustomerInfo);
        
        // Record the credit purchase in backend
        await purchaseCreditsMutation({
          userId,
          credits: pack.credits,
          priceInCents: pack.priceInCents,
          productId: pack.productId,
        });
        
        console.log('[Paywall] Credit purchase successful:', pack.credits, 'credits');
        return true;
      } else {
        // Product not found in RevenueCat - use direct backend purchase (for testing)
        console.log('[Paywall] Product not in RevenueCat, recording directly in backend');
        
        await purchaseCreditsMutation({
          userId,
          credits: pack.credits,
          priceInCents: pack.priceInCents,
          productId: pack.productId,
        });
        
        console.log('[Paywall] Credit purchase recorded:', pack.credits, 'credits');
        return true;
      }
    } catch (err: any) {
      if (err.userCancelled) {
        console.log('[Paywall] User cancelled credit purchase');
        return false;
      }
      console.error('[Paywall] Error purchasing credits:', err);
      Alert.alert('Purchase Failed', 'Unable to complete purchase. Please try again.');
      return false;
    }
  }, [userId, creditProducts, purchaseCreditsMutation, isWebPlatform]);

  const subscriptionState: SubscriptionState = useMemo(() => {
    // In test mode, always return not premium to test the paywall flow
    if (ENABLE_TEST_RUN_MODE) {
      console.log('[Paywall] Test mode enabled - forcing isPremium = false');
      return {
        isSubscribed: false,
        isPro: false,
        activeSubscription: null,
        expirationDate: null,
        subscriptionType: null,
      };
    }

    if (isWebPlatform || !customerInfo) {
      return {
        isSubscribed: false,
        isPro: false,
        activeSubscription: null,
        expirationDate: null,
        subscriptionType: null,
      };
    }

    // Check for 'pro' entitlement first, then any active entitlement
    const proEntitlement = customerInfo.entitlements.active['pro'];
    const activeEntitlements = Object.values(customerInfo.entitlements.active);
    const firstActiveEntitlement = activeEntitlements[0];
    
    // User is subscribed if they have any active entitlement OR active subscription
    const hasActiveEntitlement = activeEntitlements.length > 0;
    const hasActiveSubscription = customerInfo.activeSubscriptions.length > 0;
    const isSubscribed = hasActiveEntitlement || hasActiveSubscription;
    
    // Determine subscription type based on active subscription identifier
    let subscriptionType: 'monthly' | 'annual' | null = null;
    const activeSubscription = customerInfo.activeSubscriptions[0];
    if (activeSubscription) {
      if (activeSubscription.includes('annual') || activeSubscription.includes('yearly')) {
        subscriptionType = 'annual';
      } else if (activeSubscription.includes('monthly')) {
        subscriptionType = 'monthly';
      }
    }
    
    return {
      isSubscribed,
      isPro: isSubscribed,
      activeSubscription: activeSubscription || null,
      expirationDate: proEntitlement?.expirationDate || firstActiveEntitlement?.expirationDate || null,
      subscriptionType,
    };
  }, [customerInfo, isWebPlatform]);

  // Sync subscription status to backend on app load when user is subscribed
  useEffect(() => {
    const syncSubscriptionToBackend = async () => {
      if (!userId || !isInitialized || syncedRef.current) return;
      
      // Only sync if user has an active subscription
      if (subscriptionState.isSubscribed) {
        try {
          console.log('[Paywall] Syncing subscription status to backend on load');
          await updateSubscriptionStatus({
            userId,
            isPremium: true,
            subscriptionExpiresAt: subscriptionState.expirationDate || undefined,
            subscriptionType: subscriptionState.subscriptionType || undefined,
          });
          syncedRef.current = true;
          console.log('[Paywall] Subscription status synced to backend');
        } catch (err) {
          console.error('[Paywall] Failed to sync subscription status to backend:', err);
        }
      }
    };
    
    syncSubscriptionToBackend();
  }, [userId, isInitialized, subscriptionState.isSubscribed, subscriptionState.expirationDate, subscriptionState.subscriptionType, updateSubscriptionStatus]);

  const monthlyPackage = useMemo(() => {
    return offerings?.availablePackages.find(
      pkg => pkg.packageType === 'MONTHLY' || pkg.identifier === '$rc_monthly'
    ) || null;
  }, [offerings]);

  const annualPackage = useMemo(() => {
    return offerings?.availablePackages.find(
      pkg => pkg.packageType === 'ANNUAL' || pkg.identifier === '$rc_annual'
    ) || null;
  }, [offerings]);

  // Helper to get localized price for credit packs from App Store
  const getCreditPackPrice = useCallback((packType: CreditPackType): string => {
    const pack = CREDIT_PACKS[packType];
    const product = creditProducts.find(p => p.identifier === pack.productId);
    // Use localized price from App Store if available, otherwise fallback to hardcoded
    return product?.priceString || pack.priceString;
  }, [creditProducts]);

  return useMemo(() => ({
    isInitialized,
    isLoading,
    error,
    offerings,
    customerInfo,
    subscriptionState,
    monthlyPackage,
    annualPackage,
    purchasePackage,
    restorePurchases,
    identifyUser,
    fetchCustomerInfo,
    // Test mode session tracking
    hasCompletedPaywallThisSession,
    markPaywallCompleted,
    // Credit purchases
    creditProducts,
    purchaseCredits,
    getCreditPackPrice,
  }), [
    isInitialized,
    isLoading,
    error,
    offerings,
    customerInfo,
    subscriptionState,
    monthlyPackage,
    annualPackage,
    purchasePackage,
    restorePurchases,
    identifyUser,
    hasCompletedPaywallThisSession,
    markPaywallCompleted,
    creditProducts,
    purchaseCredits,
    getCreditPackPrice,
  ]);
});
