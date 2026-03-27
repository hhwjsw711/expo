import { useRouter } from 'expo-router';
import { ArrowRight } from 'lucide-react-native';
import { useState, useRef, useEffect } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
  ScrollView,
  Linking,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import CountrySelector from '@/components/CountrySelector';
import { Country, DEFAULT_COUNTRY } from '@/constants/countries';
import { Fonts } from '@/constants/typography';
import { ENABLE_TEST_RUN_MODE } from '@/constants/config';

// Retry helper with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      console.log(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed:`, error.message);
      
      // Don't retry on the last attempt
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff
        console.log(`[Retry] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

export default function AuthScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { saveUserId } = useApp();
  
  // Convex hooks - connected to real backend
  const sendOTP = useAction(api.phoneAuth.sendOTP);
  const verifyOTP = useMutation(api.users.verifyOTP);
  const verifyTwilioOTP = useAction(api.twilioVerify.verifyTwilioOTP);
  const testAccountLogin = useMutation(api.users.testAccountLogin);
  const backdoorLogin = useMutation(api.users.backdoorLogin);
  
  // Track if we're using Twilio Verify or development mode
  const [useTwilioVerify, setUseTwilioVerify] = useState(false);
  
  // Track if this is a backdoor login (special phone number)
  const [isBackdoorMode, setIsBackdoorMode] = useState(false);
  
  // State
  const [step, setStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [selectedCountry, setSelectedCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [isCodeFocused, setIsCodeFocused] = useState(false);
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);
  
  // Ref for hidden code input
  const hiddenCodeInputRef = useRef<TextInput>(null);

  const formatPhoneNumber = (value: string, country: Country) => {
    // Remove all non-digit characters
    const digits = value.replace(/\D/g, '');
    
    // For US/Canada, format as (XXX) XXX-XXXX
    if (country.code === 'US' || country.code === 'CA') {
      if (digits.length <= 3) {
        return digits;
      } else if (digits.length <= 6) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
      } else {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
      }
    }
    
    // For other countries, just return digits with spaces every 3-4 digits
    if (digits.length <= 3) {
      return digits;
    } else if (digits.length <= 6) {
      return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    } else {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
  };

  // Check if phone number is the backdoor number (0000000000)
  const isBackdoorPhoneNumber = (digits: string) => {
    return digits === '0000000000';
  };

  const handleSendCode = async () => {
    // Validate phone number
    const digits = phoneNumber.replace(/\D/g, '');
    const expectedLength = selectedCountry.phoneLength || 10;
    
    // Check for backdoor phone number first (0000000000)
    if (isBackdoorPhoneNumber(digits)) {
      console.log('[Auth] Backdoor phone detected, switching to password mode');
      setIsBackdoorMode(true);
      setStep('password');
      return;
    }
    
    if (digits.length < expectedLength - 1 || digits.length > expectedLength + 1) {
      Alert.alert('Invalid Phone', `Please enter a valid phone number for ${selectedCountry.name}`);
      return;
    }

    setIsLoading(true);

    try {
      // Format as E.164 for backend
      const formattedPhone = `${selectedCountry.dialCode}${digits}`;
      
      console.log('[Auth] Sending OTP to:', formattedPhone);
      
      // Call Convex backend with retry logic
      const result = await retryWithBackoff(
        async () => {
          console.log('[Auth] Attempting to send OTP...');
          return await sendOTP({ phone: formattedPhone });
        },
        3, // 3 retries
        1000 // 1 second initial delay
      );
      
      console.log('[Auth] OTP result:', result);
      
      if (result.success) {
        // Remember if we're using Twilio Verify
        setUseTwilioVerify(result.useTwilioVerify || false);
        
        // Show message only in development mode
        if (!result.useTwilioVerify) {
          Alert.alert(
            'Development Mode',
            'Check the backend console for your OTP code (not sent via SMS)'
          );
        }
        setStep('code');
      } else {
        Alert.alert('Error', result.error || 'Failed to send code');
      }
    } catch (error: any) {
      console.error('[Auth] Send OTP error:', error);
      
      // Provide more helpful error message for connection issues
      const errorMessage = error?.message || 'Failed to send code';
      const isConnectionError = errorMessage.includes('Connection lost') || 
                               errorMessage.includes('network') ||
                               errorMessage.includes('timeout');
      
      if (isConnectionError) {
        Alert.alert(
          'Connection Error',
          'Could not connect to the server. Please check your internet connection and try again.',
          [{ text: 'OK' }]
        );
      } else {
        Alert.alert('Error', errorMessage);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    // Validate code
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      Alert.alert('Invalid Code', 'Please enter a valid 6-digit code');
      return;
    }

    setIsLoading(true);

    try {
      const digits = phoneNumber.replace(/\D/g, '');
      const formattedPhone = `${selectedCountry.dialCode}${digits}`;
      
      console.log('[Auth] Verifying OTP...');
      console.log('[Auth] Using Twilio Verify:', useTwilioVerify);
      
      // Call the appropriate verification method with retry logic
      const result = await retryWithBackoff(
        async () => {
          if (useTwilioVerify) {
            // Use Twilio Verify (production mode)
            console.log('[Auth] Verifying with Twilio Verify...');
            return await verifyTwilioOTP({ phone: formattedPhone, code });
          } else {
            // Use local database verification (development mode)
            console.log('[Auth] Verifying with local database...');
            return await verifyOTP({ phone: formattedPhone, code });
          }
        },
        3,
        1000
      );
      
      console.log('[Auth] Verification result:', result);
      
      if (result.success) {
        // Save userId to context
        await saveUserId(result.userId);
        
        // Navigate based on onboarding status (or test mode)
        if (ENABLE_TEST_RUN_MODE) {
          // Test mode: always go to onboarding for testing
          router.replace('/onboarding');
        } else if (result.onboardingCompleted) {
          router.replace('/(tabs)');
        } else {
          router.replace('/onboarding');
        }
      }
    } catch (error: any) {
      console.error('[Auth] Verify OTP error:', error);
      
      const errorMessage = error?.message || 'Invalid code';
      const isConnectionError = errorMessage.includes('Connection lost') || 
                               errorMessage.includes('network') ||
                               errorMessage.includes('timeout');
      
      if (isConnectionError) {
        Alert.alert(
          'Connection Error',
          'Could not connect to the server. Please check your internet connection and try again.'
        );
      } else {
        Alert.alert('Error', 'Invalid code. Please try again.');
      }
      setCode('');
      setTimeout(() => hiddenCodeInputRef.current?.focus(), 100);
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyPassword = async () => {
    if (!password.trim()) {
      Alert.alert('Invalid Password', 'Please enter a password');
      return;
    }

    setIsLoading(true);

    try {
      const digits = phoneNumber.replace(/\D/g, '');
      const formattedPhone = `${selectedCountry.dialCode}${digits}`;
      
      console.log('[Auth] Verifying backdoor password...');
      
      const result = await retryWithBackoff(
        async () => {
          return await backdoorLogin({ phone: formattedPhone, password });
        },
        3,
        1000
      );
      
      console.log('[Auth] Backdoor login result:', result);
      
      if (result.success && result.userId) {
        // Save userId to context
        await saveUserId(result.userId);
        
        // Navigate based on onboarding status (or test mode)
        if (ENABLE_TEST_RUN_MODE) {
          router.replace('/onboarding');
        } else if (result.onboardingCompleted) {
          router.replace('/(tabs)');
        } else {
          router.replace('/onboarding');
        }
      } else {
        Alert.alert('Error', 'Login failed. Please try again.');
      }
    } catch (error: any) {
      console.error('[Auth] Backdoor login error:', error);
      Alert.alert('Error', 'Invalid password. Please try again.');
      setPassword('');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangePhone = () => {
    setStep('phone');
    setCode('');
    setPassword('');
    setUseTwilioVerify(false);
    setIsBackdoorMode(false);
    setResendTimer(0);
  };
  
  // Handle code input change (hidden input handles both typing and paste)
  const handleCodeChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
  };
  
  const focusCodeInput = () => {
    hiddenCodeInputRef.current?.focus();
  };
  
  const startResendTimer = () => {
    setResendTimer(30);
  };
  
  const handleResendCode = async () => {
    if (resendTimer > 0) return;
    startResendTimer();
    await handleSendCode();
  };

  const handleTestAccount = async () => {
    setIsLoading(true);
    try {
      const testPhone = '+14244131728';
      console.log('[Test Account] Accessing test account:', testPhone);
      
      // Use the dedicated test account login mutation
      const result = await testAccountLogin({ phone: testPhone });
      
      if (result.success && result.userId) {
        console.log('[Test Account] Success! User ID:', result.userId);
        
        // Save userId to context
        await saveUserId(result.userId);
        
        // Navigate based on onboarding status (or test mode)
        if (ENABLE_TEST_RUN_MODE) {
          // Test mode: always go to onboarding for testing
          router.replace('/onboarding');
        } else if (result.onboardingCompleted) {
          router.replace('/(tabs)');
        } else {
          router.replace('/onboarding');
        }
      } else {
        Alert.alert('Error', 'Failed to access test account.');
      }
    } catch (error) {
      console.error('[Test Account] Error:', error);
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to access test account. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const isPhoneValid = () => {
    const digits = phoneNumber.replace(/\D/g, '');
    // Allow backdoor phone number (0000000000)
    if (isBackdoorPhoneNumber(digits)) {
      return true;
    }
    const expectedLength = selectedCountry.phoneLength || 10;
    return digits.length >= expectedLength - 1 && digits.length <= expectedLength + 1;
  };
  
  const isCodeValid = /^\d{6}$/.test(code);
  const isPasswordValid = password.trim().length > 0;
  const hasAutoVerified = useRef(false);
  
  // Refs for auto-focus
  const phoneInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  
  // Auto-verify when 6-digit code is entered
  useEffect(() => {
    if (step === 'code' && /^\d{6}$/.test(code) && !isLoading && !hasAutoVerified.current) {
      hasAutoVerified.current = true;
      handleVerifyCode();
    }
  }, [code, step, isLoading]);
  
  // Reset auto-verify flag when code changes (user corrects input)
  useEffect(() => {
    if (code.length < 6) {
      hasAutoVerified.current = false;
    }
  }, [code]);
  
  // Auto-focus input when step changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (step === 'phone') {
        phoneInputRef.current?.focus();
      } else if (step === 'code') {
        hiddenCodeInputRef.current?.focus();
        startResendTimer();
      } else if (step === 'password') {
        passwordInputRef.current?.focus();
      }
    }, 100); // Small delay to ensure component is mounted
    
    return () => clearTimeout(timer);
  }, [step]);
  
  // Resend timer countdown
  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [resendTimer]);
  
  
  return (
    <View style={styles.container}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardView}
        >
          <ScrollView
            contentContainerStyle={[
              styles.content,
              { paddingTop: insets.top + 60, paddingBottom: insets.bottom + 20 },
            ]}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
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
                {step === 'phone' ? 'Welcome!' : step === 'password' ? 'Enter Password' : 'Enter the code we'}
              </Text>
              <Text style={styles.subtitle}>
                {step === 'phone'
                  ? 'Enter your phone number to continue'
                  : step === 'password'
                  ? 'Enter your password to continue'
                  : `sent to ${selectedCountry.dialCode} ${formatPhoneNumber(phoneNumber, selectedCountry)}`}
              </Text>
            </View>

            <View style={styles.form}>
              {step === 'phone' ? (
                <>
                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Phone Number</Text>
                    <View style={styles.phoneInputContainer}>
                      <CountrySelector
                        selectedCountry={selectedCountry}
                        onSelectCountry={setSelectedCountry}
                      />
                      <View style={styles.divider} />
                      <TextInput
                        ref={phoneInputRef}
                        testID="phoneInput"
                        style={styles.phoneInput}
                        placeholder={selectedCountry.code === 'US' || selectedCountry.code === 'CA' 
                          ? '(555) 123-4567' 
                          : 'Phone number'}
                        placeholderTextColor={Colors.gray400}
                        value={phoneNumber}
                        onChangeText={(text) => setPhoneNumber(formatPhoneNumber(text, selectedCountry))}
                        keyboardType="phone-pad"
                        maxLength={20}
                        autoFocus
                      />
                    </View>
                  </View>

                  <TouchableOpacity
                    testID="continueButton"
                    style={[
                      styles.button,
                      { backgroundColor: isPhoneValid() && !isLoading ? Colors.ember : Colors.creamDark },
                      !isPhoneValid() && styles.buttonDisabled,
                    ]}
                    onPress={handleSendCode}
                    disabled={!isPhoneValid() || isLoading}
                    activeOpacity={0.8}
                  >
                    <View style={styles.buttonInner}>
                      {isLoading ? (
                        <ActivityIndicator color={Colors.white} />
                      ) : (
                        <Text style={[styles.buttonText, !isPhoneValid() && styles.buttonTextDisabled]}>Continue</Text>
                      )}
                    </View>
                  </TouchableOpacity>

                  {/* Test Account Button - Commented out for production */}
                  {/* <TouchableOpacity
                    style={styles.testAccountButton}
                    onPress={handleTestAccount}
                    disabled={isLoading}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.testAccountText}>Use Test Account</Text>
                  </TouchableOpacity> */}
                </>
              ) : step === 'password' ? (
                <>
                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Password</Text>
                    <TextInput
                      ref={passwordInputRef}
                      testID="passwordInput"
                      style={styles.codeInput}
                      placeholder="Enter password"
                      placeholderTextColor={Colors.gray400}
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>

                  <TouchableOpacity
                    testID="loginButton"
                    style={[
                      styles.button,
                      { backgroundColor: isPasswordValid && !isLoading ? Colors.ember : Colors.creamDark },
                      !isPasswordValid && styles.buttonDisabled,
                    ]}
                    onPress={handleVerifyPassword}
                    disabled={!isPasswordValid || isLoading}
                    activeOpacity={0.8}
                  >
                    <View style={styles.buttonInner}>
                      {isLoading ? (
                        <ActivityIndicator color={Colors.white} />
                      ) : (
                        <Text style={[styles.buttonText, !isPasswordValid && styles.buttonTextDisabled]}>Login</Text>
                      )}
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.changePhoneButton}
                    onPress={handleChangePhone}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.changePhoneText}>Change phone number</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {/* Hidden input handles all keyboard/paste/autofill input */}
                  <TextInput
                    ref={hiddenCodeInputRef}
                    style={styles.hiddenCodeInput}
                    value={code}
                    onChangeText={handleCodeChange}
                    onFocus={() => setIsCodeFocused(true)}
                    onBlur={() => setIsCodeFocused(false)}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    autoComplete="sms-otp"
                    maxLength={6}
                    caretHidden
                  />
                  {/* Visual code slots */}
                  <Pressable style={styles.codeSlotsContainer} onPress={focusCodeInput}>
                    {[0, 1, 2, 3, 4, 5].map((index) => {
                      const digit = code[index] || '';
                      const isCurrent = isCodeFocused && code.length === index;
                      const isFilled = digit !== '';
                      return (
                        <View
                          key={index}
                          style={[
                            styles.codeSlot,
                            isCurrent && styles.codeSlotFocused,
                            isFilled && styles.codeSlotFilled,
                          ]}
                        >
                          <Text style={styles.codeSlotText}>{digit}</Text>
                        </View>
                      );
                    })}
                  </Pressable>

                  {isLoading && (
                    <View style={styles.verifyingContainer}>
                      <ActivityIndicator color={Colors.ember} />
                    </View>
                  )}

                  <View style={styles.resendSection}>
                    <Text style={styles.didntReceiveText}>Didn't receive it?</Text>
                    <TouchableOpacity
                      onPress={handleResendCode}
                      disabled={resendTimer > 0 || isLoading}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        styles.resendTimerText,
                        resendTimer > 0 && styles.resendTimerTextDisabled,
                      ]}>
                        {resendTimer > 0
                          ? `Resend code (0:${resendTimer.toString().padStart(2, '0')})`
                          : 'Resend code'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity
                    style={styles.changePhoneButton}
                    onPress={handleChangePhone}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.changePhoneText}>Change phone number</Text>
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
  keyboardView: {
    flex: 1,
  },
  content: {
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
    marginBottom: 16,
  },
  label: {
    fontSize: 18,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    marginBottom: 12,
  },
  phoneInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.creamDark,
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: Colors.creamDarker,
  },
  phoneInput: {
    flex: 1,
    padding: 16,
    fontSize: 18,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    letterSpacing: 0,
  },
  codeInput: {
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: 16,
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    textAlign: 'center',
    letterSpacing: 12,
    borderWidth: 2,
    borderColor: Colors.creamDark,
  },
  hiddenCodeInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  codeSlotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 32,
  },
  codeSlot: {
    width: 52,
    height: 56,
    borderRadius: 12,
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.creamDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeSlotFocused: {
    borderColor: Colors.ember,
    borderWidth: 1.5,
  },
  codeSlotFilled: {
    borderColor: Colors.creamDarker,
  },
  codeSlotText: {
    fontSize: 22,
    fontFamily: Fonts.medium,
    color: Colors.ink,
  },
  verifyingContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  resendSection: {
    alignItems: 'center',
    marginBottom: 8,
  },
  didntReceiveText: {
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  resendTimerText: {
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    textDecorationLine: 'underline',
  },
  resendTimerTextDisabled: {
    color: Colors.textSecondary,
    textDecorationLine: 'none',
  },
  button: {
    marginTop: 8,
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
  },
  buttonText: {
    fontSize: 18,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  buttonTextDisabled: {
    color: Colors.inkMuted,
  },
  changePhoneButton: {
    marginTop: 12,
    padding: 8,
    alignItems: 'center',
  },
  changePhoneText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ember,
  },
  // resendButton and resendText removed - replaced by resendSection
  testAccountButton: {
    marginTop: 24,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.creamDarker,
    borderRadius: 12,
    backgroundColor: Colors.creamMedium,
  },
  testAccountText: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
  },
  termsText: {
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 20,
  },
  termsLink: {
    color: Colors.ember,
    textDecorationLine: 'underline',
  },
});
