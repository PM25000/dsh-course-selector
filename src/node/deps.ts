/**
 * Playwright dependency resolution with reuse fallback (ported from
 * anweat/dsh-browser): plugin-local node_modules first, then the global npm
 * root. The chromium binary itself lives in Playwright's shared cache
 * (%LOCALAPPDATA%\ms-playwright) and is never re-downloaded by this plugin.
 * @module dsh-course-selector/deps
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

function globalNpmRoot(): string {
  try {
    return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
  } catch {
    return path.join(process.env.APPDATA ?? '', 'npm', 'node_modules')
  }
}

function resolvePkgJson(name: string): string {
  const anchors = [
    path.join(PLUGIN_ROOT, 'package.json'),
    path.join(globalNpmRoot(), name, 'package.json'),
  ]
  for (const anchor of anchors) {
    const req = createRequire(anchor)
    try { return req.resolve(name + '/package.json') } catch { /* exports-restricted */ }
    try {
      const entry = req.resolve(name)
      let dir = path.dirname(entry)
      for (let i = 0; i < 20; i++) {
        const pj = path.join(dir, 'package.json')
        if (fs.existsSync(pj)) return pj
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* not found at this anchor */ }
  }
  throw new Error('dsh-course-selector: playwright not found in plugin node_modules or global npm. Run `pnpm install` in the plugin directory (or install playwright globally).')
}

let cachedPlaywright: unknown
/** Resolve the playwright module (plugin-local, then global reuse). */
export function loadPlaywright(): unknown {
  if (cachedPlaywright) return cachedPlaywright
  cachedPlaywright = createRequire(resolvePkgJson('playwright'))('playwright') as unknown
  return cachedPlaywright
}