import { globalIgnores } from 'eslint/config'
import neostandard from 'neostandard'
import importPlugin, { createNodeResolver } from 'eslint-plugin-import-x'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'

export default [
  // since neostandard 0.14 its `ignores` only applies to its own layers, not to the import-plugin block below
  globalIgnores(['dist/**/*', 'types/**/*', 'docs/**/*']),

  // — your neostandard base —
  ...neostandard({
    ts: true
  }),

  // — add import-plugin + import-x/no-unresolved —
  {
    // target all JS/TS files
    files: ['**/*.{js,jsx,ts,tsx}'],

    // register the import plugin
    plugins: {
      'import-x': importPlugin
    },

    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver(),
        createNodeResolver()
      ]
    },

    rules: {
      // error on imports you can’t resolve to a file on disk
      'import-x/no-unresolved': ['error', {
        commonjs: true,       // also check require()
        caseSensitive: true,  // warn if file-system case doesn’t match
        // skip any import path matching these patterns:
        ignore: [
          '^vitest/.*$'
        ]
      }]
    }
  }
]
