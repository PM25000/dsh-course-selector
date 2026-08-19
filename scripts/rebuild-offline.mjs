// Rebuild the offline teacher-rating dataset from the live 查老师 (评分站) site.
//
// 发布前跑一次：遍历 `/t/<id>/`（站内教师页），解析 <title>（含 评分+打分人数），
// 产出与内置 `data/teachers.json` 同构的 `{colleges, teachers:[{id,name,rate,...}]}`，
// 这样页面 ⭐/★无评分 与 ⭐ 链接都会被最新（含 id/分数）数据修正。
//
// 用法：
//   node scripts/rebuild-offline.mjs --base https://dahua309.uk \
//       --out data/teachers.json --max 12000 --interval 120 --from-id 1
// 选项：
//   --base      评分站根（缺省读面板已保存的 rating-url，否则 https://dahua309.uk）
//   --out       输出 JSON 路径（缺省 data/teachers.json）
//   --max       遍历的 id 上限（缺省 12000）
//   --from-id   起始 id（断点续爬用）
//   --interval  每个请求间隔毫秒（尊重站点，缺省 120）
//   --progress  进度文件（缺省 dataDir/rebuild-progress.json）
// Ctrl-C 中断后重跑同命令即可从断点继续（`--from-id` 已记，重跑读进度）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const arg = (key, dflt) => {
  const i = process.argv.indexOf('--' + key)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const BASE = (arg('base', '').replace(/\/+$/, '') )
const DEFAULT_DATA_DIR = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '.', '.dsh'), 'data', 'course-selector')
function savedRatingUrl() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA_DIR, 'rating-url.json'), 'utf8'))
    if (typeof raw.url === 'string' && /^https?:/i.test(raw.url)) return raw.url.replace(/\/+$/, '')
  } catch { /* ignore */ }
  return ''
}
const base = BASE || savedRatingUrl() || 'https://dahua309.uk'
const outFile = path.resolve(root, arg('out', 'data/teachers.json'))
const maxId = Number(arg('max', '12000'))
const fromIdDefault = Number(arg('from-id', '1'))
const interval = Number(arg('interval', '120'))
const progressFile = path.resolve(arg('progress', path.join(DEFAULT_DATA_DIR, 'rebuild-progress.json')))

/** 解析表单标题：`周黎明老师 9.99分 1571人打分 - 查老师` → {name,rate,count} */
export function parseTeacherTitle(title) {
  if (!title) return null
  const m = /(.+?)老师[^0-9]*([\d.]+)\s*分(?:\s*(\d+)\s*人打分)?/.exec(title.trim())
  if (!m) return null
  return { name: m[1].trim(), rate: m[2], count: m[3] ? Number(m[3]) : undefined }
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(progressFile, 'utf8')) } catch { return { lastId: 0, collected: {} } }
}
function saveProgress(p) {
  fs.mkdirSync(path.dirname(progressFile), { recursive: true })
  fs.writeFileSync(progressFile, JSON.stringify(p), 'utf8')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const prog = loadProgress()
  const collected = prog.collected || {}
  const fromId = Math.max(fromIdDefault, Number(prog.lastId || 0) + 1)
  console.log(`重建离线数据：base=${base} 范围=${fromId}..${maxId} 已有=${Object.keys(collected).length} 间隔=${interval}ms`)
  let scanned = 0
  for (let id = fromId; id <= maxId; id++) {
    scanned++
    let ok = false
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(`${base}/t/${id}/`, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'dsh-course-selector/rebuild/1' } })
      clearTimeout(t)
      if (res.status === 404) continue
      if (!res.ok) { if (res.status >= 500) { console.error(`  服务器错 ${id} (${res.status})`); break } continue }
      const html = await res.text()
      const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]
      const parsed = parseTeacherTitle(title ?? '')
      if (parsed) {
        collected[String(id)] = { id, name: parsed.name, rate: parsed.rate }
        if (parsed.count !== undefined) collected[String(id)].rateCount = parsed.count
        ok = true
      }
    } catch (e) {
      console.error(`  ${id} 请求异常: ${e?.message || e}`)
    }
    if (scanned % 50 === 0 || ok) {
      saveProgress({ lastId: id, collected })
    }
    await sleep(interval)
  }
  // 产出 colleges + teachers
  const teachers = Object.values(collected).map((v) => ({ id: String(v.id), name: v.name, rate: v.rate, ...(v.rateCount ? { rateCount: v.rateCount } : {}) }))
  const out = { colleges: [], teachers, updatedAt: Date.now(), source: base }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out), 'utf8')
  saveProgress({ lastId: maxId, collected })
  console.log(`完成：扫描 ${scanned}，收集教师 ${teachers.length} → ${outFile}`)
  console.log('样例：', JSON.stringify(teachers.slice(0, 5), null, 0))
}

main().catch((e) => { console.error(e); process.exit(1) })