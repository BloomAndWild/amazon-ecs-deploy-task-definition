const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['dist/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2018,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
        Atomics: 'readonly',
        SharedArrayBuffer: 'readonly',
      },
    },
    rules: {},
  },
];
