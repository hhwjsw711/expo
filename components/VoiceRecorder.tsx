import { Mic, Square, Play, Pause, RotateCcw, Check } from 'lucide-react-native';
import { useEffect, useState, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, Alert } from 'react-native';
import { Audio } from 'expo-av';
import Colors from '@/constants/colors';

// const SCRIPT_TEXT = `Morning rush? Meet your new ritual.
// The new AromaBrew One brings the café to your kitchen — freshly ground beans, perfect temperature, and silky crema every single time.
// Whether you crave a bold espresso or a smooth latte, it's ready in under a minute with just one touch.
// Sleek, smart, and effortless — designed to fit your countertop and your lifestyle.
// AromaBrew One. Wake up better.`;

const SCRIPT_TEXT = `Wow, Reelful is such a cool app! It helps me turn my photos and videos into a ready-to-share clip using just one prompt. I don't need to record my voice, search for music, or spend hours editing. Reelful automatically adds voice-over, music, and captions. It makes content creation fast, fun, and effortless. I can't wait to use Reelful for my next video!`;

interface VoiceRecorderProps {
  onRecordingComplete: (uri: string) => void;
  onBeforeRecord?: () => Promise<void>;
  initialRecordingUri?: string;
  showScript?: boolean;
  disabled?: boolean;
}

