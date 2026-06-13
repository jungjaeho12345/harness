import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['node_modules/**', 'web/dist/**', 'dist/**', 'scripts/**', 'news.db'],
  },
  js.configs.recommended,
  {
    // 백엔드 + 루트 (Node)
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // 프론트엔드 React (브라우저)
    files: ['web/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React 19 자동 JSX 런타임 — React를 스코프에 import할 필요 없음.
      'react/react-in-jsx-scope': 'off',
      // 타입 강제는 ADR상 사용하지 않음 (순수 JS).
      'react/prop-types': 'off',
    },
  },
  {
    // 프론트엔드 설정/테스트 파일은 Node 환경에서 실행됨.
    files: ['web/*.config.js', 'web/src/test/**', 'web/**/*.test.{js,jsx}'],
    languageOptions: { globals: { ...globals.node } },
  },
];
