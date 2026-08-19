// Build the browser half into a single IIFE consumed by the dsh web client
// loader (/plugins/<id>/client.js). Run after `pnpm install`.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'lib/client.js',
  external: ['react', 'react-dom'], // provided by the dsh web shell
  sourcemap: false,
  logLevel: 'info',
})