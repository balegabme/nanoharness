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
    // The renderer is served over app://, whose handler refuses anything outside
    // out/renderer. A value import from ../core or ../ipc therefore 404s at
    // runtime and takes the whole page down with no error on screen. Types are
    // erased before that can happen, so they stay allowed.
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
                'The renderer may only load modules from src/renderer at runtime. Import the type, or move the value into the renderer.',
            },
          ],
        },
      ],
    },
  },
);
