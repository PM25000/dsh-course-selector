/**
 * Teacher-rating client (查老师/评分站，参 Lazuli 思路): serves the bundled
 * offline dataset by default (built into the plugin at release), optionally
 * refreshed from a JSON URL/站点 when a newer source is reachable. Validates
 * relative the {colleges, teachers} shape, caches to disk with a TTL, and
 * answers teacher lookups by name.
 * @module dsh-course-selector/ratings
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RatingTeacher {
  id: string | number
  name: string
  rate: string | number
  hot?: unknown
  py?: string
  sx?: string
  xy?: string
}

export interface RatingDataset {
  colleges: unknown[]
  teachers: RatingTeacher[]
  updatedAt: number
  source: string
}

const RATING_FILE = 'rating-url.json'
const RATING_DATA_FILE = 'rating-data-url.json'
const CACHE_FILE = 'ratings-cache.json'

/** Bundled offline dataset (lib/data/teachers.json, copied at build). */
const BUILTIN_PATH = ((): string | null => {
  try {
    return fileURLToPath(new URL('data/teachers.json', import.meta.url))
  } catch {
    return null
  }
})()

export function ratingUrlPath(dataDir: string): string {
  return path.join(dataDir, RATING_FILE)
}

/** Persisted rating-site URL (panel-editable), falling back to the config default. */
export function readRatingUrl(dataDir: string, fallback: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(ratingUrlPath(dataDir), 'utf8')) as { url?: unknown }
    if (typeof raw.url === 'string' && /^https?:/i.test(raw.url)) return raw.url.trim()
  } catch {
    // first run
  }
  return fallback
}

export function ratingDataUrlPath(dataDir: string): string {
  return path.join(dataDir, RATING_DATA_FILE)
}

/** Optional explicit teacher-data JSON URL or local file path; '' = auto-probe. */
export function readRatingDataUrl(dataDir: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(ratingDataUrlPath(dataDir), 'utf8')) as { url?: unknown }
    if (typeof raw.url === 'string' && raw.url.trim() !== '') return raw.url.trim()
  } catch {
    // first run
  }
  return ''
}

const CANDIDATE_PATHS = [
  '',
  '/api/teachers.json', '/api/teacher.json', '/teachers.json', '/data.json',
  '/api/data.json', '/api/teacher', '/api/teachers', '/api/teacher_list',
  '/api/list', '/api/search', '/api/query', '/api/ratings.json',
  '/static/data.json', '/index.json', '/data/teacher.json', '/api/v1/teachers',
]

function candidateUrls(base: string, dataUrl: string): string[] {
  if (dataUrl !== '') {
    const b = dataUrl.replace(/\/+$/, '')
    return /\.json$/i.test(b) ? [b] : [b, b + '.json']
  }
  const b = base.replace(/\/+$/, '')
  if (/\.json$/i.test(b)) return [b]
  return [b, ...CANDIDATE_PATHS.filter((p) => p !== '').map((p) => b + p)]
}

function isValid(data: unknown): data is { colleges: unknown[]; teachers: RatingTeacher[] } {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return Array.isArray(d.colleges) && Array.isArray(d.teachers)
}

export class RatingClient {
  private inMemory?: RatingDataset

  constructor(private readonly dataDir: string, private readonly ttlMs: number) {}

  private cacheFile(): string {
    return path.join(this.dataDir, CACHE_FILE)
  }

  private loadCache(): RatingDataset | null {
    try {
      const stored = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')) as RatingDataset | null
      if (stored && isValid(stored) && typeof stored.updatedAt === 'number') return stored
    } catch {
      // no cache yet
    }
    return null
  }

  private saveCache(dataset: RatingDataset): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.cacheFile(), JSON.stringify(dataset), 'utf8')
    } catch {
      // best effort
    }
  }

  /** Load + validate one candidate, from http(s) or a local JSON file. */
  private async tryLoad(urlOrPath: string): Promise<RatingDataset | null> {
    let text: string
    try {
      if (/^https?:\/\//i.test(urlOrPath)) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 8000)
        try {
          const res = await fetch(urlOrPath, { signal: controller.signal, headers: { 'User-Agent': 'dsh-course-selector/1' } })
          if (!res.ok) return null
          text = await res.text()
        } finally {
          clearTimeout(timer)
        }
      } else {
        text = fs.readFileSync(urlOrPath, 'utf8')
      }
    } catch {
      return null
    }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return null
    }
    if (!isValid(data)) return null
    const dataset: RatingDataset = {
      colleges: data.colleges,
      teachers: data.teachers as RatingTeacher[],
      updatedAt: Date.now(),
      source: urlOrPath,
    }
    this.inMemory = dataset
    this.saveCache(dataset)
    return dataset
  }

  /** Current dataset, from memory → fresh disk cache → sources.
   *  Load order: bundled offline dataset (zero-config) first, then any explicit
   *  dataUrl, then automatic probing of the rating site. */
  async dataset(baseUrl: string, opts: { dataUrl?: string; force?: boolean } = {}): Promise<RatingDataset> {
    const force = opts.force === true
    if (!force && this.inMemory) return this.inMemory
    if (!force) {
      const cached = this.loadCache()
      if (cached && Date.now() - cached.updatedAt < this.ttlMs) {
        this.inMemory = cached
        return cached
      }
    }
    const urls: string[] = []
    if (typeof BUILTIN_PATH === 'string') urls.push(BUILTIN_PATH)
    urls.push(...candidateUrls(baseUrl, opts.dataUrl ?? ''))
    for (const url of urls) {
      const hit = await this.tryLoad(url)
      if (hit) return hit
    }
    throw new Error('评分数据不可用（内置数据集缺失且在线拉取失败）')
  }

  teacher(name: string): RatingTeacher | undefined {
    return this.inMemory?.teachers.find((t) => t.name === name)
  }

  /** Name contains `q` (case-insensitive), best matches first, capped. */
  search(q: string): RatingTeacher[] {
    const needle = q.trim().toLowerCase()
    if (needle === '') return []
    return (this.inMemory?.teachers ?? [])
      .filter((t) => t.name.toLowerCase().includes(needle))
      .slice(0, 20)
  }

  /** Top-rated teachers (for the rating query tool, no args). */
  top(n = 10): RatingTeacher[] {
    return (this.inMemory?.teachers ?? [])
      .map((t) => ({ ...t, rate: Number(t.rate) }))
      .filter((t) => Number.isFinite(t.rate as number) && (t.rate as number) > 0)
      .sort((a, b) => (b.rate as number) - (a.rate as number))
      .slice(0, n)
  }

  /** teacherName → rate map for page badge injection. */
  map(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const t of this.inMemory?.teachers ?? []) {
      if (t.rate !== undefined && t.rate !== '') out[t.name] = String(t.rate)
    }
    return out
  }

  /** teacherName → 评分站教师页 URL（`<base>/t/<id>/`），用于 ⭐ 徽章加超链接；
   *  仅含带 id 的教师。 */
  hrefMap(base: string): Record<string, string> {
    const b = base.replace(/\/+$/, '')
    const out: Record<string, string> = {}
    for (const t of this.inMemory?.teachers ?? []) {
      if (t.id !== undefined && t.id !== '') out[t.name] = `${b}/t/${encodeURIComponent(String(t.id))}/`
    }
    return out
  }
}