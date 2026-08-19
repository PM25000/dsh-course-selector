// dsh-course-selector build: node ESM (lib/index.js) + browser CJS factory
// (lib/client.js) that registers via window.__ModuleLoader__.load. Adapted
// from the working dsh-ths-holdings template (see dsh-ths-holdings-开发经验.md).
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-course-selector'

/** Platform modules the loader table provides — keep external in the client bundle. */
const PLATFORM_MODULES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots/client',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-ui-layout/client',
  'react',
]

const config: UserConfig[] = [
  // ── Node half ──
  {
    name: PACKAGE_NAME,
    entry: { index: 'src/node/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: { outputDir: 'lib/types' },
    clean: false,
  },
  // ── Browser client bundle ──
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: false,
    external: PLATFORM_MODULES,
    noExternal: (id: string) => (PLATFORM_MODULES.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]

export default config