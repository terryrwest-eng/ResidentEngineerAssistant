import { CapacitorConfig } from '@capacitor/cli';

/**
 * Daily Reporter V3 — Capacitor Configuration
 *
 * webDir: Vite build output directory (npm run build → dist/)
 * appId: Reverse-domain bundle ID — used as the Android package name.
 * server.url: Leave commented out for a fully bundled offline-capable APK.
 *             Uncomment to point at the live Railway URL for a thin-client build.
 *
 * WHY bundled vs thin-client:
 *   Bundled (default) — All JS/CSS lives inside the APK. Works offline for local
 *     data entry. API calls still go to Railway for AI features.
 *   Thin-client — APK just loads the Railway web app in a WebView. Requires internet
 *     for everything including the UI. Simpler to update but no offline capability.
 */
const config: CapacitorConfig = {
  appId: 'com.ohla.dailyreporter',
  appName: 'Daily Reporter',
  webDir: 'dist',
  plugins: {
    // SplashScreen shown while the WebView loads
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#ffffff',
      showSpinner: false,
    },
  },
  android: {
    // Allow cleartext (HTTP) for local dev if needed; Railway uses HTTPS so safe to remove
    allowMixedContent: false,
    // captureInput: REMOVED — was blocking swipe/glide typing by intercepting
    // touch events before Gboard's gesture detector could process them.
    webContentsDebuggingEnabled: true, // Disable before final release
  },
  // server: {
  //   url: 'https://residentengineerassistant-production.up.railway.app',
  //   cleartext: false,
  // },
};

export default config;
