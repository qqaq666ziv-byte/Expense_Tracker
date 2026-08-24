import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(), 
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: '柴柴記帳',
          short_name: '柴柴記帳',
          lang: 'zh-TW',
          description: '三個選擇記下一筆，慢慢看懂錢去了哪裡、現在放在哪裡。',
          start_url: '/',
          theme_color: '#d96512',
          background_color: '#f8f3eb',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            {
              src: '/icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: '/icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png'
            },
            {
              src: '/icons/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            }
          ]
        }
      })
    ],
    resolve: {
      alias: {
        '@': import.meta.dirname,
      },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [{
              name: 'supabase-vendor',
              test: /node_modules[\\/]@supabase[\\/]/,
              priority: 10,
            }],
          },
        },
      },
    },
    server: {
      port: 8888,
      host: '0.0.0.0',
      // HMR can be disabled via DISABLE_HMR for hosted or automated environments.
      // File watching is disabled at the same time to reduce unnecessary resource usage.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
