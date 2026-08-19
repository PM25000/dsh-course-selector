// Bundle the Node host half into a single ESM file consumed by the dsh plugin
// loader. All harness packages (@deepseek-ai/*) and playwright stay external —
// the running dsh provides them at load time.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/node/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*', 'playwright'],
  sourcemap: false,
  logLevel: 'info',
})