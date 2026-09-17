import { useRouter } from 'expo-router';
import {
  Plus,
  Send,
  Search,
  Music,
  Scissors,
  CheckCircle2,
  Play,
  Copy,
} from 'lucide-react-native';
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
  Image,
  Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import Colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import { Fonts } from '@/constants/typography';
import { DEFAULT_STYLE } from '@/constants/config';
import DemoVideoPlayerModal from '@/components/DemoVideoPlayerModal';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMsg {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  timestamp: number;
  special?: 'progress' | 'result' | 'email';
  meta?: string;
  progressIcon?: 'search' | 'music' | 'scissors' | 'check';
  /** User message that carries the demo clip thumbnails (sent from the composer). */
  clips?: boolean;
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

// ─── Demo Assets ─────────────────────────────────────────────────────────────

const DEMO_CLIPS = [
  { thumb: require('../assets/onboarding-media/thumbs/agulhas-01.jpg'), video: require('../assets/onboarding-media/agulhas-01.mp4'), duration: '0:02' },
  { thumb: require('../assets/onboarding-media/thumbs/kwantu-19.jpg'), video: require('../assets/onboarding-media/kwantu-19.mp4'), duration: '0:02' },
  { thumb: require('../assets/onboarding-media/thumbs/port-st-johns-02.jpg'), video: require('../assets/onboarding-media/port-st-johns-02.mp4'), duration: '0:09' },
  { thumb: require('../assets/onboarding-media/thumbs/umtata-01.jpg'), video: require('../assets/onboarding-media/umtata-01.mp4'), duration: '0:03' },
  { thumb: require('../assets/onboarding-media/thumbs/agulhas-02.jpg'), video: require('../assets/onboarding-media/agulhas-02.mp4'), duration: '0:03' },
  { thumb: require('../assets/onboarding-media/thumbs/kwantu-01.jpg'), video: require('../assets/onboarding-media/kwantu-01.mp4'), duration: '0:02' },
  { thumb: require('../assets/onboarding-media/thumbs/umtata-12.jpg'), video: require('../assets/onboarding-media/umtata-12.mp4'), duration: '0:02' },
  { thumb: require('../assets/onboarding-media/thumbs/kwantu-10.jpg'), video: require('../assets/onboarding-media/kwantu-10.mp4'), duration: '0:01' },
  { thumb: require('../assets/onboarding-media/thumbs/kalk-bay-01.jpg'), video: require('../assets/onboarding-media/kalk-bay-01.mp4'), duration: '0:03' },
  { thumb: require('../assets/onboarding-media/thumbs/umtata-09.jpg'), video: require('../assets/onboarding-media/umtata-09.mp4'), duration: '0:02' },
  { thumb: require('../assets/onboarding-media/thumbs/umtata-02.jpg'), video: require('../assets/onboarding-media/umtata-02.mp4'), duration: '0:03' },
  { thumb: require('../assets/onboarding-media/thumbs/port-st-johns-01.jpg'), video: require('../assets/onboarding-media/port-st-johns-01.mp4'), duration: '0:07' },
];

const DEMO_VIDEO = require('../assets/onboarding-media/demo-wild-africa.mp4');
const DEMO_COVER = require('../assets/onboarding-media/thumbs/demo-cover.jpg');

const DEMO_PROMPT_TEXT =
  'Select best cuts and stitch them rapidly with beats. Music should have beats that match the vibe of the video. Select the most striking and visually interesting shot for the intro. Add title in the middle in a handwritten script font. Make an outro, do not cut off the video.';

const DEMO_CAPTION =
  'Wild Africa 🌿 Quick cuts on the beat — coastal cliffs, giraffes, lions and breaching whales. Made with Wordream ✨ #WildAfrica #TravelEdit #NatureReels';

const DEMO_INTRO_TEXT =
  "Great! Now let me show you how this works — let's create a cool video about the African wild together. I'll type the prompt and grab the clips. You just hit send! 🎬";

const DEMO_RESULT_TEXT =
  "Here's your Wild Africa recap — quick cuts on the beat, with a bold title in the middle. Take a look 👇";

const DEMO_EXPLAIN_TEXT =
  "That's how it works! You can ask for any changes right here in the chat — just in plain English (or any other language) 🎬";

const DEMO_EMAIL_TEXT =
  "And one last question! ❤️ Want to stay in the loop? Leave your email and once a month I'll send you the best Wordream prompts — trends and tricks straight from our professional video editors, plus notifications about big updates.";

const DEMO_PROGRESS_STEPS = [
  { icon: 'search' as const, text: `Analyzed ${DEMO_CLIPS.length} clips`, time: '2s' },
  { icon: 'music' as const, text: 'Created a beat-heavy track', time: '2s' },
  { icon: 'scissors' as const, text: 'Cut the best moments on the beats', time: '3s' },
  { icon: 'check' as const, text: 'Checked video', time: '1s' },
];

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
    assistantText: "Love it. What's your main goal with Wordream?",
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
    assistantText: "If you don't mind sharing, how did you first hear about Wordream?",
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

  // Demo phase state
  const [isGenerating, setIsGenerating] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const [playerSource, setPlayerSource] = useState<number | null>(null);

  const scrollViewRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const msgIdCounter = useRef(0);
  const userName = useRef('');
  const isProcessingRef = useRef(false);
  const currentStepRef = useRef(0);
  const isGeneratingRef = useRef(false);
  const isSavingRef = useRef(false);

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
    setTimeout(() => inputRef.current?.focus(), 300);
  }, []);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const addAssistantMessage = (text: string, special?: ChatMsg['special'], meta?: string, icon?: ChatMsg['progressIcon']) => {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      special,
      meta,
      progressIcon: icon,
    }]);
  };

  const addUserMessage = (text: string, clips = false) => {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      clips,
    }]);
  };

  // ─── Demo sequence ────────────────────────────────────────────────────────

  const startDemoSequence = useCallback(() => {
    // 1. Intro message, then switch the composer into demo mode:
    // the clip strip + pre-filled prompt live in the input card (mirrors original),
    // and only become a user message once the user hits send.
    setTimeout(() => {
      addAssistantMessage(DEMO_INTRO_TEXT);
      setTimeout(() => {
        setDemoMode(true);
      }, 500);
    }, 700);
  }, []);

  const handleDemoSend = useCallback(() => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    setIsGenerating(true);
    // Composer returns to normal state; clips+prompt become one user message
    setDemoMode(false);
    addUserMessage(DEMO_PROMPT_TEXT, true);

    // Progress steps appear sequentially
    DEMO_PROGRESS_STEPS.forEach((step, i) => {
      setTimeout(() => {
        addAssistantMessage(step.text, 'progress', step.time, step.icon);
        // After last progress step: result video + explanation + email
        if (i === DEMO_PROGRESS_STEPS.length - 1) {
          setTimeout(() => {
            addAssistantMessage(DEMO_RESULT_TEXT);
            setTimeout(() => {
              addAssistantMessage('demo-result', 'result');
              setTimeout(() => {
                addAssistantMessage(DEMO_EXPLAIN_TEXT);
                setTimeout(() => {
                  addAssistantMessage(DEMO_EMAIL_TEXT);
                  setTimeout(() => {
                    addAssistantMessage('email-card', 'email');
                    setIsGenerating(false);
                  }, 400);
                }, 500);
              }, 600);
            }, 700);
          }, 600);
        }
      }, 900 * (i + 1));
    });
  }, []);

  const handleCopyAll = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(DEMO_CAPTION);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.log('[onboarding] copy failed:', e);
    }
  }, []);

  // Plain functions (no useCallback): capture fresh router/userId/action each render,
  // and keep completeOnboarding up-to-date for both entry points below.
  const handleEmailSubmit = async () => {
    const trimmed = email.trim();
    if (trimmed) {
      addUserMessage(trimmed);
      try {
        await AsyncStorage.setItem('@wordream_demo_email', trimmed);
      } catch (e) {
        console.log('[onboarding] email save failed:', e);
      }
      addAssistantMessage("You're in! 🎉 See you in your inbox.");
    }
    completeOnboarding();
  };

  const handleEmailSkip = () => {
    completeOnboarding();
  };

  // ─── Chat step logic ──────────────────────────────────────────────────────

  const advanceStep = (userAnswer: string) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    const step = currentStepRef.current;
    addUserMessage(userAnswer);

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
      // All questions answered — start the demo sequence instead of completing
      setTimeout(() => {
        setCurrentStep(nextStepIndex);
        currentStepRef.current = nextStepIndex;
        isProcessingRef.current = false;
        startDemoSequence();
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
    if (isSavingRef.current) return;
    if (!userId) {
      console.warn('[onboarding] completeOnboarding skipped: no userId');
      return;
    }
    isSavingRef.current = true;
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
      setTimeout(() => {
        router.replace('/(tabs)');
      }, 1200);
    } catch (error) {
      console.error('[onboarding] Error completing onboarding:', error);
      Alert.alert('Error', 'Failed to save your profile. Please try again.');
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  const currentQuestion = currentStep < ONBOARDING_STEPS.length ? ONBOARDING_STEPS[currentStep] : null;
  const showTextInput = currentQuestion?.type === 'text' && !isSaving;
  const showOptions = currentQuestion?.type === 'options' && !isSaving;
  const canSend = showTextInput && inputValue.trim().length > 0;
  const emailValid = /.+@.+\..+/.test(email.trim());

  // ─── Render helpers for special messages ─────────────────────────────────

  const renderClipsStrip = (small = false) => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.clipsScrollContent}
    >
      {DEMO_CLIPS.map((clip, index) => (
        <Pressable
          key={index}
          style={small ? styles.clipCardSmall : styles.clipCard}
          onPress={() => setPlayerSource(clip.video)}
        >
          <Image
            source={clip.thumb}
            style={small ? styles.clipImageSmall : styles.clipImage}
            resizeMode="cover"
          />
          <View style={styles.clipDurationBadge}>
            <Text style={styles.clipDurationText}>{clip.duration}</Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );

  const renderProgressRow = (msg: ChatMsg) => {
    const iconProps = { size: 16, strokeWidth: 2, color: Colors.gray500 };
    let icon: React.ReactNode;
    switch (msg.progressIcon) {
      case 'search': icon = <Search {...iconProps} />; break;
      case 'music': icon = <Music {...iconProps} />; break;
      case 'scissors': icon = <Scissors {...iconProps} />; break;
      default: icon = <CheckCircle2 {...iconProps} />; break;
    }
    return (
      <View style={styles.progressRow}>
        {icon}
        <Text style={styles.progressText}>{msg.content}</Text>
        <Text style={styles.progressTime}>· {msg.meta}</Text>
      </View>
    );
  };

  const renderResultCard = () => (
    <View style={styles.resultCard}>
      <Pressable onPress={() => setPlayerSource(DEMO_VIDEO)}>
        <Image source={DEMO_COVER} style={styles.resultCover} resizeMode="cover" />
        <View style={styles.resultPlayButton}>
          <Play size={28} color={Colors.white} strokeWidth={2} fill={Colors.white} />
        </View>
        <View style={styles.resultVersionBadge}>
          <Text style={styles.resultVersionText}>v1</Text>
        </View>
      </Pressable>
      <TouchableOpacity
        style={styles.copyAllButton}
        onPress={handleCopyAll}
        activeOpacity={0.7}
      >
        <Copy size={14} color={Colors.ink} strokeWidth={2} />
        <Text style={styles.copyAllText}>{copied ? 'Copied!' : 'Copy All'}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderEmailCard = () => (
    <View style={styles.emailCard}>
      <View style={styles.emailHeader}>
        <Text style={styles.emailTitle}>Your email</Text>
        <Pressable onPress={handleEmailSkip} hitSlop={8}>
          <Text style={styles.emailSkip}>Skip</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.emailInput}
        placeholder="you@example.com"
        placeholderTextColor={Colors.gray400}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TouchableOpacity
        style={[styles.emailButton, !emailValid && styles.emailButtonDisabled]}
        onPress={handleEmailSubmit}
        disabled={!emailValid || isSaving}
        activeOpacity={0.8}
      >
        <Text style={[styles.emailButtonText, !emailValid && styles.emailButtonTextDisabled]}>
          {isSaving ? 'Setting up...' : 'Stay in the loop'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderMessage = (msg: ChatMsg) => {
    if (msg.special === 'progress') return renderProgressRow(msg);
    if (msg.special === 'result') return renderResultCard();
    if (msg.special === 'email') return renderEmailCard();

    if (msg.role === 'assistant') {
      return (
        <Text style={styles.assistantText}>{msg.content}</Text>
      );
    }
    return (
      <View style={styles.userBubbleInner}>
        {msg.clips && renderClipsStrip(true)}
        <Text style={styles.userText}>{msg.content}</Text>
      </View>
    );
  };

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
          {messages.map((msg) => (
            <View
              key={msg.id}
              style={
                msg.special
                  ? styles.specialContainer
                  : msg.role === 'assistant'
                    ? styles.assistantBubble
                    : styles.userBubble
              }
            >
              {renderMessage(msg)}
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

          {isSaving && (
            <View style={styles.savingContainer}>
              <Text style={styles.savingText}>Setting up your account...</Text>
            </View>
          )}
        </ScrollView>

        {/* Bottom input bar */}
        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          {demoMode ? (
            /* Demo composer: clip strip + pre-filled prompt (mirrors original input card) */
            <View style={styles.demoInputCard}>
              <View style={styles.demoClipsWrap}>{renderClipsStrip(false)}</View>
              <View style={styles.demoPromptRow}>
                <View style={styles.plusButton}>
                  <Plus size={16} color={Colors.gray400} strokeWidth={2} />
                </View>
                <TextInput
                  style={styles.demoPromptInput}
                  value={DEMO_PROMPT_TEXT}
                  editable={false}
                  multiline
                  placeholderTextColor={Colors.gray400}
                />
                <TouchableOpacity
                  style={[
                    styles.sendButton,
                    isGenerating ? styles.sendButtonInactive : styles.sendButtonActive,
                  ]}
                  onPress={handleDemoSend}
                  disabled={isGenerating}
                  activeOpacity={0.7}
                >
                  <Send
                    size={18}
                    color={isGenerating ? Colors.gray400 : Colors.white}
                    strokeWidth={2}
                  />
                </TouchableOpacity>
              </View>
            </View>
          ) : (
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
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Video player modal */}
      <DemoVideoPlayerModal
        visible={playerSource !== null}
        source={playerSource ?? DEMO_VIDEO}
        onClose={() => setPlayerSource(null)}
      />
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
  specialContainer: {
    alignSelf: 'flex-start',
    width: '100%',
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
  // ─── Demo: clips strip (composer + user bubble) ────────────────────────
  clipsScrollContent: {
    gap: 8,
    paddingVertical: 2,
  },
  clipCard: {
    width: 108,
    height: 62,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  clipCardSmall: {
    width: 64,
    height: 38,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  clipImage: {
    width: '100%',
    height: '100%',
  },
  clipImageSmall: {
    width: '100%',
    height: '100%',
  },
  clipDurationBadge: {
    position: 'absolute',
    top: 3,
    right: 3,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  clipDurationText: {
    color: Colors.white,
    fontSize: 9,
    fontFamily: Fonts.interSemiBold,
  },
  // ─── Demo composer (input card during demo phase) ──────────────────────
  demoInputCard: {
    backgroundColor: Colors.white,
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
      default: {},
    }) as object,
  },
  demoClipsWrap: {
    marginBottom: 6,
  },
  demoPromptRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  demoPromptInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: Fonts.regular,
    color: Colors.gray500,
    lineHeight: 18,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 84,
  },
  // ─── Demo: progress rows ────────────────────────────────────────────────
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  progressText: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.gray500,
  },
  progressTime: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.gray400,
  },
  // ─── Demo: result card ──────────────────────────────────────────────────
  resultCard: {
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
      default: {},
    }) as object,
  },
  resultCover: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 16,
  },
  resultPlayButton: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -26,
    marginLeft: -26,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultVersionBadge: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  resultVersionText: {
    color: Colors.white,
    fontSize: 11,
    fontFamily: Fonts.interSemiBold,
  },
  copyAllButton: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  copyAllText: {
    fontSize: 12,
    fontFamily: Fonts.interSemiBold,
    color: Colors.ink,
  },
  // ─── Demo: email card ───────────────────────────────────────────────────
  emailCard: {
    backgroundColor: Colors.white,
    borderRadius: 18,
    padding: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
      default: {},
    }) as object,
  },
  emailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  emailTitle: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.ink,
  },
  emailSkip: {
    fontSize: 14,
    fontFamily: Fonts.regular,
    color: Colors.gray400,
  },
  emailInput: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.ink,
    marginBottom: 12,
  },
  emailButton: {
    backgroundColor: Colors.ember,
    borderRadius: 100,
    paddingVertical: 12,
    alignItems: 'center',
  },
  emailButtonDisabled: {
    backgroundColor: Colors.creamDark,
  },
  emailButtonText: {
    color: Colors.white,
    fontSize: 15,
    fontFamily: Fonts.medium,
  },
  emailButtonTextDisabled: {
    color: Colors.inkMuted,
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
