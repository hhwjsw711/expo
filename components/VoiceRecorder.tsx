import { Mic, Square, Play, Pause, RotateCcw, Check } from 'lucide-react-native';
import { useEffect, useState, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, Alert } from 'react-native';
import {
  useAudioRecorder,
  useAudioPlayer,
  useAudioPlayerStatus,
  createAudioPlayer,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  RecordingPresets,
  type AudioPlayer,
} from 'expo-audio';
import Colors from '@/constants/colors';

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
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recordingUri, setRecordingUri] = useState<string | undefined>(initialRecordingUri);
  const [isRecording, setIsRecording] = useState(false);
  const [isPrepared, setIsPrepared] = useState(false);
  const [player, setPlayer] = useState<AudioPlayer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

  // useAudioPlayer requires a fixed source at hook call time; we manage playback manually
  // via createAudioPlayer for dynamic URIs (recording playback).

  useEffect(() => { playerRef.current = player; }, [player]);

  // Check permission status on mount
  useEffect(() => {
    const checkPermission = async () => {
      const { status } = await getRecordingPermissionsAsync();
      setHasPermission(status === 'granted');
    };
    checkPermission();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      if (playerRef.current) playerRef.current.remove();
    };
  }, []);

  const handleRecordPress = async () => {
    if (isRecording) {
      await stopRecording();
      return;
    }

    if (hasPermission) {
      await startRecording();
      return;
    }

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (permission.granted) {
        setHasPermission(true);
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
      if (onBeforeRecord) {
        await onBeforeRecord();
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      // Clean up any playback player before recording
      if (playerRef.current) {
        playerRef.current.remove();
        setPlayer(null);
        setIsPlaying(false);
      }

      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecording(true);
      setDuration(0);
      setIsPrepared(true);

      durationIntervalRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      console.error('Failed to start recording:', error);
      Alert.alert('Error', 'Failed to start recording. Please try again.');
      setIsPrepared(false);
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;

    try {
      setIsRecording(false);

      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }

      await recorder.stop();
      const uri = recorder.uri;

      if (uri) {
        setRecordingUri(uri);
      }
      setIsPrepared(false);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      Alert.alert('Error', 'Failed to stop recording. Please try again.');
      setIsPrepared(false);
    }
  };

  const restartRecording = async () => {
    if (isRecording) {
      try {
        await recorder.stop();
      } catch (e) {
        console.error('Failed to stop recording for restart:', e);
      }
      setIsRecording(false);
    }
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    setRecordingUri(undefined);
    setDuration(0);
    setIsPrepared(false);
    setTimeout(() => startRecording(), 100);
  };

  const playRecording = async () => {
    if (!recordingUri) return;

    try {
      // If currently playing, pause
      if (player && isPlaying) {
        player.pause();
        setIsPlaying(false);
        return;
      }

      // If player exists but paused, resume
      if (player && !isPlaying) {
        player.play();
        setIsPlaying(true);
        return;
      }

      // Create new player
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });

      const newPlayer = createAudioPlayer({ uri: recordingUri });
      setPlayer(newPlayer);
      setIsPlaying(true);

      newPlayer.addListener('playbackStatusUpdate', (status) => {
        if (status.isLoaded && status.didJustFinish) {
          setIsPlaying(false);
          newPlayer.seekTo(0);
        }
      });

      newPlayer.play();
    } catch (error) {
      console.error('Failed to play recording:', error);
      Alert.alert('Error', 'Failed to play recording. Please try again.');
    }
  };

  const resetRecording = async () => {
    if (player) {
      player.remove();
      setPlayer(null);
    }
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
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
