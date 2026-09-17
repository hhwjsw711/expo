import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  Dimensions,
  Platform,
} from 'react-native';
import {
  X,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  MoreHorizontal,
  Check,
  Clock,
} from 'lucide-react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { Fonts } from '@/constants/typography';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 2];

interface DemoVideoPlayerModalProps {
  visible: boolean;
  source: number | { uri: string };
  onClose: () => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ControlButton({
  onPress,
  children,
  size = 48,
}: {
  onPress: () => void;
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.controlBtn,
        { width: size, height: size, borderRadius: size / 2, opacity: pressed ? 0.7 : 1 },
        size > 48 && styles.controlBtnLarge,
      ]}
    >
      {children}
    </Pressable>
  );
}

export default function DemoVideoPlayerModal({
  visible,
  source,
  onClose,
}: DemoVideoPlayerModalProps) {
  const insets = useSafeAreaInsets();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [trackWidth, setTrackWidth] = useState(0);

  const player = useVideoPlayer(source as never, (p) => {
    p.loop = true;
    // Web requires an explicit interval for timeUpdate to fire (defaults to 0 = disabled)
    p.timeUpdateEventInterval = 0.5;
  });

  // Sync player state
  useEffect(() => {
    if (!visible) return;
    player.currentTime = 0;
    player.play();
    const sub = player.addListener('timeUpdate', (payload) => {
      setCurrentTime(payload.currentTime);
    });
    const statusSub = player.addListener('statusChange', () => {
      setIsPlaying(player.playing);
      if (player.duration && isFinite(player.duration)) {
        setDuration(player.duration);
      }
    });
    return () => {
      sub.remove();
      statusSub.remove();
      player.pause();
    };
  }, [visible, player]);

  // Reset menus when closed
  useEffect(() => {
    if (!visible) {
      setSpeedMenuOpen(false);
      setPlaybackRate(1);
      if (player) player.playbackRate = 1;
    }
  }, [visible, player]);

  const togglePlay = useCallback(() => {
    if (player.playing) {
      player.pause();
    } else {
      player.play();
    }
  }, [player]);

  const seekBy = useCallback(
    (seconds: number) => {
      const target = Math.max(0, Math.min((player.currentTime || 0) + seconds, duration || 0));
      player.currentTime = target;
      setCurrentTime(target);
    },
    [player, duration]
  );

  const toggleMute = useCallback(() => {
    player.muted = !player.muted;
    setIsMuted(player.muted);
  }, [player]);

  const applySpeed = useCallback(
    (rate: number) => {
      player.playbackRate = rate;
      setPlaybackRate(rate);
      setSpeedMenuOpen(false);
    },
    [player]
  );

  const handleProgressPress = useCallback(
    (evt: { nativeEvent: { locationX: number } }) => {
      if (trackWidth <= 0 || !duration) return;
      const ratio = Math.max(0, Math.min(evt.nativeEvent.locationX / trackWidth, 1));
      const target = ratio * duration;
      player.currentTime = target;
      setCurrentTime(target);
    },
    [player, duration, trackWidth]
  );

  const progressRatio = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.touchArea}
          onPress={() => {
            if (speedMenuOpen) {
              setSpeedMenuOpen(false);
            } else {
              onClose();
            }
          }}
        />

        {/* Top controls */}
        <View style={[styles.topBar, { paddingTop: insets.top + 12 }]}>
          <ControlButton onPress={toggleMute}>
            {isMuted ? (
              <VolumeX size={20} color="rgba(255,255,255,0.9)" strokeWidth={2} />
            ) : (
              <Volume2 size={20} color="rgba(255,255,255,0.9)" strokeWidth={2} />
            )}
          </ControlButton>
          <ControlButton onPress={onClose}>
            <X size={22} color="rgba(255,255,255,0.9)" strokeWidth={2} />
          </ControlButton>
        </View>

        {/* Video — tap to toggle play/pause (mirrors original player) */}
        <View style={styles.videoContainer}>
          <Pressable onPress={togglePlay} style={styles.videoHitArea}>
            <VideoView
              player={player}
              style={styles.video}
              contentFit="contain"
              nativeControls={false}
            />
          </Pressable>
        </View>

        {/* Center controls */}
        <View style={[styles.centerControls, { marginBottom: insets.bottom + 130 }]}>
          <ControlButton onPress={() => seekBy(-10)} size={44}>
            <View style={styles.seekBtnInner}>
              <RotateCcw size={16} color="rgba(255,255,255,0.9)" strokeWidth={2} />
              <Text style={styles.seekText}>10</Text>
            </View>
          </ControlButton>
          <ControlButton onPress={togglePlay} size={64}>
            {isPlaying ? (
              <Pause size={26} color="rgba(255,255,255,0.95)" strokeWidth={2} fill="rgba(255,255,255,0.95)" />
            ) : (
              <Play size={26} color="rgba(255,255,255,0.95)" strokeWidth={2} fill="rgba(255,255,255,0.95)" />
            )}
          </ControlButton>
          <ControlButton onPress={() => seekBy(10)} size={44}>
            <View style={styles.seekBtnInner}>
              <RotateCw size={16} color="rgba(255,255,255,0.9)" strokeWidth={2} />
              <Text style={styles.seekText}>10</Text>
            </View>
          </ControlButton>
        </View>

        {/* Bottom controls */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.progressRow}>
            <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
            <Pressable
              style={styles.progressTrack}
              onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
              onPress={handleProgressPress}
            >
              <View style={styles.progressTrackInner}>
                <View style={[styles.progressFill, { width: `${progressRatio * 100}%` as `${number}%` }]} />
              </View>
            </Pressable>
            <Text style={styles.timeText}>-{formatTime(Math.max(0, (duration || 0) - currentTime))}</Text>
            <ControlButton onPress={() => setSpeedMenuOpen((v) => !v)} size={36}>
              <MoreHorizontal size={20} color="rgba(255,255,255,0.9)" strokeWidth={2} />
            </ControlButton>
          </View>
        </View>

        {/* Speed menu (frosted sheet, mirrors original Playback Speed panel) */}
        {speedMenuOpen && (
          <View style={[styles.speedMenu, { bottom: insets.bottom + 80 }]}>
            <View style={styles.speedMenuHeader}>
              <Clock size={18} color={Colors.ink} strokeWidth={2} />
              <Text style={styles.speedMenuTitle}>Playback Speed</Text>
            </View>
            {SPEED_OPTIONS.map((rate) => (
              <Pressable
                key={rate}
                style={({ pressed }) => [
                  styles.speedOption,
                  pressed && { backgroundColor: 'rgba(0,0,0,0.06)' },
                ]}
                onPress={() => applySpeed(rate)}
              >
                <Text style={styles.speedOptionText}>
                  {rate === 1 ? '1×' : `${rate}×`}
                </Text>
                {playbackRate === rate && <Check size={18} color={Colors.ink} strokeWidth={2.5} />}
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.88)',
  },
  touchArea: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 20,
  },
  videoContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoHitArea: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: SCREEN_WIDTH - 24,
    height: (SCREEN_WIDTH - 24) * 9 / 16,
  },
  centerControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    zIndex: 20,
  },
  controlBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnLarge: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  seekBtnInner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  seekText: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.95)',
    fontFamily: Fonts.interSemiBold,
    marginTop: 1,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 10,
  },
  timeText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontFamily: Fonts.interRegular,
    minWidth: 32,
  },
  progressTrack: {
    flex: 1,
    height: 20,
    justifyContent: 'center',
  },
  progressTrackInner: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 2,
  },
  speedMenu: {
    position: 'absolute',
    left: 24,
    right: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 18,
    paddingVertical: 8,
    zIndex: 30,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.25,
        shadowRadius: 16,
      },
      default: { elevation: 12 },
    }) as object,
  },
  speedMenuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  speedMenuTitle: {
    fontSize: 16,
    fontFamily: Fonts.medium,
    color: Colors.ink,
    flex: 1,
  },
  speedOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  speedOptionText: {
    fontSize: 15,
    fontFamily: Fonts.regular,
    color: Colors.ink,
  },
});
