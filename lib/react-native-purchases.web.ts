// Web mock for react-native-purchases
// RevenueCat doesn't support web, so we provide stub implementations

export const LOG_LEVEL = {
  VERBOSE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
};

export interface PurchasesPackage {
  identifier: string;
  packageType: string;
  product: {
    identifier: string;
    description: string;
    title: string;
    price: number;
    priceString: string;
    currencyCode: string;
  };
  offeringIdentifier: string;
}

export interface PurchasesOffering {
  identifier: string;
  serverDescription: string;
  availablePackages: PurchasesPackage[];
  lifetime: PurchasesPackage | null;
  annual: PurchasesPackage | null;
  sixMonth: PurchasesPackage | null;
  threeMonth: PurchasesPackage | null;
  twoMonth: PurchasesPackage | null;
  monthly: PurchasesPackage | null;
  weekly: PurchasesPackage | null;
}

export interface CustomerInfo {
  activeSubscriptions: string[];
  allPurchasedProductIdentifiers: string[];
  entitlements: {
    all: Record<string, any>;
    active: Record<string, any>;
  };
  firstSeen: string;
  latestExpirationDate: string | null;
  originalAppUserId: string;
  originalApplicationVersion: string | null;
  requestDate: string;
}

const Purchases = {
  setLogLevel: (_level: number) => {
    console.log('[Purchases Web Mock] setLogLevel called - no-op on web');
  },
  configure: async (_config: { apiKey: string }) => {
    console.log('[Purchases Web Mock] configure called - no-op on web');
  },
  getOfferings: async () => {
    console.log('[Purchases Web Mock] getOfferings called - returning empty');
    return { current: null, all: {} };
  },
  getCustomerInfo: async (): Promise<CustomerInfo> => {
    console.log('[Purchases Web Mock] getCustomerInfo called - returning empty');
    return {
      activeSubscriptions: [],
      allPurchasedProductIdentifiers: [],
      entitlements: { all: {}, active: {} },
      firstSeen: new Date().toISOString(),
      latestExpirationDate: null,
      originalAppUserId: 'web-user',
      originalApplicationVersion: null,
      requestDate: new Date().toISOString(),
    };
  },
  purchasePackage: async (_pkg: PurchasesPackage) => {
    console.log('[Purchases Web Mock] purchasePackage called - not available on web');
    throw new Error('Purchases not available on web');
  },
  restorePurchases: async (): Promise<CustomerInfo> => {
    console.log('[Purchases Web Mock] restorePurchases called - not available on web');
    throw new Error('Restore not available on web');
  },
  logIn: async (_userId: string) => {
    console.log('[Purchases Web Mock] logIn called - no-op on web');
  },
  logOut: async () => {
    console.log('[Purchases Web Mock] logOut called - no-op on web');
  },
};

export default Purchases;
