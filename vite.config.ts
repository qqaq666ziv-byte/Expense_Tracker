import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
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
          name: '柴柴極速記帳',
          short_name: '柴柴記帳',
          description: '精巧可愛的柴犬主題記帳與財務理財應用，包含極速記帳、財務分析與柴柴存錢筒三大功能。',
          theme_color: '#8a5100',
          background_color: '#fef9ef',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            {
              src: 'https://lh3.googleusercontent.com/aida/AP1WRLvCxge5sJSSssIM8ubslO83DutScN_zVO97CpgRYTEtQ0o-7gObZP3qktmyhk8-tXe_h-myeHS-tinYMHcFCBEvImS3GRbT-92KKwyKl-n2rbG1ihxU678g2rEenyaynxoT9KsU1ZQqX6s_TM5duEZvqLrQB0kw0xa0x2HJW5URM3IOccplDd_OGtakYYH8V6Q0Tkl1CMyaRQIKmMZnzXyQUQ-pwc0Y52fVerzBsIT5etz4zTfXcWET9joD',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'https://lh3.googleusercontent.com/aida/AP1WRLvCxge5sJSSssIM8ubslO83DutScN_zVO97CpgRYTEtQ0o-7gObZP3qktmyhk8-tXe_h-myeHS-tinYMHcFCBEvImS3GRbT-92KKwyKl-n2rbG1ihxU678g2rEenyaynxoT9KsU1ZQqX6s_TM5duEZvqLrQB0kw0xa0x2HJW5URM3IOccplDd_OGtakYYH8V6Q0Tkl1CMyaRQIKmMZnzXyQUQ-pwc0Y52fVerzBsIT5etz4zTfXcWET9joD',
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        }
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 8888,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
