import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// root는 web (package.json의 `vite web` / `vite build web`).
export default defineConfig({
  plugins: [react()],
});
