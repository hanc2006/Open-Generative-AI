import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        proxy: {
            // The studio package prefixes its calls with /api (/api/api/v1/*, /api/workflow/*, ...)
            '/api/api': { target: 'https://api.muapi.ai', changeOrigin: true, secure: false, rewrite: (path) => path.replace(/^\/api/, '') },
            '/api/workflow': { target: 'https://api.muapi.ai', changeOrigin: true, secure: false, rewrite: (path) => path.replace(/^\/api/, '') },
            '/api/app': { target: 'https://api.muapi.ai', changeOrigin: true, secure: false, rewrite: (path) => path.replace(/^\/api/, '') },
            '/api/agents': { target: 'https://api.muapi.ai', changeOrigin: true, secure: false, rewrite: (path) => path.replace(/^\/api/, '') },
            '/api': {
                target: 'https://api.muapi.ai',
                changeOrigin: true,
                secure: false
            }
        }
    }
});
