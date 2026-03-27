// Reelful Design System - Spacing & Layout
// Consistent spacing scale for the app

// Spacing Scale (in pixels)
export const Spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
} as const;

export type SpacingKey = keyof typeof Spacing;
export type SpacingValue = typeof Spacing[SpacingKey];

// Border Radius
export const BorderRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 44,   // Phone frame corners
  full: 100,   // Pill buttons
} as const;

export type BorderRadiusKey = keyof typeof BorderRadius;
export type BorderRadiusValue = typeof BorderRadius[BorderRadiusKey];

// Shadows (for React Native)
export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 15,
    elevation: 8,
  },
  xl: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 25 },
    shadowOpacity: 0.5,
    shadowRadius: 50,
    elevation: 16,
  },
} as const;

// Component-specific dimensions
export const ComponentSizes = {
  button: {
    height: 64,
    heightSmall: 48,
    paddingHorizontal: 32,
    paddingHorizontalSmall: 24,
  },
  input: {
    height: 56,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  bottomSheet: {
    handleHeight: 4,
    handleWidth: 36,
    borderRadius: 24,
  },
} as const;

// Layout constants
export const Layout = {
  screenPaddingHorizontal: 24,
  screenPaddingTop: 60,
  screenPaddingBottom: 48,
  bottomSectionGap: 16,
  cardPadding: 24,
} as const;
