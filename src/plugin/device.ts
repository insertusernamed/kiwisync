import { Platform } from 'obsidian';
import type { Platform as DevicePlatform } from '../shared/protocol';

export function devicePlatform(): DevicePlatform {
  if (Platform.isIosApp) return 'ios';
  if (Platform.isAndroidApp) return 'android';
  return 'desktop';
}

export function defaultDeviceName(): string {
  if (Platform.isIosApp) return Platform.isTablet ? 'iPad' : 'iPhone';
  if (Platform.isAndroidApp) {
    // Recent Android versions report the model as "K" to reduce fingerprinting.
    const model = /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent)?.[1]?.trim();
    return model && model !== 'K' ? model : 'Android phone';
  }
  const os = (window as unknown as { require?: (m: string) => { hostname(): string } }).require?.(
    'os',
  );
  return os?.hostname() ?? 'Computer';
}
