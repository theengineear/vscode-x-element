import NetflixCommon from '@netflix/eslint-config';
import globals from 'globals';

export default [
  {
    files: ["**/*.js"],
    rules: {
      ...NetflixCommon.rules,
    },
    linterOptions: { ...NetflixCommon.linterOptions },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      ecmaVersion: 2025,
      sourceType: "module",
    },
    ignores: ['ignore/**/*'],
  }
];
