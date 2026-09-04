import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'out/', 'coverage/'] },
  ...tseslint.configs.recommended,
);
