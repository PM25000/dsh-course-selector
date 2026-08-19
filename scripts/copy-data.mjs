// Copy the bundled teacher-rating dataset into the tsdown output dir so the
// plugin is self-contained (lib/data/teachers.json). Source kept at data/.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const src = resolve(root, 'data', 'teachers.json')
const destDir = resolve(root, 'lib', 'data')
mkdirSync(destDir, { recursive: true })
cpSync(src, resolve(destDir, 'teachers.json'))
console.log('[dsh-course-selector] bundled dataset -> lib/data/teachers.json')