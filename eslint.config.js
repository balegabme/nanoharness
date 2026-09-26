import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'out/', 'coverage/', '.claude/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The icon rasteriser is a CommonJS entry on purpose: Electron only reaches
    // `ready` for an ES-module entry when that entry is the app's `main`, and
    // that script is passed to Electron as a path. See scripts/brand-icons.cjs.
    files: ['scripts/**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // The renderer is served over app://, whose handler refuses anything outside
    // out/renderer and out/shared. A value import from ../core or ../ipc
    // therefore 404s at runtime and takes the whole page down with no error on
    // screen. Types are erased before that can happen, so they stay allowed.
    files: ['src/renderer/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../core/*', '../ipc/*', '../main/*', '../tools/*', '../providers/*', '../cli/*'],
              allowTypeImports: true,
              message:
                'The renderer may only load modules from src/renderer and src/shared at runtime. Import the type, or move the value into src/shared.',
            },
          ],
        },
      ],
    },
  },
  {
    // src/shared is loaded by the window as well as by Node, so it stays pure:
    // no Node module, and no value from a directory the window cannot reach.
    files: ['src/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*'],
              allowTypeImports: true,
              message: 'src/shared may only load modules from src/shared at runtime. Import the type instead.',
            },
            {
              group: ['node:*', 'electron'],
              message: 'src/shared runs in the window too, where Node and Electron do not exist.',
            },
          ],
        },
      ],
    },
  },
);
