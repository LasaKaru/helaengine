import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The rule that matters most here is the `/packages/engine` boundary at the bottom of this file.
 *
 * The engine is the code that ships inside every exported project. If a UI framework, a state
 * library or editor code ever reaches it through an import, exports silently stop working — so it
 * is enforced mechanically from commit #1 rather than by memory. See GUIDE.md section 7, risk 1.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-*',
                '@react-three/*',
                'zustand',
                'zustand/*',
                'immer',
                '@helaengine/editor',
                '@helaengine/editor/*',
                '**/apps/editor/**',
              ],
              message:
                'The engine runs standalone inside exported projects. It must not import UI frameworks, editor state libraries, or editor code. Move this logic into /apps/editor and call the engine from there.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/schema/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*', 'react', 'react-*', '@helaengine/*'],
              message:
                'The schema package is the shared contract between engine, editor, exporter and API. It must stay dependency-free apart from zod.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'scripts/**/*.ts', '**/vite.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
