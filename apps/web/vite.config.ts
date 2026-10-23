import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// monorepo：构建产物输出到 apps/server/public，由 Fastify 后端静态托管。
// 开发时（npm run dev）把 /api 代理到本地后端（默认 8730）。
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8730',
    },
  },
});
