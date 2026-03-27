// Reelful Design System - Typography
// Uses PP Neue Montreal font family

export const Fonts = {
  // For titles, headings, and emphasized text
  title: 'PPNeueMontreal-Bold',

  // For subtitles, buttons, and medium-weight text
  medium: 'PPNeueMontreal-Medium',

  // For body text and regular content
  regular: 'PPNeueMontreal-Book',

  // For italic/emphasized text
  italic: 'PPNeueMontreal-Italic',

  // Inter fonts (for captions)
  interSemiBold: 'Inter_600SemiBold',
  interBold: 'Inter_700Bold',
  interRegular: 'Inter_400Regular',
} as const;

export type FontFamily = typeof Fonts[keyof typeof Fonts];

// Font Sizes
export const FontSizes = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 50,
} as const;

export type FontSize = typeof FontSizes[keyof typeof FontSizes];

// Font Weights
export const FontWeights = {
  regular: '400',
  medium: '500',
  bold: '700',
} as const;

// Letter Spacing
export const LetterSpacing = {
  tight: -1,
  normal: 0,
  wide: 0.3,
} as const;

// Line Heights
export const LineHeights = {
  none: 1,
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.6,
} as const;
