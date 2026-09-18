# Reelful UI Redesign Plan

## Design System Summary

The new design system is cinema-inspired with warm, sophisticated aesthetics:

**Colors:**

- Cream: `#f3ebe3` (primary), `#f8f0e8` (light), `#e8ddd3` (medium), `#ddd0c4` (dark)
- Dark: `#1a1a18` (base), `#232321` (elevated), `#2d2d2a` (surface)
- Accent: `#E8906A` (orange from reel highlights)
- Text: `#f3ebe3` (primary dark), `#9a9a9a` (secondary dark)

**Typography:** PP Neue Montreal (Book 400, Medium 500, Bold 700)

**Buttons:** 3D pillowy dome with radial gradient highlight, pill-shaped (border-radius: 100px), 64px height

---

## Files to Modify

### 1. Root Layout - Font Loading

**File:** [app/_layout.tsx](reelfull-app/app/_layout.tsx)

- Replace Inter fonts with PP Neue Montreal custom fonts
- Update background colors from `#000000` to `#1a1a18`
- Use `expo-font` to load custom fonts from `assets/fonts/`

### 2. NEW Intro Screen (Complete Redesign)

**File:** [app/index.tsx](reelfull-app/app/index.tsx)

Transform to match [mockups/intro.html](reelfull-app/mockups/intro.html):

- Remove video background, use solid dark `#1a1a18`
- Add film reel image from `assets/images/white-reel.png` on right side (half visible, rotating)
- Position "Reelful" title at top-left (50px, medium weight, cream color)
- New cream "Get Started" button with 3D pillowy effect:
```typescript
// Button gradient style
background: [
  'radial-gradient at top: rgba(255,255,255,0.15)',
  'linear-gradient: #f5ede5 -> #e8ddd3 -> #ddd0c4'
]
color: 'rgba(0, 0, 0, 0.85)'
```

- Add terms text below button (12px, gray, underlined links)
- Optional: Add spotlight blob effects with blur

### 3. Auth Screen

**File:** [app/auth.tsx](reelfull-app/app/auth.tsx)

- Keep video background with 70% black overlay
- Update colors: inputs use `darkSurface` background, `cream` focus border
- Button: Use accent color `#E8906A` with new button style
- Update fonts to PP Neue Montreal
- Terms links use accent color

### 4. Onboarding Screen

**File:** [app/onboarding.tsx](reelfull-app/app/onboarding.tsx)

- Keep video background
- Icon container: Use `rgba(232, 144, 106, 0.2)` background (accent-based)
- Update option cards: `darkSurface` background, accent border when selected
- Button gradient: Use new accent gradient `#E8906A` -> `#F0A080`

### 5. Feed/Gallery Screen

**File:** [app/(tabs)/index.tsx](reelfull-app/app/\(tabs)/index.tsx)

- Background: `dark` (#1a1a18)
- Header: "Reelful" title in cream, update icon
- Credits badge: Use accent color styling
- Tab control: Update to match design system
- Card styling: Use `darkElevated` background, `md` border radius
- Processing indicator: Use accent color
- Empty state button: Accent color with new shadow style

### 6. Tab Bar

**File:** [app/(tabs)/_layout.tsx](reelfull-app/app/\(tabs)/_layout.tsx)

Update to match design system specification:

- Pill-shaped floating bar with blur
- Dark gradient background: `rgba(45, 45, 42, 0.95)` -> `rgba(35, 35, 33, 0.98)`
- Border: `rgba(255, 255, 255, 0.08)`
- Create button: Accent gradient `#E8906A` -> `#D07850`
- Icon colors: Active = cream, Inactive = gray with 50% opacity

### 7. Settings Modal

**File:** [app/settings.tsx](reelfull-app/app/settings.tsx)

- Modal background: `#000000` -> use dark colors
- Menu items: Update icon containers, use accent for Pro items
- Modal sub-dialogs: Use `darkElevated` background
- Style options: accent border/background when selected
- Button: Accent gradient

### 8. Chat Composer Screen

**File:** [app/chat-composer.tsx](reelfull-app/app/chat-composer.tsx)

- Update all colors to use design system
- Media thumbnails: `darkElevated` background
- Input fields: `darkSurface` background, accent focus
- Generate button: Accent color with new style
- Example hint card: Accent-tinted background

### 9. Components

**VoiceRecorder** ([components/VoiceRecorder.tsx](reelfull-app/components/VoiceRecorder.tsx)):

- Mic button: Accent gradient background
- Recording indicator: Accent color

**CountrySelector** ([components/CountrySelector.tsx](reelfull-app/components/CountrySelector.tsx)):

- Use `darkSurface` background
- Text colors from design system

### 10. Other Screens

- `paywall.tsx`: Accent buttons, dark backgrounds
- `video-preview.tsx`: Updated colors
- `result.tsx`: Updated colors
- `script-review.tsx`: Updated colors
- `loader.tsx`: Accent spinner

---

## Assets Required

1. Copy film reel image to app assets:

   - Source: `reelful-landing/assets/images/white-reel.png`
   - Destination: `reelfull-app/assets/images/white-reel.png`

2. PP Neue Montreal fonts (should already be in assets/fonts/):

   - `PPNeueMontreal-Book.otf`
   - `PPNeueMontreal-Medium.otf`
   - `PPNeueMontreal-Bold.otf`

---

## Style Patterns to Implement

**Primary Button (Cream - for dark backgrounds):**

```typescript
{
  height: 64,
  borderRadius: 100,
  backgroundColor: '#f3ebe3',
  // Note: LinearGradient with highlight effect
}
```

**Accent Button (Orange):**

```typescript
{
  height: 64,
  borderRadius: 100,
  // Use LinearGradient: ['#F0A080', '#E8906A', '#D07850']
}
```

**Input Field:**

```typescript
{
  backgroundColor: '#2d2d2a', // darkSurface
  borderRadius: 12,
  borderWidth: 2,
  borderColor: 'rgba(255, 255, 255, 0.1)',
  // Focus: borderColor: '#f3ebe3'
}
```

**Card:**

```typescript
{
  backgroundColor: '#232321', // darkElevated
  borderRadius: 24,
  padding: 24,
}
```

---

## Key Considerations

- **Preserve all functionality** - Only change styling, not logic
- **Maintain existing navigation** - Same screen flow
- **Keep all Convex integrations** - Backend calls unchanged
- **Preserve animations** - Update colors in existing animations
- **Test on both iOS and Android** - Verify blur effects work correctly