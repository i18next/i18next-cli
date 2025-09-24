import terser from '@rollup/plugin-terser'
import typescript from 'rollup-plugin-typescript2'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url)))

export default {
  input: 'src/index.ts', // our source file
  output: [
    {
      dir: 'dist/cjs',
      preserveModules: true,
      // file: pkg.main,
      format: 'cjs'
    },
    {
      dir: 'dist/esm',
      preserveModules: true,
      // file: pkg.module,
      format: 'es' // the preferred format
    },
    // {
    //   file: pkg.browser,
    //   format: 'iife',
    //   name: pkg.globalName // the global which can be used in a browser
    // }
  ],
  external: [
    ...Object.keys(pkg.dependencies || {})
  ],
  plugins: [
    typescript(),
    terser() // minifies generated bundles
  ]
}
