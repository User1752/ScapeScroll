'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Flat-config replacement for the old .eslintrc.cjs (ESLint 9 deprecated
// eslintrc, 10 removed it). Same scope and rules as before — which files get
// linted is still decided by the glob args in package.json's lint/lint:fix
// scripts, not here. Mapping from the old format:
//   extends: ["eslint:recommended"]  -> js.configs.recommended
//   env: { node: true }              -> languageOptions.globals.node
//   parserOptions                    -> languageOptions
//   ignorePatterns                   -> a standalone { ignores } block
// No `root: true` equivalent needed: flat config doesn't search parent
// directories for other config files the way .eslintrc did.
module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      // The server, the tools and the tests are CommonJS modules: a top-level `const crypto = require('crypto')` is local to its file, not a
      // redeclaration of Node's global `crypto` (which is what 'script' made ESLint believe).
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ESLint 10's recommended config checks caught-error bindings by
      // default (ESLint 8's didn't) — the codebase's existing catch (_) {}
      // convention for "deliberately ignored error" (also why no-empty
      // above allows an empty catch body) needs an explicit exemption to
      // keep working instead of flagging every one of those as unused.
      'no-unused-vars': ['error', {
        caughtErrorsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // `const { secret, ...safe } = obj` is how a key is left out of a copy: the key is unused on purpose.
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // tools/flaresolverr is the third-party FlareSolverr build (Selenium scripts run inside a browser page), not our code.
    ignores: ['dist/**', 'data/**', 'public/**', 'tools/node/**', 'tools/flaresolverr/**', 'tools/pkg-cache/**', 'tools/npm-cache/**', 'node_modules/**', '.claude/**'],
  },
];
