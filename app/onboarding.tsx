import { useRouter } from 'expo-router';
import { Plus, Send } from 'lucide-react-native';
import { useState, useRef, useEffect, useCallback } from 'react';
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
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { Fonts } from '@/constants/typography';
import { DEFAULT_STYLE } from '@/constants/config';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMsg {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  timestamp: number;
}

interface QuestionOption {
  emoji: string;
  label: string;
}

interface QuestionStep {
  assistantText: string;
  type: 'text' | 'options';
  options?: QuestionOption[];
  placeholder?: string;
}

// ─── Onboarding Flow Definition ─────────────────────────────────────────────

const ASSISTANT_NAME = 'Muse';

const ONBOARDING_STEPS: QuestionStep[] = [
  {
    assistantText: `Hey, it's ${ASSISTANT_NAME} — your personal video assistant! 👋 I'll help you create content from your media right here in this chat, as if you were chatting with a human video editor.\n\nBut before we start, I'd love to get to know you a little. What's your name?`,
    type: 'text',
    placeholder: 'Type your name...',
  },
  {
    assistantText: 'Nice to meet you, {name}! Which best describes you?',
    type: 'options',
    options: [
      { emoji: '📱', label: 'Creator / influencer' },
      { emoji: '👱', label: 'UGC creator' },
      { emoji: '🚀', label: 'Founder / startup' },
      { emoji: '🛍️', label: 'Small business owner' },
      { emoji: '🎓', label: 'Coach / educator' },
      { emoji: '💪', label: 'Sport / fitness coach' },
      { emoji: '📈', label: 'Marketer / agency' },
      { emoji: '🏠', label: 'Realtor' },
      { emoji: '✏️', label: 'Something else' },
    ],
  },
  {
    assistantText: 'Love it. What\'s your main goal with Wordream?',
    type: 'options',
    options: [
      { emoji: '📈', label: 'Grow my audience' },
      { emoji: '🛍️', label: 'Get more customers' },
      { emoji: '✨', label: 'Build my personal brand' },
      { emoji: '🚀', label: 'Promote a product or launch' },
      { emoji: '🔥', label: 'Post consistently, hassle-free' },
    ],
  },
  {
    assistantText: 'How often do you want to post?',
    type: 'options',
    options: [
      { emoji: '🔥', label: 'Every day' },
      { emoji: '📅', label: 'A few times a week' },
      { emoji: '🗓️', label: 'About once a week' },
      { emoji: '🌱', label: "I'm just getting started" },
    ],
  },
  {
    assistantText: "Last one about you — what's the hardest part of making videos today?",
    type: 'options',
    options: [
      { emoji: '⏰', label: 'Editing takes forever' },
      { emoji: '💬', label: 'I never know what to say' },
      { emoji: '🎬', label: 'Filming feels awkward' },
      { emoji: '🔄', label: 'Staying consistent' },
      { emoji: '😅', label: 'Honestly, all of it' },
    ],
  },
  {
    assistantText: 'If you don\'t mind sharing, how did you first hear about Wordream?',
    type: 'options',
    options: [
      { emoji: '🎵', label: 'TikTok' },
      { emoji: '📸', label: 'Instagram' },
      { emoji: '▶️', label: 'YouTube' },
      { emoji: '🐦', label: 'X (Twitter)' },
      { emoji: '🍎', label: 'App Store' },
      { emoji: '👤', label: 'A friend told me' },
      { emoji: '🔍', label: 'Somewhere else' },
    ],
  },
];

const FINAL_ASSISTANT_TEXT = (name: string) =>
  `Great! Let's get you set up, ${name}! 🎬 Your account is ready — let's start creating amazing videos together.`;