export default function VoiceRecorder({ 
  onRecordingComplete, 
  onBeforeRecord,
  initialRecordingUri,
  showScript = true,
  disabled = false,
}: VoiceRecorderProps) {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingUri, setRecordingUri] = useState<string | undefined>(initialRecordingUri);
  const [isRecording, setIsRecording] = useState(false);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Keep refs in sync with state for cleanup
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => { soundRef.current = sound; }, [sound]);

  // Check permission status on mount (without requesting)
  useEffect(() => {
    const checkPermission = async () => {
      const { status } = await Audio.getPermissionsAsync();
      setHasPermission(status === 'granted');
    };
    checkPermission();
  }, []);

  useEffect(() => {
    return () => {
      // Cleanup on unmount using refs for current values
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
      if (recordingRef.current) {
        recordingRef.current.getStatusAsync().then((status) => {
          if (status.isRecording || status.canRecord) {
            recordingRef.current?.stopAndUnloadAsync().catch(console.error);
          }
        }).catch(console.error);
      }
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(console.error);
      }
    };
  }, []); // Empty deps - only run on unmount

  const handleRecordPress = async () => {
    // If already recording, stop it
    if (isRecording) {
      await stopRecording();
      return;
    }

    // Check if we already have permission
    if (hasPermission) {
      // Permission already granted, start recording
      await startRecording();
      return;
    }

    // Need to request permission
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.granted) {
        // Permission just granted - update state but DON'T start recording
        // User needs to tap again to start recording
        setHasPermission(true);
        // Don't start recording automatically - let user tap again
      } else {
        Alert.alert(
          'Permission Required',
          'Please grant microphone permissions to record your voice. You can enable this in your device Settings.',
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('Failed to request permission:', error);
      Alert.alert('Error', 'Failed to request microphone permission.');
    }
  };

  const startRecording = async () => {
    try {
      // Allow parent to clean up any loaded sounds that would conflict
      // with the iOS audio session switch to recording mode
      if (onBeforeRecord) {
        await onBeforeRecord();
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording: newRecording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecording(newRecording);
      setIsRecording(true);
      setDuration(0);

      // Update duration while recording
      durationIntervalRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);

      newRecording.setOnRecordingStatusUpdate((status) => {
        if (status.isDoneRecording && durationIntervalRef.current) {
          clearInterval(durationIntervalRef.current);
          durationIntervalRef.current = null;
        }
      });
    } catch (error) {
      console.error('Failed to start recording:', error);
      Alert.alert('Error', 'Failed to start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    if (!recording) return;

    try {
      setIsRecording(false);
      
      // Clear the duration interval
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      
      const uri = recording.getURI();
      await recording.stopAndUnloadAsync();
      
      // Clear recording state after unloading
      setRecording(null);

      if (uri) {
        setRecordingUri(uri);
      }
    } catch (error) {
      console.error('Failed to stop recording:', error);
      Alert.alert('Error', 'Failed to stop recording. Please try again.');
      setRecording(null); // Clear state even on error
    }
  };

  const restartRecording = async () => {
    // Stop and discard the current recording, then start fresh
    if (recording) {
      try {
        await recording.stopAndUnloadAsync();
      } catch (e) {
        console.error('Failed to stop recording for restart:', e);
      }
      setRecording(null);
    }
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    setIsRecording(false);
    setRecordingUri(undefined);
    setDuration(0);
    // Start fresh recording after a short delay to let audio system settle
    setTimeout(() => startRecording(), 100);
  };

  const playRecording = async () => {
    if (!recordingUri) return;

    try {
      if (sound && isPlaying) {
        await sound.pauseAsync();
        setIsPlaying(false);
        return;
      }

      if (sound && !isPlaying) {
        await sound.playAsync();
        setIsPlaying(true);
        return;
      }

      // Set audio mode to play in silent mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: recordingUri },
        { shouldPlay: true }
      );

      setSound(newSound);
      setIsPlaying(true);

      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setIsPlaying(false);
        }
      });
    } catch (error) {
      console.error('Failed to play recording:', error);
      Alert.alert('Error', 'Failed to play recording. Please try again.');
    }
  };

  const resetRecording = async () => {
    if (sound) {
      await sound.unloadAsync().catch(console.error);
      setSound(null);
    }
    // Reset audio mode to be ready for recording again
    // (playRecording sets allowsRecordingIOS to false)
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    }).catch(console.error);
    setRecordingUri(undefined);
    setIsPlaying(false);
    setDuration(0);
  };

  const confirmRecording = () => {
    if (recordingUri) {
      onRecordingComplete(recordingUri);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <View style={styles.container}>
      {showScript && (
        <View style={styles.scriptContainer}>
          <Text style={styles.scriptTitle}>Read this script:</Text>
          <View style={styles.scriptBox}>
            <Text style={styles.scriptText}>{SCRIPT_TEXT}</Text>
          </View>
        </View>
      )}

      <View style={styles.recorderContainer}>
        {!recordingUri ? (
          <>
            <TouchableOpacity
              style={[styles.recordButton, isRecording && styles.recordingActive]}
              onPress={handleRecordPress}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.recordButtonInner,
                  { backgroundColor: isRecording ? '#DC2626' : Colors.ember }
                ]}
              >
                {isRecording ? (
                  <Square size={26} color={Colors.white} fill={Colors.white} />
                ) : (
                  <Mic size={26} color={Colors.white} strokeWidth={2} />
                )}
              </View>
            </TouchableOpacity>
            <Text style={styles.instruction}>
              {isRecording
                ? `Recording... ${formatDuration(duration)}`
                : hasPermission === false
                ? 'Tap to enable microphone'
                : 'Tap to start recording'}
            </Text>
            {isRecording && (
              <TouchableOpacity
                style={styles.restartButton}
                onPress={restartRecording}
                activeOpacity={0.7}
              >
                <RotateCcw size={16} color={Colors.textSecondary} strokeWidth={2} />
                <Text style={styles.restartButtonText}>Restart</Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <>
            <View style={styles.playbackControls}>
              <TouchableOpacity
                style={styles.controlButton}
                onPress={playRecording}
                activeOpacity={0.7}
              >
                {isPlaying ? (
                  <Pause size={24} color={Colors.ember} strokeWidth={2} />
                ) : (
                  <Play size={24} color={Colors.ember} strokeWidth={2} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.controlButton}
                onPress={resetRecording}
                activeOpacity={0.7}
              >
                <RotateCcw size={24} color={Colors.textSecondary} strokeWidth={2} />
              </TouchableOpacity>
            </View>
            <Text style={styles.instruction}>
              {isPlaying ? 'Playing...' : 'Tap play to review or re-record'}
            </Text>
            <TouchableOpacity
              style={[styles.confirmButton, disabled && styles.confirmButtonDisabled]}
              onPress={confirmRecording}
              activeOpacity={0.8}
              disabled={disabled}
            >
              <View
                style={[
                  styles.confirmButtonInner,
                  { backgroundColor: disabled ? Colors.creamDark : Colors.ember }
                ]}
              >
                <Check size={20} color={Colors.white} strokeWidth={3} />
                <Text style={styles.confirmButtonText}>{disabled ? 'Uploading...' : 'Use This Recording'}</Text>
              </View>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 16,
  },
  scriptContainer: {
    gap: 12,
  },
  scriptTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.ink,
    opacity: 0.9,
  },
  scriptBox: {
    backgroundColor: Colors.creamMedium,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.creamDark,
  },
  scriptText: {
    fontSize: 13,
    lineHeight: 20,
    color: Colors.ink,
    opacity: 0.9,
  },
  recorderContainer: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  recordButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    overflow: 'hidden',
  },
  recordingActive: {
    transform: [{ scale: 1.05 }],
  },
  recordButtonInner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  instruction: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 4,
  },
  restartButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  restartButtonText: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontWeight: '500' as const,
  },
  playbackControls: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
  },
  controlButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.creamDark,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.creamDarker,
  },
  confirmButton: {
    marginTop: 10,
    borderRadius: 12,
    overflow: 'hidden',
    width: '100%',
  },
  confirmButtonInner: {
    flexDirection: 'row',
    padding: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
  },
  confirmButtonText: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: Colors.white,
  },
  confirmButtonDisabled: {
    opacity: 0.7,
  },
});

