// eslint-disable-next-line import/no-unresolved
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Make vitest globals like `describe` and `it` available without importing
    globals: true,
    // Look for test files in the entire project
    root: './',
  },
  plugins: [swc.vite()]
})
