import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Dimensions,
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  Animated,
} from 'react-native';
import { X, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { Fonts } from '@/constants/typography';
import SoftCircleBackdrop from '@/components/SoftCircleBackdrop';
import { getScreenDimensions } from '@/lib/dimensions';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenDimensions();
export interface PreviewMediaItem {
  uri: string;
  type: 'image' | 'video';
}

interface MediaPreviewModalProps {
  visible: boolean;
  items: PreviewMediaItem[];
  initialIndex: number;
  onClose: () => void;
}

const MEDIA_RADIUS = 12;
const MAX_MEDIA_WIDTH = SCREEN_WIDTH - 32;
const MAX_MEDIA_HEIGHT = SCREEN_HEIGHT * 0.75;

function ImagePreview({ uri, onPress }: { uri: string; onPress: () => void }) {
  const [fitted, setFitted] = useState<{ width: number; height: number } | null>(null);

  return (
    <Pressable onPress={onPress} style={styles.mediaContainer}>
      <View style={[styles.mediaClip, fitted && { width: fitted.width, height: fitted.height }]}>
        <Image
          source={{ uri }}
          style={styles.mediaFill}
          resizeMode="cover"
          onLoad={(e) => {
            const { width: w, height: h } = e.nativeEvent.source;
            const scale = Math.min(MAX_MEDIA_WIDTH / w, MAX_MEDIA_HEIGHT / h);
            setFitted({ width: Math.round(w * scale), height: Math.round(h * scale) });
          }}
        />
      </View>
    </Pressable>
  );
}

function VideoPreviewPlayer({ uri, isActive }: { uri: string; isActive: boolean }) {
  const player = useVideoPlayer(uri, (p) => {
    if (isActive) p.play();
  });

  useEffect(() => {
    if (isActive) {
      player.currentTime = 0;
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, player]);

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.centeredAbsolute]}
      pointerEvents={isActive ? 'auto' : 'none'}
    >
      <View style={[styles.mediaClip, !isActive && { opacity: 0 }]}>
        <VideoView
          player={player}
          style={styles.mediaFill}
          contentFit="contain"
          nativeControls={isActive}
        />
      </View>
    </View>
  );
}

export default function MediaPreviewModal({
  visible,
  items,
  initialIndex,
  onClose,
}: MediaPreviewModalProps) {
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [contentMounted, setContentMounted] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Keyboard.dismiss();
      setCurrentIndex(initialIndex);
      setContentMounted(true);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();

      items.forEach((item) => {
        if (item.type === 'image') Image.prefetch(item.uri);
      });
    } else {
      setContentMounted(false);
      opacity.setValue(0);
    }
  }, [visible, initialIndex]);

  const handleClose = useCallback(() => {
    Animated.timing(opacity, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(() => {
      setContentMounted(false);
      onClose();
    });
  }, [onClose, opacity]);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => Math.min(prev + 1, items.length - 1));
  }, [items.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  if (!visible || items.length === 0) return null;

  const current = items[currentIndex];
  const hasMultiple = items.length > 1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < items.length - 1;

  return (
    <Animated.View style={[styles.overlay, { opacity }]}>
      {/* Top bar: counter + close */}
      <View style={[styles.topBar, { top: insets.top + 2 }]}>
        {hasMultiple ? (
          <Text style={styles.counterText}>
            {currentIndex + 1} / {items.length}
          </Text>
        ) : (
          <View />
        )}
        <Pressable
          onPress={handleClose}
          hitSlop={16}
        >
          <SoftCircleBackdrop>
            <X size={22} color="rgba(255, 255, 255, 0.85)" strokeWidth={1.5} />
          </SoftCircleBackdrop>
        </Pressable>
      </View>

      {/* Media area */}
      <View style={styles.mediaArea}>
        {/* Left arrow */}
        {hasMultiple && hasPrev && (
          <Pressable
            style={styles.arrowLeft}
            onPress={goPrev}
            hitSlop={12}
          >
            <SoftCircleBackdrop>
              <ChevronLeft size={24} color="rgba(255, 255, 255, 0.85)" strokeWidth={1.5} />
            </SoftCircleBackdrop>
          </Pressable>
        )}

        {/* Current media */}
        <View style={styles.mediaContainer}>
          {contentMounted && items.map((item, idx) => {
            const isActive = idx === currentIndex;
            const isAdjacent = Math.abs(idx - currentIndex) <= 1;

            if (item.type === 'video' && isAdjacent) {
              return (
                <VideoPreviewPlayer
                  key={item.uri}
                  uri={item.uri}
                  isActive={isActive}
                />
              );
            }

            if (item.type === 'image' && isActive) {
              return (
                <ImagePreview
                  key={item.uri}
                  uri={item.uri}
                  onPress={handleClose}
                />
              );
            }

            return null;
          })}
        </View>

        {/* Right arrow */}
        {hasMultiple && hasNext && (
          <Pressable
            style={styles.arrowRight}
            onPress={goNext}
            hitSlop={12}
          >
            <SoftCircleBackdrop>
              <ChevronRight size={24} color="rgba(255, 255, 255, 0.85)" strokeWidth={1.5} />
            </SoftCircleBackdrop>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    zIndex: 9999,
  },
  topBar: {
    position: 'absolute',
    left: 16,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counterText: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 14,
    fontFamily: Fonts.medium,
  },
  mediaArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowLeft: {
    position: 'absolute',
    left: 4,
    zIndex: 10,
  },
  arrowRight: {
    position: 'absolute',
    right: 4,
    zIndex: 10,
  },
  mediaContainer: {
    width: SCREEN_WIDTH,
    height: MAX_MEDIA_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mediaClip: {
    width: MAX_MEDIA_WIDTH,
    height: MAX_MEDIA_HEIGHT,
    borderRadius: MEDIA_RADIUS,
    overflow: 'hidden',
  },
  centeredAbsolute: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  mediaFill: {
    width: '100%',
    height: '100%',
  },
});
