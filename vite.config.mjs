import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const shim = (name) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url));
const pkg = (path) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            // Next.js APIs used by the studio/workflow/agent packages are served by in-memory shims
            'next/navigation': shim('next-navigation.jsx'),
            'next/link': shim('next-link.jsx'),
            'next/image': shim('next-image.jsx'),
            'next/dynamic': shim('next-dynamic.jsx'),
            'next-themes': shim('next-themes.jsx'),
            'workflow-builder': pkg('Vibe-Workflow/packages/workflow-builder/src/index.js'),
            'ai-agent': pkg('Open-Poe-AI/packages/agents/src/index.js'),
        },
    },
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
