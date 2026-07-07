import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// root는 web (package.json의 `vite web` / `vite build web`).
// dev 프록시: /api 를 API 서버(기본 127.0.0.1:3001)로 동일 출처처럼 포워딩한다.
// 이유 — SSE(/api/stream) 인증은 EventSource가 헤더를 못 보내므로 세션 쿠키에 의존한다.
//   dev 쿠키는 SameSite=Lax라 cross-origin EventSource에 첨부되지 않아 실시간이 끊긴다(REST는 x-session-id 헤더 폴백으로 동작).
//   같은 출처로 프록시하면 Lax 쿠키가 first-party로 실려 SSE 인증이 통과한다(server/index.js: "로컬은 동일 머신/프록시 운용" 전제).
const API_TARGET = process.env.VITE_API_BASE ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // 업로드 파일 정적 서빙(server/index.js: app.use('/uploads', express.static(uploadDir))).
      // 본문 이미지 임베드·첨부/자료 링크가 /uploads/<hex>.<ext> 상대경로를 쓰므로, 프록시가 없으면
      // dev(vite 출처)에서 404가 나 붙여넣은 이미지가 보이지 않는다(빌드 서빙에서는 백엔드 동일 출처라 무관).
      '/uploads': { target: API_TARGET, changeOrigin: true },
    },
  },
});
