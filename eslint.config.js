import globals from 'globals';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    // public/sw-message-normalize.js is a generated Vite bundle (see
    // scripts/build-sw-normalize.mjs), not hand-written source — don't lint it.
    // vite.config.js.timestamp-*.mjs is a transient bundle Vite writes while
    // loading the config. It normally gets deleted, but a crashed or killed
    // process can leave one behind and it should never be linted.
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/**',
      'public/sw-message-normalize.js',
      'vite.config.js.timestamp-*.mjs',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...prettier.rules,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      ...prettier.rules,
      // Allow underscore-prefixed unused vars (common convention for intentionally unused params)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Disable no-redeclare - TypeScript handles function overloads
      'no-redeclare': 'off',
    },
  },
  {
    // Worker files need additional globals
    files: ['**/workers/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
        IDBTransactionMode: 'readonly',
      },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    files: ['tests/**/*.{js,mjs,cjs,ts,tsx,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        vi: 'readonly',
      },
    },
  },
  {
    // E2E harnesses use Vitest (imports describe/it/expect explicitly) plus
    // the `webdriverio` package, which augments the ambient `WebdriverIO`
    // namespace (e.g. `WebdriverIO.Browser`, `WebdriverIO.Capabilities`).
    // TS resolves those correctly via the package's ambient declarations,
    // but ESLint's no-undef can't see TS-only namespaces — disable it here
    // (typescript-eslint's official recommendation for TS files).
    files: ['e2e-webview/**/*.ts', 'e2e-mobile/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'off',
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.svelte'],
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      svelte,
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...svelte.configs['flat/recommended'].rules,
      ...svelte.configs['flat/prettier'].rules,
    },
  },
];
