import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ghcr.manager',
  appName: 'GHCR Manager',
  webDir: 'dist',
  plugins: {
    // Enables native OS HTTP networking on Android (OkHttp) & iOS (URLSession)
    // so direct requests to https://ghcr.io and https://api.github.com bypass WebView CORS.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
