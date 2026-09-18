import { Dimensions, Platform } from 'react-native';

export const IPHONE_WIDTH = 390;
export const IPHONE_HEIGHT = 844;

export function getScreenDimensions() {
  if (Platform.OS === 'web') {
    return { width: IPHONE_WIDTH, height: IPHONE_HEIGHT };
  }
  return Dimensions.get('window');
}
