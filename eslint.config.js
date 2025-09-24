import neostandard from 'neostandard'
import importPlugin from 'eslint-plugin-import'

export default [
  // — your neostandard base —
  ...neostandard({
    ts: true,
    ignores: ['dist/**/*', 'types/**/*', 'docs/**/*']
  }),

  // — add import-plugin + import/no-unresolved —
  {
    // target all JS/TS files
    files: ['**/*.{js,jsx,ts,tsx}'],

    // register the import plugin
    plugins: {
      import: importPlugin
    },

    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'], // any extensions you use
          moduleDirectory: ['node_modules'] // adjust if you alias
        }
        // If you use webpack or TypeScript paths, you can swap in those resolvers here
      }
    },

    rules: {
      // error on imports you can’t resolve to a file on disk
      'import/no-unresolved': ['error', {
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
