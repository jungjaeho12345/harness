import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // React 자동 JSX 런타임 — 컴포넌트/훅 테스트(.jsx)가 React import 없이 동작하도록(빌드와 동일).
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.js'],
  },
});
