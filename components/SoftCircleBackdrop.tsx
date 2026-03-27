import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Circle as SvgCircle } from 'react-native-svg';

const BACKDROP_SIZE = 52;

export default function SoftCircleBackdrop({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ width: BACKDROP_SIZE, height: BACKDROP_SIZE, alignItems: 'center', justifyContent: 'center' }}>
      <Svg
        width={BACKDROP_SIZE}
        height={BACKDROP_SIZE}
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <RadialGradient id="softGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="black" stopOpacity="0.2" />
            <Stop offset="40%" stopColor="black" stopOpacity="0.1" />
            <Stop offset="80%" stopColor="black" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <SvgCircle cx={BACKDROP_SIZE / 2} cy={BACKDROP_SIZE / 2} r={BACKDROP_SIZE / 2} fill="url(#softGlow)" />
      </Svg>
      {children}
    </View>
  );
}
