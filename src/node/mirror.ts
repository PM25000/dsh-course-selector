/**
 * Panel-facing HTTP surface (P0.5): serves the CDP screencast mirror as a
 * low-frequency JPEG endpoint plus a JSON status endpoint, mounted on the dsh
 * webServer when available. Polling an image is deliberately simpler than a
 * websocket upgrade for the 2-3 fps observation posture of the side panel.
 * @module dsh-course-selector/mirror
 */
import type { ServerResponse } from 'node:http'
import fs from 'node:fs'
import type { BrowserManager } from './browser-manager.ts'
import { RatingClient, readRatingUrl, ratingUrlPath, readRatingDataUrl, ratingDataUrlPath } from './ratings.ts'
import { normalizeUrl, probeHeaders, embeddabilityOf } from './url-policy.ts'
import { getPlan } from './plans.ts'

type WebServerLike = {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: ServerResponse) => void | Promise<void>
  }) => () => void
}

function noStore(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

export function attachMirrorEndpoints(
  webServer: WebServerLike,
  manager: BrowserManager,
  openUrl: string,
  dataDir: string,
  ratingUrl: string,
  ratings: RatingClient,
  injectRatings: boolean,
): () => void {
  const disposers: (() => void)[] = []

  // Auto-inject rating badges whenever a course-selection page is up — even in
  // ANOTHER tab (首页点「自主选课」会新开标签，activePage 可能是旧菜单壳标签)。
  // 巡逻遍历所有标签：任一 URL 含 /xsxk/ 即用它作活动页并对它注入。
  if (injectRatings) {
    const base = (): string => readRatingUrl(dataDir, ratingUrl)
    const patrol = (): void => {
      void (async () => {
        let pages: Array<{ ordinal: number; url: string; active: boolean }> = []
        try { pages = await manager.listPages() } catch { return }
        const target = pages.find((p) => /\/xsxk\//.test(p.url))
        if (!target) return
        if (!target.active) {
          try { await manager.usePage(target.ordinal) } catch { return }
        }
        let map = ratings.map()
        if (Object.keys(map).length === 0) {
          try {
            const opts: { dataUrl?: string } = {}
            const dataUrl = readRatingDataUrl(dataDir)
            if (dataUrl !== '') opts.dataUrl = dataUrl
            await ratings.dataset(base(), opts)
            map = ratings.map()
          } catch {
            return
          }
        }
        if (Object.keys(map).length === 0) return
        try { await manager.injectRatings(map, ratings.hrefMap(base()), base()) } catch { /* page mid-flight */ }
      })()
    }
    const timer = setInterval(patrol, 3000)
    setTimeout(patrol, 1500)
    disposers.push(() => { clearInterval(timer) })
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/mirror.jpg',
    handler: async (_req, res) => {
      try {
        const { frame } = await manager.currentFrame() // screencast, screenshot fallback
        noStore(res)
        res.setHeader('Content-Type', 'image/jpeg')
        res.end(frame)
      } catch {
        res.statusCode = 404
        res.end('no frame yet')
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/plan',
    handler: async (_req, res) => {
      // Latest parsed course rows for the panel schedule view.
      writeJson(res, 200, getPlan())
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/probe',
    handler: async (req, res) => {
      // Raw-fetch probe (dev): status + type + first bytes, no shape checking —
      // used to discover the rating SPA's bulk JSON/API. Host-internal.
      const url = (req as { url?: string }).url ?? ''
      const target = new URL(url, 'http://x').searchParams.get('url') ?? ''
      const len = Math.min(Number(new URL(url, 'http://x').searchParams.get('len') ?? '400') || 400, 30000)
      if (!/^https?:\/\//i.test(target)) { writeJson(res, 400, { error: 'need http(s) url' }); return }
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        const resp = await fetch(target, { signal: controller.signal, headers: { 'User-Agent': 'dsh-course-selector/1', 'Accept': '*/*' } })
        clearTimeout(timer)
        const text = await resp.text()
        writeJson(res, 200, {
          ok: true,
          status: resp.status,
          contentType: resp.headers.get('content-type') ?? '',
          bytes: Buffer.byteLength(text),
          head: text.slice(0, len).replace(/\s+/g, ' '),
        })
      } catch (error) {
        writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/lookup',
    handler: async (req, res) => {
      // Demo: 实时去评分站按教师名查询（搜索框提交 → 读页面文本）。
      const url = (req as { url?: string }).url ?? ''
      const name = new URL(url, 'http://x').searchParams.get('name') ?? ''
      const base = readRatingUrl(dataDir, ratingUrl)
      try {
        await manager.open(base)
        const result = await manager.typeSubmitAndRead('#search-content', name)
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/status',
    handler: async (_req, res) => {
      await manager.startMirror()
      const s = manager.mirrorStatus()
      noStore(res)
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(s))
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/digest',
    handler: async (_req, res) => {
      // Traversal comparison digest (host-internal).
      try {
        noStore(res)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(await manager.digest()))
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/ratings',
    handler: async (req, res) => {
      // Teacher-rating dataset: GET 摘要（?refresh=1 强制；?data= 直连 JSON 数据源）。
      const raw = (req as { url?: string }).url ?? ''
      const q = new URL(raw, 'http://x').searchParams
      const refresh = q.get('refresh') === '1'
      const dataUrl = q.get('data') ?? readRatingDataUrl(dataDir)
      const base = readRatingUrl(dataDir, ratingUrl)
      try {
        const opts: { dataUrl?: string; force?: boolean } = { force: refresh }
        if (dataUrl !== '') opts.dataUrl = dataUrl
        const ds = await ratings.dataset(base, opts)
        writeJson(res, 200, {
          ok: true,
          count: ds.teachers.length,
          colleges: Array.isArray(ds.colleges) ? ds.colleges.length : 0,
          updatedAt: ds.updatedAt,
          source: ds.source,
          hot: ratings.top(5).map((t) => ({ name: t.name, rate: Number(t.rate) })),
        })
      } catch (error) {
        writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/inject',
    handler: async (req, res) => {
      // Inject ⭐ rating badges into the current grid page (demo/manual).
      // ?force=1 忽略已有注入标记；?diag=1 只返回网格诊断（不注入）。
      const raw = (req as { url?: string }).url ?? ''
      const q = new URL(raw, 'http://x').searchParams
      const force = q.get('force') === '1'
      const diag = q.get('diag') === '1'
      const base = readRatingUrl(dataDir, ratingUrl)
      try {
        const opts: { dataUrl?: string } = {}
        const dataUrl = readRatingDataUrl(dataDir)
        if (dataUrl !== '') opts.dataUrl = dataUrl
        await ratings.dataset(base, opts)
        const map = ratings.map()
        const result = diag ? { injected: 0 } : await manager.injectRatings(map, ratings.hrefMap(base), base, force)
        const gridDiag = await manager.gridDiag()
        writeJson(res, 200, { injected: result.injected, mapped: Object.keys(map).length, ...(result.namesCount !== undefined ? { namesCount: result.namesCount } : {}), ...(result.dbg ? { dbg: result.dbg } : {}), ...(result.stage1Error ? { stage1Error: result.stage1Error } : {}), ...(result.stage2 ? { stage2: result.stage2 } : {}), grid: gridDiag })
      } catch (error) {
        writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/rating-data-url',
    handler: async (req, res) => {
      // 评分数据 JSON 地址或本地文件路径（可选；留空=自动探测）。
      const raw = (req as { url?: string }).url ?? ''
      const method = (req as { method?: string }).method ?? 'GET'
      const parsed = new URL(raw, 'http://x')
      if (method === 'GET') {
        writeJson(res, 200, { url: readRatingDataUrl(dataDir) })
        return
      }
      const next = parsed.searchParams.get('url') ?? ''
      if (next.length > 512) {
        writeJson(res, 400, { error: '数据地址过长' })
        return
      }
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(ratingDataUrlPath(dataDir), JSON.stringify({ url: next }), 'utf8')
        writeJson(res, 200, { url: next, ok: true })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/crawl',
    handler: async (_req, res) => {
      // 全类别遍历（dev/手动）：逐门展开折叠课程读教学班并翻页，返回汇总摘要。
      try {
        const rows = await manager.crawlGrid()
        const total = rows.reduce((a, t) => a + t.rows.length, 0)
        const courses = [...new Set(rows.map((r) => r.course))].slice(0, 40)
        writeJson(res, 200, {
          ok: true,
          tables: rows.length,
          rows: total,
          courses,
          sample: rows[0] ? { course: rows[0].course, headers: rows[0].headers.slice(0, 5), first: (rows[0].rows[0] ?? []).slice(0, 5) } : null,
        })
      } catch (error) {
        writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/dim',
    handler: async (req, res) => {
      // Dev checkpoint: run the dimension-selection flow (跨类等类别前置面板).
      const url = (req as { url?: string }).url ?? ''
      const idx = Number(new URL(url, 'http://x').searchParams.get('idx') ?? '0')
      try {
        noStore(res)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(await manager.dimensionFlow(Number.isFinite(idx) ? idx : 0)))
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/click',
    handler: async (req, res) => {
      // Traversal helper: click a CSS selector in the current top frame,
      // mirroring the panel button's trust model (course-site only).
      const url = (req as { url?: string }).url ?? ''
      const sel = new URL(url, 'http://x').searchParams.get('sel') ?? ''
      try {
        noStore(res)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(await manager.clickSelector(sel)))
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/rating-url',
    handler: async (req, res) => {
      // Teacher-rating site URL (查老师/评分站)：GET 返回当前值，POST ?url= 持久化。
      // 保存时经 URL 规范化门控（拒循环地址/危险 scheme）。
      const raw = (req as { url?: string }).url ?? ''
      const method = (req as { method?: string }).method ?? 'GET'
      const parsed = new URL(raw, 'http://x')
      if (method === 'GET') {
        writeJson(res, 200, { url: readRatingUrl(dataDir, ratingUrl) })
        return
      }
      const next = parsed.searchParams.get('url') ?? ''
      const norm = normalizeUrl(next)
      if (norm.kind !== 'ok') {
        writeJson(res, 400, { error: '评分站地址需为合法 http(s) 网址' + (norm.kind === 'blocked' ? `（${norm.reason}）` : '') })
        return
      }
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(ratingUrlPath(dataDir), JSON.stringify({ url: norm.url }), 'utf8')
        writeJson(res, 200, { url: norm.url, ok: true })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/open-url',
    handler: async (req, res) => {
      // "打开评分站/任意站点": navigate after URL-policy gate (scheme/loopback).
      const raw = (req as { url?: string }).url ?? ''
      const target = new URL(raw, 'http://x').searchParams.get('url') ?? ''
      const norm = normalizeUrl(target)
      if (norm.kind !== 'ok') {
        writeJson(res, 400, { error: 'URL 需为合法 http(s) 网址' + (norm.kind === 'blocked' ? `（${norm.reason}）` : '') })
        return
      }
      try {
        const state = await manager.open(norm.url)
        writeJson(res, 200, state)
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/open-preview',
    handler: async (req, res) => {
      // C: 可达性/嵌入性探测——打开前给出状态/原因，替代裸 404/白屏。
      const raw = (req as { url?: string }).url ?? ''
      const target = new URL(raw, 'http://x').searchParams.get('url') ?? ''
      const norm = normalizeUrl(target)
      if (norm.kind !== 'ok') {
        writeJson(res, 400, { navigable: false, error: 'URL 需为合法 http(s) 网址' + (norm.kind === 'blocked' ? `（${norm.reason}）` : '') })
        return
      }
      try {
        const probe = await probeHeaders(norm.url)
        const embeddable = embeddabilityOf(probe)
        writeJson(res, 200, {
          navigable: probe.reachable,
          url: probe.url ?? norm.url,
          status: probe.status,
          xFrameOptions: probe.xFrameOptions,
          frameAncestors: probe.frameAncestors,
          embeddable,
          reason: !probe.reachable ? '站点不可达（网络/超时/反爬）' : embeddable === 'blocked' ? '站点设置禁止嵌入' : '可达',
        })
      } catch (error) {
        writeJson(res, 502, { navigable: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/open-search',
    handler: async (req, res) => {
      // 打开评分站并在其搜索框按教师名提交（站点 /search 裸 GET 是空壳，表单
      // 提交才出结果——typeSubmitAndRead 那段已验证有效）。供工具/面板用。
      const raw = (req as { url?: string }).url ?? ''
      const name = new URL(raw, 'http://x').searchParams.get('name') ?? ''
      if (name === '') { writeJson(res, 400, { error: '缺少 name' }); return }
      const base = readRatingUrl(dataDir, ratingUrl)
      try {
        await manager.open(base)
        const r = await manager.typeSubmitAndRead('#search-content', name)
        writeJson(res, 200, { url: r.url, matched: r.text.slice(0, 400) })
      } catch (error) {
        writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/open',
    handler: async (req, res) => {
      // 面板「打开选课系统/选课」：?force=1 显式跳到选课界面（即使已有页面）；
      // 否则仅当无活动页面才默认打开（已登录直达选课中心，否则 zdbk 根）。
      const q = new URL((req as { url?: string }).url ?? '', 'http://x').searchParams
      const force = q.get('force') === '1'
      const alive = manager.currentUrl()
      try {
        if (!force && alive !== '') {
          noStore(res)
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ url: alive, title: '', text: '（浏览器已有页面，不重复跳转）' }))
          return
        }
        // 学号只在 zdbk 外壳/选课页上下文可读；force 时若不在该上下文则先落
        // 根（已登录自动进菜单壳），再读学号直达选课中心。
        let su = await manager.readSu().catch(() => '')
        let target = su
          ? `${openUrl.replace(/\/+$/, '')}/jwglxt/xsxk/zzxkghb_cxZzxkGhbIndex.html?gnmkdm=N253530&layout=default&su=${encodeURIComponent(su)}`
          : openUrl
        const state = await manager.open(target)
        if (force && !su) {
          await manager.wait(900)
          su = await manager.readSu().catch(() => '')
          if (su) {
            await manager.open(`${openUrl.replace(/\/+$/, '')}/jwglxt/xsxk/zzxkghb_cxZzxkGhbIndex.html?gnmkdm=N253530&layout=default&su=${encodeURIComponent(su)}`)
          }
        }
        noStore(res)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ...state, defaultPage: su ? '选课中心' : 'zdbk 首页（需登录）' }))
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      }
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/course-selector/menu',
    handler: async (_req, res) => {
      // Adapter discovery: menu module ids + landing URLs (data-gnmkdm/dyym).
      try {
        const links = await manager.collectMenuLinks()
        noStore(res)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ count: links.length, links }))
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      }
    },
  }))
  return () => { for (const dispose of disposers) dispose() }
}