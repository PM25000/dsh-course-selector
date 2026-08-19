// Merge a freshly rebuilt offline dataset (new, from the live 查老师 site) with
// the legacy Lazuli dump so that: 新数据优先（同名/同 id 用新的），旧数据只补缺口
// （历史下架教师仍可查评分）。按 姓名 对齐——新爬只有现存教师带 id，历史教师走旧库。
//
// 用法：
//   node scripts/merge-teachers.mjs --new data/teachers.json \
//       --old ../Lazuli/data/default.json --out data/teachers.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const arg = (key, dflt) => {
  const i = process.argv.indexOf('--' + key)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const newFile = path.resolve(arg('new', 'data/teachers.json'))
const oldFile = path.resolve(arg('old', 'G:/deepseek-harness/Lazuli/data/default.json'))
const outFile = path.resolve(arg('out', 'data/teachers.json'))

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { console.error('读取失败:', f, e.message); process.exit(1) } }
const norm = (s) => String(s || '').trim()

function main() {
  const fresh = read(newFile)
  const legacy = read(oldFile)
  const freshTeachers = Array.isArray(fresh.teachers) ? fresh.teachers : []
  const legacyTeachers = Array.isArray(legacy.teachers) ? legacy.teachers : []

  // 新优先：姓名集合 + 输出先放新的
  const seen = new Set(freshTeachers.map((t) => norm(t.name)))
  const out = freshTeachers.map((t) => ({ ...pick(t), _fresh: true }))

  let added = 0
  for (const t of legacyTeachers) {
    const name = norm(t.name)
    if (!name) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ ...pick(t) })
    added++
  }

  // colleges：旧数据更全，取旧为主（按 name 去重并集）
  const colleges = unionColleges(legacy.colleges, fresh.colleges)

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const result = {
    colleges,
    teachers: out.map((t) => { const c = { ...t }; delete c._fresh; return c }),
    updatedAt: Date.now(),
    source: 'merged: ' + (fresh.source || 'new') + ' + legacy',
  }
  fs.writeFileSync(outFile, JSON.stringify(result), 'utf8')
  console.log(`合并完成：新 ${freshTeachers.length} + 补旧 ${added} = 共 ${out.length}`)
  console.log(`输出：${outFile}`)
  console.log('样例（新优先）：', JSON.stringify(out.slice(0, 3).map((t) => ({ name: t.name, rate: t.rate, id: t.id, rateCount: t.rateCount })), null, 0))
}

function pick(t) {
  const o = {}
  if (t.id !== undefined) o.id = t.id
  if (t.name !== undefined) o.name = t.name
  if (t.rate !== undefined) o.rate = t.rate
  if (t.rateCount !== undefined) o.rateCount = t.rateCount
  if (t.hot !== undefined) o.hot = t.hot
  return o
}

function unionColleges(a, b) {
  const out = []
  const seen = new Set()
  for (const c of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!c || !c.name) continue
    const key = String(c.id ?? '') + '\u0000' + norm(c.name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: c.id, name: c.name })
  }
  return out
}

main()