// ─── Component ───────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { saveUser, userId } = useApp();
  const completeOnboardingAction = useAction(api.users.completeOnboarding);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const scrollViewRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const msgIdCounter = useRef(0);
  const userName = useRef('');
  const isProcessingRef = useRef(false);
  const currentStepRef = useRef(0);

  const nextId = () => `msg-${++msgIdCounter.current}`;

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 50);
  }, []);

  // Initialize with first assistant message
  useEffect(() => {
    setMessages([{
      id: nextId(),
      role: 'assistant',
      content: ONBOARDING_STEPS[0].assistantText,
      timestamp: Date.now(),
    }]);
    // Auto-focus text input after a short delay
    if (ONBOARDING_STEPS[0].type === 'text') {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, []);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const addAssistantMessage = (text: string) => {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    }]);
  };

  const addUserMessage = (text: string) => {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }]);
  };

  const advanceStep = (userAnswer: string) => {
    // Guard against rapid double-tap: lock during the typing delay
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    const step = currentStepRef.current;
    addUserMessage(userAnswer);

    // Store name from first answer
    if (step === 0) {
      userName.current = userAnswer;
    }

    const nextStepIndex = step + 1;

    if (nextStepIndex < ONBOARDING_STEPS.length) {
      const nextStep = ONBOARDING_STEPS[nextStepIndex];
      const assistantText = nextStep.assistantText.replace('{name}', userName.current);
      setTimeout(() => {
        addAssistantMessage(assistantText);
        setCurrentStep(nextStepIndex);
        currentStepRef.current = nextStepIndex;
        setInputValue('');
        isProcessingRef.current = false;
        if (nextStep.type === 'text') {
          setTimeout(() => inputRef.current?.focus(), 300);
        }
      }, 400);
    } else {
      const finalText = FINAL_ASSISTANT_TEXT(userName.current);
      setTimeout(() => {
        addAssistantMessage(finalText);
        setCurrentStep(nextStepIndex);
        currentStepRef.current = nextStepIndex;
        completeOnboarding();
      }, 400);
    }
  };

  const handleSendText = () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isSaving) return;
    Keyboard.dismiss();
    advanceStep(trimmed);
  };

  const handleSelectOption = (option: QuestionOption) => {
    if (isSaving) return;
    Keyboard.dismiss();
    advanceStep(option.label);
  };

  const completeOnboarding = async () => {
    if (!userId) return;
    setIsSaving(true);
    try {
      console.log('[onboarding] Completing onboarding...');
      await completeOnboardingAction({
        userId,
        name: userName.current,
        preferredStyle: DEFAULT_STYLE as 'playful' | 'professional' | 'travel',
      });
      await saveUser({
        name: userName.current,
        style: DEFAULT_STYLE as 'Playful' | 'Professional' | 'Dreamy',
      });
      console.log('[onboarding] Onboarding complete!');
      // Brief pause so user sees the final message
      setTimeout(() => {
        router.replace('/(tabs)');
      }, 1200);
    } catch (error) {
      console.error('[onboarding] Error completing onboarding:', error);
      Alert.alert('Error', 'Failed to save your profile. Please try again.');
      // Roll back step so user can retry
      const prevStep = ONBOARDING_STEPS.length - 1;
      setCurrentStep(prevStep);
      currentStepRef.current = prevStep;
      isProcessingRef.current = false;
      setIsSaving(false);
    }
  };

  const currentQuestion = currentStep < ONBOARDING_STEPS.length ? ONBOARDING_STEPS[currentStep] : null;
  const showTextInput = currentQuestion?.type === 'text' && !isSaving;
  const showOptions = currentQuestion?.type === 'options' && !isSaving;
  const canSend = showTextInput && inputValue.trim().length > 0;

  return (
    <View style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 120 },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Chat messages */}
          {messages.map((msg) => (
            <View
              key={msg.id}
              style={msg.role === 'assistant' ? styles.assistantBubble : styles.userBubble}
            >
              {msg.role === 'assistant' ? (
                <Text style={styles.assistantText}>
                  {msg.content}
                </Text>
              ) : (
                <View style={styles.userBubbleInner}>
                  <Text style={styles.userText}>{msg.content}</Text>
                </View>
              )}
            </View>
          ))}

          {/* Options for current question */}
          {showOptions && currentQuestion?.options && (
            <View style={styles.optionsContainer}>
              {currentQuestion.options.map((option, index) => (
                <TouchableOpacity
                  key={index}
                  style={styles.optionButton}
                  onPress={() => handleSelectOption(option)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.optionEmoji}>{option.emoji}</Text>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Saving indicator */}
          {isSaving && (
            <View style={styles.savingContainer}>
              <Text style={styles.savingText}>Setting up your account...</Text>
            </View>
          )}
        </ScrollView>

        {/* Bottom input bar */}
        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          <View style={styles.inputBarInner}>
            <View style={styles.plusButton}>
              <Plus size={16} color={Colors.gray400} strokeWidth={2} />
            </View>
            <TextInput
              ref={inputRef}
              style={styles.textInput}
              placeholder={showTextInput ? currentQuestion?.placeholder : 'Pick an option above...'}
              placeholderTextColor={Colors.gray400}
              value={inputValue}
              onChangeText={setInputValue}
              editable={showTextInput}
              autoCapitalize="words"
              autoCorrect={false}
              onSubmitEditing={Platform.OS === 'web' ? undefined : handleSendText}
              returnKeyType="send"
              blurOnSubmit={false}
            />
            <TouchableOpacity
              style={[
                styles.sendButton,
                canSend ? styles.sendButtonActive : styles.sendButtonInactive,
              ]}
              onPress={handleSendText}
              disabled={!canSend}
              activeOpacity={0.7}
            >
              <Send size={18} color={canSend ? Colors.white : Colors.gray400} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
  },
  // Chat bubbles
  assistantBubble: {
    alignSelf: 'flex-start',
    maxWidth: '85%',
    marginBottom: 16,
  },
  assistantText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    lineHeight: 24,
  },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '75%',
    marginBottom: 16,
  },
  userBubbleInner: {
    backgroundColor: Colors.white,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
      },
      android: { elevation: 1 },
      default: {},
    }) as object,
  },
  userText: {
    fontSize: 16,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    lineHeight: 22,
  },
  // Options
  optionsContainer: {
    alignSelf: 'flex-start',
    width: '100%',
    marginBottom: 8,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.ember,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
      default: {},
    }) as object,
  },
  optionEmoji: {
    fontSize: 18,
    marginRight: 10,
  },
  optionLabel: {
    fontSize: 15,
    fontFamily: Fonts.medium,
    color: Colors.white,
  },
  // Saving
  savingContainer: {
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  savingText: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.gray400,
  },
  // Input bar
  inputBar: {
    paddingHorizontal: 16,
    paddingTop: 8,
    backgroundColor: Colors.cream,
  },
  inputBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'web' ? 8 : 4,
    minHeight: 48,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 3,
      },
      android: { elevation: 1 },
      default: {},
    }) as object,
  },
  plusButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.gray300,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    maxHeight: 80,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendButtonActive: {
    backgroundColor: Colors.ember,
  },
  sendButtonInactive: {
    backgroundColor: Colors.creamMedium,
  },
});
