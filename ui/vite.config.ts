import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // IPv4 loopback explicitly — the Tailscale Funnel proxies to 127.0.0.1,
    // and Node would otherwise bind 'localhost' to ::1 only on macOS.
    host: '127.0.0.1',
    // Accept requests arriving via the Tailscale Funnel hostname in dev.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env['VITE_API_URL'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
      // Notion webhooks share the single public origin, like nginx in prod.
      '/webhooks': {
        target: process.env['VITE_API_URL'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
      // Agent avatars (public route, also fetched by Slack in prod).
      '/icons': {
        target: process.env['VITE_API_URL'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
