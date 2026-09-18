import React, { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Colors from '@/constants/colors';

const IPHONE_WIDTH = 390;
const IPHONE_HEIGHT = 844;
const FRAME_BORDER_RADIUS = 44;

function injectWebStyles() {
  if (typeof document === 'undefined') return;

  const styleId = 'iphone-frame-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    html, body {
      height: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      background-color: #111111 !important;
      overflow: hidden !important;
    }
    #root {
      display: flex !important;
      height: 100% !important;
      align-items: center !important;
      justify-content: center !important;
      background-color: #111111 !important;
    }
    #root > div {
      flex: unset !important;
      width: auto !important;
      height: auto !important;
    }
  `;
  document.head.appendChild(style);
}

export default function IPhoneFrameWrapper({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    injectWebStyles();
  }, []);

  return (
    <View style={styles.phoneFrame}>
      <View style={styles.innerContent}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  phoneFrame: {
    width: IPHONE_WIDTH,
    height: IPHONE_HEIGHT,
    borderRadius: FRAME_BORDER_RADIUS,
    overflow: 'hidden',
    backgroundColor: Colors.dark,
    // @ts-ignore - web-only shadow property
    boxShadow: '0 25px 60px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255,255,255,0.08)',
  },
  innerContent: {
    flex: 1,
    overflow: 'hidden',
  },
});
