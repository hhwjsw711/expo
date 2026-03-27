import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState, useRef, useEffect } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Alert,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { StylePreference } from '@/types';
import { Fonts } from '@/constants/typography';
import { ENABLE_STYLE_PREFERENCE, DEFAULT_STYLE } from '@/constants/config';

const STYLE_OPTIONS: StylePreference[] = ['Playful', 'Professional', 'Dreamy'];

export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { saveUser, userId } = useApp();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [selectedStyle, setSelectedStyle] = useState<StylePreference | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  
  // Ref for auto-focus
  const nameInputRef = useRef<TextInput>(null);
  
  // Convex hooks
  const completeOnboardingAction = useAction(api.users.completeOnboarding);
  
  // Auto-focus name input when step changes to 1
  useEffect(() => {
    if (step === 1) {
      const timer = setTimeout(() => {
        nameInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [step]);

  // Helper function to map local style to backend style
  const mapStyleToBackend = (style: StylePreference): 'playful' | 'professional' | 'travel' => {
    if (style === 'Playful') return 'playful';
    if (style === 'Professional') return 'professional';
    if (style === 'Dreamy') return 'travel';
    return 'playful'; // default
  };

  const handleCompleteOnboarding = async (style: StylePreference) => {
    if (!userId) return;
    
    setIsSaving(true);
    try {
      console.log('[onboarding] Completing onboarding...');
      
      // Save to backend (voice recording will be prompted later in the composer)
      await completeOnboardingAction({
        userId,
        name: name.trim(),
        preferredStyle: mapStyleToBackend(style),
      });
      
      // Also save locally (will be synced from backend on next load)
      await saveUser({ name: name.trim(), style: style });
      
      console.log('[onboarding] Onboarding complete!');
      router.replace('/(tabs)');
    } catch (error) {
      console.error('[onboarding] Error completing onboarding:', error);
      Alert.alert('Error', 'Failed to save your profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleNext = async () => {
    if (step === 1 && name.trim()) {
      if (ENABLE_STYLE_PREFERENCE) {
        setStep(2);
      } else {
        // Skip style selection, complete onboarding with default style
        const style = DEFAULT_STYLE as StylePreference;
        setSelectedStyle(style);
        await handleCompleteOnboarding(style);
      }
    }
  };

  const handleStyleContinue = async () => {
    if (selectedStyle) {
      await handleCompleteOnboarding(selectedStyle);
    }
  };

  const handleBack = () => {
    if (step === 2) {
      setStep(1);
    }
  };

  const isStep1Valid = name.trim().length > 0;
  const isStep2Valid = selectedStyle !== null;

  return (
    <View style={styles.container}>
      {step > 1 && (
        <TouchableOpacity
          style={[styles.backButton, { top: insets.top + 20 }]}
          onPress={handleBack}
          activeOpacity={0.7}
        >
          <ChevronLeft size={28} color={Colors.ink} strokeWidth={2} />
        </TouchableOpacity>
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 20 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={styles.iconContainer}>
              <Image
                source={require('../assets/images/reel-icon.png')}
                style={styles.iconImage}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.title}>
              {step === 1 ? 'Welcome to Reelful' : 'Your Style'}
            </Text>
            <Text style={styles.subtitle}>
              {step === 1
                ? "Let's personalize your experience"
                : 'Choose the style that best fits you'}
            </Text>
          </View>

          <View style={styles.form}>
            {step === 1 ? (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>What&apos;s your name?</Text>
                  <TextInput
                    ref={nameInputRef}
                    testID="nameInput"
                    style={styles.input}
                    placeholder="Enter your name"
                    placeholderTextColor={Colors.gray400}
                    value={name}
                    onChangeText={setName}
                    autoCapitalize="words"
                    autoCorrect={false}
                    autoFocus
                  />
                </View>

                <TouchableOpacity
                  testID="nextButton"
                  style={[styles.button, !isStep1Valid && styles.buttonDisabled]}
                  onPress={handleNext}
                  disabled={!isStep1Valid}
                  activeOpacity={0.8}
                >
                  <View
                    style={[
                      styles.buttonInner,
                      { backgroundColor: isStep1Valid ? Colors.ember : Colors.creamDark }
                    ]}
                  >
                    <Text style={[styles.buttonText, !isStep1Valid && styles.buttonTextDisabled]}>Continue</Text>
                  </View>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Choose your style</Text>
                  <View style={styles.optionsContainer}>
                    {STYLE_OPTIONS.map((style) => (
                      <TouchableOpacity
                        key={style}
                        style={[
                          styles.option,
                          selectedStyle === style && styles.optionSelected,
                        ]}
                        onPress={() => setSelectedStyle(style)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.optionText,
                            selectedStyle === style && styles.optionTextSelected,
                          ]}
                        >
                          {style}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                <TouchableOpacity
                  style={[styles.button, (!isStep2Valid || isSaving) && styles.buttonDisabled]}
                  onPress={handleStyleContinue}
                  disabled={!isStep2Valid || isSaving}
                  activeOpacity={0.8}
                >
                  <View
                    style={[
                      styles.buttonInner,
                      { backgroundColor: isStep2Valid && !isSaving ? Colors.ember : Colors.creamDark }
                    ]}
                  >
                    <Text style={[styles.buttonText, (!isStep2Valid || isSaving) && styles.buttonTextDisabled]}>
                      {isSaving ? 'Saving...' : 'Continue'}
                    </Text>
                  </View>
                </TouchableOpacity>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  backButton: {
    position: 'absolute',
    left: 20,
    zIndex: 10,
    padding: 8,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
  },
  iconContainer: {
    marginBottom: 20,
  },
  iconImage: {
    width: 88,
    height: 88,
  },
  title: {
    fontSize: 24,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  form: {
    flex: 1,
  },
  inputGroup: {
    marginBottom: 32,
  },
  label: {
    fontSize: 18,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    marginBottom: 12,
  },
  input: {
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    borderWidth: 2,
    borderColor: Colors.creamDark,
    letterSpacing: 0,
  },
  optionsContainer: {
    gap: 12,
  },
  option: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: Colors.creamDark,
  },
  optionSelected: {
    borderColor: Colors.ember,
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
  },
  optionText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    textAlign: 'center',
  },
  optionTextSelected: {
    color: Colors.ember,
  },
  button: {
    marginTop: 24,
    borderRadius: 100,
    overflow: 'hidden',
    height: 52,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonInner: {
    flexDirection: 'row',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 100,
  },
  buttonText: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  buttonTextDisabled: {
    color: Colors.inkMuted,
  },
});
