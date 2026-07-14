import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const frontendDir = path.resolve(__dirname, 'src/frontend');

export default defineConfig({
  root: frontendDir,
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(frontendDir, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'public/dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: path.resolve(frontendDir, 'index.html'),
      output: {
        // manualChunks disabled temporarily — was causing
        // "Cannot access before initialization" in production
      },
    },
  },
});
