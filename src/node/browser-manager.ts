/**
 * Local browser provider (P0): one persistent Chromium context per plugin,
 * driven synchronously through a single page. Snapshot follows the
 * Lum1104-style numbered protocol (items carry index + css selector), masked
 * forms, budget truncation. Screencast mirroring lands in P0.5; the panel
 * observes via tool returns for now.
 * @module dsh-course-selector/browser-manager
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadPlaywright } from './deps.ts'
import type { ResolvedConfig } from './config.ts'

export interface SnapshotItem {
  index: number
  frame: number
  tag: string
  text: string
  selector: string
  kind: 'link' | 'button' | 'input' | 'select' | 'textarea' | 'other'
  href?: string
  attrs?: string
}
export interface SnapshotFormField {
  index: number
  frame: number
  selector: string
  required: boolean
  masked: boolean
}
export interface SnapshotResult {
  url: string
  title: string
  ready: 'complete' | 'loading'
  text: string
  items: SnapshotItem[]
  forms: SnapshotFormField[]
  truncated: { textChars: number; droppedItems: number }
}
export interface InteractiveState {
  url: string
  title: string
  text: string
  screenshotPath?: string
}

/** A resolved snapshot reference: the 0-based frame ordinal + selector inside it. */
export interface ElementRef {
  frame: number
  selector: string
}

interface PageLike {
  url: () => string
  isClosed: () => boolean
  setDefaultTimeout: (ms: number) => void
  waitForTimeout: (ms: number) => Promise<unknown>
  evaluate: (fn: string) => Promise<Record<string, unknown>>
  goto: (u: string, o: { waitUntil: string; timeout: number }) => Promise<unknown>
  waitForLoadState: (s: string, o: { timeout: number }) => Promise<unknown>
  click: (s: string, o: { timeout: number }) => Promise<unknown>
  fill: (s: string, t: string) => Promise<unknown>
  screenshot: (o: { path?: string; fullPage: boolean; type?: 'png' | 'jpeg'; quality?: number }) => Promise<unknown>
  frames: () => unknown[]
}

/** Minimal frame surface (Playwright Frame) used for cross-iframe targeting.
 *  Frames have no isClosed; detached frames surface through throwing calls. */
interface FrameLike {
  url: () => string
  click: (s: string, o: { timeout: number; force?: boolean }) => Promise<unknown>
  fill: (s: string, t: string) => Promise<unknown>
}

/** Frame + evaluate used by the per-frame extractor walk. */
type FrameEval = FrameLike & { evaluate: (fn: string) => Promise<Record<string, unknown>> }

/** 语义化教学班行（DOM 语义读，表型无关）。 */
export interface RowSem {
  teacher: string
  time: string
  location: string
  rest: number | null
  pend: number | null
  raw?: string
}

function uid(): string {
  return crypto.randomUUID()
}

/** Single-frame page-side extractor: numbered inventory + masked forms + main
 *  text, scoped to ONE frame's document. The manager iterates `page.frames()`
 *  (Playwright frame order) and tags each item with its frame ordinal, so the
 *  numbering matches the frames used for cross-iframe clicks. Raw string. */
const FRAME_EXTRACTOR = `(budgetChars, maxItems) => {
  const isVisible = (el) => {
    if (el.offsetParent !== null) return true
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const cssPath = (el) => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase()
      if (node.id) { part += '#' + node.id }
      else if (node.getAttribute && node.getAttribute('name')) { part += '[name=' + node.getAttribute('name') + ']' }
      else {
        const parent = node.parentElement
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName)
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
        }
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [contenteditable]'
  const items = []
  const forms = []
  const nodes = Array.from(document.querySelectorAll(SEL)).filter(isVisible)
  for (let i = 0; i < nodes.length && i < maxItems; i++) {
    const el = nodes[i]
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const type = el.getAttribute && el.getAttribute('type') || 'text'
      const sensitive = type === 'password' || /(password|passwd|credit|card|cvv|cvc|secret|pwd)/i.test(
        [el.id, el.name, el.getAttribute && el.getAttribute('aria-label')].filter(Boolean).join(' '))
      forms.push({ selector: cssPath(el), required: el.required === true, masked: sensitive })
    } else {
      const kind = tag === 'a' ? 'link' : (tag === 'button' || (el.getAttribute && el.getAttribute('role') === 'button') ? 'button' : 'other')
      const href = kind === 'link' && el.getAttribute ? (el.getAttribute('href') || '') : ''
      const attrs = []
      if (el.attributes) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name !== 'href' && attr.name !== 'onclick' && (attr.value || '') !== '') attrs.push(attr.name + '="' + String(attr.value).slice(0, 60) + '"')
        }
      }
      // Card-style menu items name themselves on an ancestor [data-gnmkmc];
      // surface that name/landing URL onto the anchor so items are clickable.
      let text = textOf(el)
      const card = el.closest && el.closest('[data-gnmkmc]')
      if (card) {
        const name = card.getAttribute('data-gnmkmc') || ''
        if (name && !text) text = name
        const dyym = card.getAttribute('data-dyym') || ''
        if (dyym) attrs.push('data-dyym="' + dyym.slice(0, 60) + '"')
      }
      items.push({
        tag,
        text,
        selector: cssPath(el),
        kind,
        href,
        attrs: attrs.join(' ').slice(0, 200),
      })
    }
  }
  const main = document.querySelector('article, main, [role="main"]') || document.body
  return {
    title: document.title || '',
    ready: document.readyState,
    text: (main.innerText || main.textContent || '').trim().replace(/\\n{3,}/g, '\\n\\n'),
    items,
    forms,
    droppedItems: Math.max(0, nodes.length - maxItems),
  }
}`

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n(内容已截断至 ' + maxChars + ' 字符)'
}

/** Playwright errors that mean the browser/page died under us (user closed the window). */
const CLOSED_TARGET_RE = /(closed|destroyed|detached|browser has been closed|execution context was destroyed)/i

export class BrowserManager {
  private context: unknown
  private activePage: PageLike | undefined
  /** Explicit user-selected page (browser_use_page); wins over heuristics. */
  private pinnedPage: PageLike | undefined
  private lastItems = new Map<number, ElementRef>()
  private lastTitle = ''
  private cdp: CdpSessionLike | undefined
  private mirrorPage: unknown
  private latestFrame: Buffer | undefined
  private frameTs = 0
  private lastPoll = 0
  private idleTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly config: ResolvedConfig) {}

  /** Resolve a tool ref: bare snapshot index → cached {frame, selector}, else a top-frame CSS selector. */
  resolveRef(ref: string): ElementRef {
    const trimmed = ref.trim()
    if (/^\d+$/.test(trimmed)) {
      const cached = this.lastItems.get(Number(trimmed))
      if (cached) return cached
      throw new Error('browser: 快照编号 ' + trimmed + ' 已失效，请重新 browser_snapshot')
    }
    return { frame: 0, selector: ref }
  }

  available(): boolean {
    return true
  }

  engine(): string {
    return this.config.engine
  }

  private detectChannel(): string | undefined {
    // Playwright channel browsers by OS: Windows uses Program Files install
    // paths; macOS uses standard /Applications app-bundle executables.
    const candidates = process.platform === 'darwin'
      ? [
          ['msedge', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']],
          ['chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']],
          ['chromium', ['/Applications/Chromium.app/Contents/MacOS/Chromium']],
        ] as [string, string[]][]
      : (() => {
          const env = process.env
          const pf = env['ProgramFiles'] ?? 'C:\\Program Files'
          const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
          return [
            ['msedge', [pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe', pf + '\\Microsoft\\Edge\\Application\\msedge.exe']],
            ['chrome', [pf86 + '\\Google\\Chrome\\Application\\chrome.exe', pf + '\\Google\\Chrome\\Application\\chrome.exe']],
          ] as [string, string[]][]
        })()
    for (const [channel, paths] of candidates) {
      for (const p of paths) if (fs.existsSync(p)) return channel
    }
    return undefined
  }

  private async ensureContext(): Promise<unknown> {
    if (this.context) {
      // The user may have closed the browser window by hand: the persistent
      // context object is then dead. Probe cheaply and relaunch on failure.
      try {
        const probe = this.context as unknown as { pages?: () => unknown[] }
        if (typeof probe.pages !== 'function') throw new Error('stale context')
        void probe.pages()
        return this.context
      } catch {
        this.context = undefined
      }
    }
    const pw = loadPlaywright() as unknown as {
      chromium: {
        launchPersistentContext: (dir: string, opts: Record<string, unknown>) => Promise<unknown>
      }
    }
    fs.mkdirSync(this.config.userDataDir, { recursive: true })
    const channel = this.config.engine === 'chromium' ? undefined : this.detectChannel()
    const headless = this.config.windowVisibility === 'headless'
    const args: string[] = []
    if (this.config.windowVisibility === 'hidden') {
      args.push('--window-position=-32000,-32000', '--window-size=1280,800', '--start-minimized')
    }
    this.context = await pw.chromium.launchPersistentContext(this.config.userDataDir, {
      channel,
      headless,
      args,
      viewport: { width: 1280, height: 900 },
    })
    this.settleStartupPages()
    return this.context
  }

  /** 收敛持久化 profile 恢复出来的历史标签：同一 URL 只保留一个、about:blank 只
   *  留一个、活动页总是保留——避免每次重启/多次打开堆一大把标签。 */
  private settleStartupPages(): void {
    try {
      const pages = (this.context as unknown as { pages: () => unknown[] }).pages() as unknown as PageLike[]
      if (pages.length <= 1) return
      const byUrl = new Map<string, PageLike>()
      let blankKept: PageLike | undefined
      for (const p of pages) {
        if (p.isClosed()) continue
        if (p === this.activePage) { byUrl.set(p.url() || 'act', p); continue }
        const u = p.url()
        if (u === '' || u === 'about:blank') {
          if (!blankKept) blankKept = p
          else { try { (p as unknown as { close?: () => Promise<unknown> }).close?.() } catch { /* ignore */ } }
          continue
        }
        const existing = byUrl.get(u)
        if (existing && !existing.isClosed()) { try { (p as unknown as { close?: () => Promise<unknown> }).close?.() } catch { /* ignore */ } }
        else byUrl.set(u, p)
      }
    } catch { /* tolerate: pages may still be loading / no permission */ }
  }

  private async ensurePage(): Promise<PageLike> {
    const ctx = (await this.ensureContext()) as unknown as { pages: () => unknown[]; newPage: () => Promise<unknown> }
    const pages = ctx.pages() as unknown as PageLike[]
    const live = pages.filter((p) => !p.isClosed())
    // An explicitly pinned page wins over every heuristic until it closes.
    if (this.pinnedPage && !live.includes(this.pinnedPage)) this.pinnedPage = undefined
    if (this.pinnedPage) {
      this.activePage = this.pinnedPage
      return this.pinnedPage
    }
    // Prefer a MODULE page (any real page that is not the menu shell or the
    // login screen): module links open new tabs, and the course workflow
    // always targets module pages. Falls back to the current page, then the
    // first live page.
    const isShell = (u: string): boolean => /init_menu|login_slogin|about:blank/.test(u)
    const modulePage = live.find((p) => !isShell(p.url()))
    const current = this.activePage
    if (current && !current.isClosed()) {
      if (modulePage !== undefined && modulePage !== current && isShell(current.url())) {
        this.activePage = modulePage
        return modulePage
      }
      return current
    }
    this.activePage = undefined
    if (modulePage !== undefined) {
      this.activePage = modulePage
      return modulePage
    }
    const first = live[0]
    if (first !== undefined) {
      this.activePage = first
      return first
    }
    this.activePage = await ctx.newPage() as PageLike
    return this.activePage
  }

  /** Live pages with a stable ordinal + URL/title (browser_tabs). */
  async listPages(): Promise<Array<{ ordinal: number; url: string; title: string; active: boolean }>> {
    const ctx = (await this.ensureContext()) as unknown as { pages: () => unknown[] }
    const pages = (ctx.pages() as unknown as PageLike[]).filter((p) => !p.isClosed())
    const out: Array<{ ordinal: number; url: string; title: string; active: boolean }> = []
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!
      let title = ''
      try {
        const f = (p.frames() as unknown as FrameEval[])[0]
        if (f) title = await f.evaluate(`(() => document.title || '')()`) as unknown as string
      } catch {
        title = ''
      }
      out.push({ ordinal: i, url: p.url(), title: title ?? '', active: this.activePage === p })
    }
    return out
  }

  /** Pin a specific live tab as the command target (browser_use_page). */
  async usePage(ordinal: number): Promise<{ ok: boolean; url?: string }> {
    const ctx = (await this.ensureContext()) as unknown as { pages: () => unknown[] }
    const pages = (ctx.pages() as unknown as PageLike[]).filter((p) => !p.isClosed())
    const page = pages[ordinal]
    if (!page) return { ok: false }
    this.pinnedPage = page
    this.activePage = page
    return { ok: true, url: page.url() }
  }

  private async extract(page: PageLike, includeScreenshot: boolean): Promise<InteractiveState> {
    const data = await this.readSnapshot(page)
    this.lastTitle = data.title
    const state: InteractiveState = {
      url: page.url(),
      title: this.lastTitle,
      text: data.text,
    }
    if (includeScreenshot) state.screenshotPath = await this.captureScreenshot(page)
    return state
  }

  /** Walk every Playwright frame in order; numbering matches `page.frames()`. */
  private async readSnapshot(page: PageLike): Promise<SnapshotResult> {
    const frameList = page.frames() as unknown as FrameEval[]
    const perFrameBudget = Math.max(1200, Math.floor(this.config.snapshotMaxChars / Math.max(1, frameList.length)))
    let counter = 0
    let dropped = 0
    const items: SnapshotItem[] = []
    const forms: SnapshotFormField[] = []
    const texts: string[] = []
    let title = ''
    let readyState: 'complete' | 'loading' = 'loading'
    for (let i = 0; i < frameList.length; i++) {
      const frame = frameList[i]
      if (!frame) continue
      let data: Record<string, unknown>
      try {
        data = await frame.evaluate('(' + FRAME_EXTRACTOR + ')(' + perFrameBudget + ',' + Math.max(0, this.config.snapshotMaxItems - counter) + ')')
      } catch {
        continue // cross-origin or mid-navigation frame
      }
      if (i === 0) {
        title = String(data['title'] ?? '')
        this.lastTitle = title
        readyState = data['ready'] === 'complete' ? 'complete' : 'loading'
      }
      for (const raw of (data['items'] ?? []) as Array<Omit<SnapshotItem, 'index' | 'frame'>>) {
        if (counter >= this.config.snapshotMaxItems) { dropped++; break }
        items.push({ ...raw, index: counter + 1, frame: i })
        counter++
      }
      for (const raw of (data['forms'] ?? []) as Array<Omit<SnapshotFormField, 'index' | 'frame'>>) {
        if (counter >= this.config.snapshotMaxItems) { dropped++; break }
        forms.push({ ...raw, index: counter + 1, frame: i })
        counter++
      }
      const t = String(data['text'] ?? '')
      texts.push((i > 0 ? '[frame ' + i + '] ' : '') + t)
    }
    this.lastItems.clear()
    for (const item of items) this.lastItems.set(item.index, { frame: item.frame, selector: item.selector })
    for (const f of forms) this.lastItems.set(f.index, { frame: f.frame, selector: f.selector })
    return {
      url: page.url(),
      title,
      ready: readyState,
      text: capText(texts.join('\n\n'), this.config.snapshotMaxChars),
      items,
      forms,
      truncated: { textChars: this.config.snapshotMaxChars, droppedItems: dropped },
    }
  }

  private async captureScreenshot(page: PageLike): Promise<string> {
    fs.mkdirSync(this.config.snapshotDir, { recursive: true })
    const file = path.join(this.config.snapshotDir, 'shot-' + Date.now() + '-' + uid().slice(0, 8) + '.png')
    await page.screenshot({ path: file, fullPage: true })
    return file
  }

  async open(url: string): Promise<InteractiveState> {
    try {
      return await this.openOnce(url)
    } catch (error) {
      // Window was closed by hand between hold and use: reset and relaunch once.
      if (error instanceof Error && CLOSED_TARGET_RE.test(error.message)) {
        await this.close()
        return this.openOnce(url)
      }
      throw error
    }
  }

  /** Current active URL ('' when no live page). Host-internal. */
  currentUrl(): string {
    const page = this.activePage
    return page && !page.isClosed() ? page.url() : ''
  }

  private async openOnce(url: string): Promise<InteractiveState> {
    const page = await this.ensurePage()
    page.setDefaultTimeout(30_000)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
    // SPA settle: client-rendered lists (查老师 etc.) paint after load.
    await page.waitForTimeout(800)
    return this.extract(page, true)
  }

  async snapshot(): Promise<SnapshotResult> {
    const page = await this.ensurePage()
    return this.readSnapshot(page)
  }

  /** Resolve the Playwright frame for a snapshot frame ordinal (0 = main frame). */
  private async frameFor(page: PageLike, frameIndex: number): Promise<FrameLike> {
    const frames = page.frames() as unknown as FrameLike[]
    const frame = frames[frameIndex] ?? frames[0]
    if (!frame) throw new Error('browser: 目标帧不可用，请重新 browser_snapshot')
    return frame
  }

  async click(ref: ElementRef, force = false): Promise<InteractiveState> {
    const page = await this.ensurePage()
    const frame = await this.frameFor(page, ref.frame)
    if (force) {
      // Hidden/dropdown elements (e.g. bootstrap menu items kept in the DOM but
      // display:none) fail Playwright's reachability even with force:true.
      // Dispatch via evaluate: element.click() fires its inline onclick (e.g.
      // categroyClick) without needing it to be visible.
      const ev = frame as unknown as { evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown> }
      try {
        const hit = await ev.evaluate((sel: unknown): boolean => {
          const el = document.querySelector(String(sel)) as HTMLElement | null
          if (el) { el.click(); return true }
          return false
        }, ref.selector)
        if (!hit) throw new Error('browser: force 点击未找到元素 ' + ref.selector)
      } catch (e) {
        throw new Error('browser: force 点击失败 (' + (e instanceof Error ? e.message : String(e)) + ')')
      }
    } else {
      await frame.click(ref.selector, { timeout: 30_000, force })
    }
    await page.waitForTimeout(700)
    // Fast state only: a clicked link often navigates an iframe mid-flight; a
    // full extraction then races the navigation. Read content via browser_snapshot.
    return this.fastState(page)
  }

  async type(ref: ElementRef, text: string): Promise<InteractiveState> {
    const page = await this.ensurePage()
    const frame = await this.frameFor(page, ref.frame)
    await frame.fill(ref.selector, text)
    return this.fastState(page)
  }

  /** Light state for actions: no DOM walk, never hangs on navigation. */
  private fastState(page: PageLike): InteractiveState {
    return {
      url: page.url(),
      title: this.lastTitle,
      text: '（操作完成——获取最新页面内容请调用 browser_snapshot）',
    }
  }

  /** Host-internal menu discovery: collect every in-page `data-gnmkdm` /
   *  `data-dyym` / `data-topgndm` attribute group (menu module identifiers and
   *  landing URLs). Same-origin attribute read only; never exposed as a model
   *  tool. Used by the ZJU adapter to locate the course-selection module.
   */
  async collectMenuLinks(): Promise<Array<Record<string, string>>> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    const out: Array<Record<string, string>> = []
    for (const frame of frames) {
      if (!frame) continue
      try {
        const rows = await frame.evaluate(`(() => {
          const out = []
          for (const el of document.querySelectorAll('[data-gnmkdm],[data-dyym],[data-topgndm],[data-gnmkmc]')) {
            const rec = {}
            for (const a of el.attributes) if (a.name.indexOf('data-') === 0) rec[a.name] = a.value
            out.push(rec)
          }
          return out
        })()`) as unknown as Array<Record<string, unknown>>
        for (const row of rows) {
          const rec: Record<string, string> = {}
          for (const [k, v] of Object.entries(row)) if (v !== undefined) rec[k] = String(v)
          out.push(rec)
        }
      } catch {
        // detached / cross-origin frame
      }
    }
    return out
  }

  /** Adapter session identity: the logged-in student number (su) used by the
   *  shell when opening module pages (e.g. &su=22521102). Host-internal. */
  async readSu(): Promise<string | null> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    for (const frame of frames) {
      if (!frame) continue
      try {
        const su = await frame.evaluate(`(() => {
          let t = ''
          try { t = document.documentElement.outerHTML || '' } catch (e) {}
          t = t.slice(0, 300000)
          const m = t.match(/["']?su["']?\\s*[:=]\\s*["']?(\\d{8,12})/i) || t.match(/su=(\\d{8,12})/i)
          if (m && m[1]) return m[1]
          try { if (window && typeof window['su'] === 'string') return window['su'] } catch (e) {}
          return null
        })()`) as unknown as string | null
        if (su) return su
      } catch {
        // keep scanning frames
      }
    }
    return null
  }

  /** Adapter table reading: the largest data table across frames, as
   *  headers + plain-text rows, with the frame ordinal + table ordinal so a
   *  per-row action can be clicked back by index. Host-internal. */
  async readTable(): Promise<{ frame: number; ordinal: number; headers: string[]; rows: string[][] } | undefined> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    let best: { frame: number; ordinal: number; headers: string[]; rows: string[][] } | undefined
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      if (!frame) continue
      try {
        const data = await frame.evaluate(`(() => {
          const tables = Array.from(document.querySelectorAll('table'))
          let bestTable = null, bestRows = 0, bestOrdinal = -1
          for (let t = 0; t < tables.length; t++) {
            const rows = tables[t].querySelectorAll('tbody tr')
            if (rows.length > bestRows) { bestRows = rows.length; bestTable = tables[t]; bestOrdinal = t }
          }
          if (!bestTable || bestRows === 0) return null
          const headRow = bestTable.querySelector('thead tr') || bestTable.rows && bestTable.rows[0]
          const headers = headRow ? Array.from(headRow.cells).map(c => (c.innerText || c.textContent || '').trim()) : []
          const rows = []
          const bodyRows = bestTable.querySelectorAll('tbody tr')
          Array.from(bodyRows).forEach(tr => {
            const cells = []
            for (const c of Array.from(tr.cells)) cells.push((c.innerText || c.textContent || '').trim().replace(/\\s+/g, ' '))
            rows.push(cells)
          })
          return { ordinal: bestOrdinal, headers, rows }
        })()`) as unknown as { ordinal: number; headers: string[]; rows: string[][] } | null
        if (data && data.rows.length > 0 && (!best || data.rows.length > best.rows.length)) {
          best = { frame: i, ordinal: data.ordinal, headers: data.headers, rows: data.rows }
        }
      } catch {
        // detached / cross-origin frame
      }
    }
    return best
  }

  /** Adapter: read EVERY data table (≥3 columns) across frames — the course
   *  grid renders ONE table per course, so a single largest-table read misses
   *  most of them. Host-internal. */
  async readAllTables(): Promise<Array<{ frame: number; ordinal: number; headers: string[]; rows: string[][] }>> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    const out: Array<{ frame: number; ordinal: number; headers: string[]; rows: string[][] }> = []
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      if (!frame) continue
      try {
        const data = await frame.evaluate(`(() => {
          const out = []
          const tables = document.querySelectorAll('table')
          for (let t = 0; t < tables.length; t++) {
            const trs = tables[t].querySelectorAll('tbody tr')
            if (trs.length === 0) continue
            const head = tables[t].querySelector('thead tr') || tables[t].rows[0]
            const headers = head ? Array.from(head.cells).map(c => (c.innerText || c.textContent || '').trim()) : []
            if (headers.length < 3) continue
            const rows = Array.from(trs).map(tr => Array.from(tr.cells).map(c => (c.innerText || c.textContent || '').trim().replace(/\\s+/g, ' ')))
            out.push({ ordinal: t, headers, rows })
          }
          return out
        })()`) as unknown as Array<{ ordinal: number; headers: string[]; rows: string[][] }>
        for (const d of data ?? []) out.push({ frame: i, ...d })
      } catch {
        // detached / cross-origin frame
      }
    }
    return out
  }

  /** Adapter row actions: return the CSS selector of the anchor inside one
   *  table row whose text contains `actionText` (e.g. "选课"). Host-internal. */
  async findRowAction(frameIndex: number, tableOrdinal: number, rowIndex: number, actionText: string): Promise<string | undefined> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    const frame = frames[frameIndex]
    if (!frame) return undefined
    try {
      const result = await frame.evaluate(`(() => {
        const tables = document.querySelectorAll('table')
        const table = tables[${tableOrdinal}]
        if (!table) return null
        const bodyRows = Array.from(table.querySelectorAll('tbody tr'))
        const tr = bodyRows[${rowIndex}]
        if (!tr) return null
        const anchors = Array.from(tr.querySelectorAll('a,button'))
        const target = anchors.find(el => (el.innerText || el.textContent || '').indexOf(${JSON.stringify(actionText)}) !== -1)
        if (!target) return null
        const parts = []
        let node = target
        while (node && node.nodeType === 1 && parts.length < 6) {
          let part = node.tagName.toLowerCase()
          if (node.id) part += '#' + node.id
          else {
            const parent = node.parentElement
            if (parent) {
              const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName)
              if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
            }
          }
          parts.unshift(part)
          node = node.parentElement
        }
        return parts.join(' > ')
      })()`) as unknown as string | null
      return result ?? undefined
    } catch {
      return undefined
    }
  }

  async status(): Promise<{ ready: boolean; engine: string; window: string; activeUrl?: string }> {
    const activeUrl = this.activePage?.isClosed?.() === false ? this.activePage.url() : undefined
    return { ready: !!this.activePage, engine: this.engine(), window: this.config.windowVisibility, ...(activeUrl ? { activeUrl } : {}) }
  }

  /** Host-internal: whether `selector` exists in any frame (top frame first). */
  async hasSelector(selector: string): Promise<boolean> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    for (const frame of frames) {
      if (!frame) continue
      try {
        const found = await frame.evaluate(`(() => !!document.querySelector(${JSON.stringify(selector)}))()`) as unknown as boolean
        if (found) return true
      } catch {
        // detached frame
      }
    }
    return false
  }

  /** Host-internal: select an option of a <select> (chosen-wrapped selects
   *  still react to native value+change). `indexHint` addresses the option
   *  slot (1 = first non-empty), used by retry loops. Returns the chosen value. */
  async selectOption(selector: string, indexHint = 1): Promise<string | null> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    for (const frame of frames) {
      if (!frame) continue
      try {
        const value = await frame.evaluate(`(() => {
          const s = document.querySelector(${JSON.stringify(selector)})
          if (!s) return null
          const opts = Array.from(s.options).map(o => ({ v: o.value, t: o.text }))
          let idx = ${indexHint}
          if (s.selectedIndex > 0) return ('__keep:' + s.value)
          if (idx <= 0 || idx >= opts.length) idx = 1
          const chosen = opts[idx]
          if (!chosen || chosen.v === '') return null
          s.value = chosen.v
          s.dispatchEvent(new Event('change', { bubbles: true }))
          return chosen.v
        })()`) as unknown as string | null
        if (value !== null && value !== undefined) {
          if (value.startsWith('__keep:')) return value.slice(7)
          return value
        }
      } catch {
        // detached frame
      }
    }
    return null
  }

  /** Dimension-selection flow for panels like 跨类(专业): pick 主修, fill
   *  学院/年级, try 专业 by option index, press 「选定」, dismiss "请选择专业!"
   *   alerts and retry the next 专业. Host-internal; used by the ZJU adapter
   *   and the dev checkpoint endpoint. */
  async dimensionFlow(idx = 0): Promise<{ done: boolean }> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.clickSelector('#kl_xxlb_zx') // 主修 radio
      await this.selectOption('#kl_xydm') // 学院（默认）
      await this.selectOption('#kl_nj') // 年级
      await this.selectOption('#kl_zydm', 1 + idx + attempt) // 专业逐项
      await this.clickSelector('button#btn_cnfrm') // 「选定」
      await this.wait(1100)
      if (!(await this.hasSelector('button#btn_cnfrm'))) return { done: true }
      if (await this.hasSelector('button#btn_ok')) {
        await this.clickSelector('button#btn_ok')
        await this.wait(400)
      }
    }
    return { done: false }
  }

  /** Host-internal wait helper for adapter flows. */
  async wait(ms: number): Promise<void> {
    const page = await this.ensurePage()
    await (page as PageLike).waitForTimeout(ms)
  }

  /** Fill a text input and submit its surrounding form via JS, wait for the
   *  SPA to render, then return the page's visible text (capped). Host-internal
   *  (实时去查老师站点按名查询教师评分). */
  async typeSubmitAndRead(inputSel: string, text: string, waitMs = 2600): Promise<{ url: string; text: string }> {
    const page = await this.ensurePage()
    const frames = page.frames() as unknown as FrameEval[]
    const frame = frames[0]
    if (!frame) return { url: page.url(), text: '' }
    try {
      await frame.fill(inputSel, text)
      await frame.evaluate(`(() => {
        const i = document.querySelector(${JSON.stringify(inputSel)})
        const f = i && i.form
        if (!f) return false
        try { f.requestSubmit(); return true } catch { f.submit(); return true }
      })()`)
    } catch {
      return { url: page.url(), text: '' }
    }
    await page.waitForTimeout(waitMs)
    let out = ''
    try {
      out = await frame.evaluate(`(() => (document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 4000))()`) as unknown as string
    } catch {
      out = ''
    }
    return { url: page.url(), text: out ?? '' }
  }

  /** Inject ⭐ rating badges + 选中难度 (Lazuli-style) into the course grid.
   *  Three stages, all payload passed via evaluate's protocol arg (never
   *  spliced into source):
   *  1) collect per-row {teacher, 余量, 所有待定} from the grid;
   *  2) host computes ⭐rate + 「N 进 1」难度 per row;
   *  3) page script injects both, MutationObserver keeps newly rendered rows
   *     covered on the next patrol. `map` = teacherName → rate. */
  async injectRatings(map: Record<string, string>, hrefMap: Record<string, string> = {}, searchBase = '', _force = false): Promise<{ injected: number; namesCount?: number; tsSample?: string[]; dbg?: { tables: number; rows: number; withTeacher: number; emptyRaw: number; name0?: string }; stage1Error?: string; stage2?: string }> {
    const page = await this.ensurePage()
    const frame = (page.frames() as unknown as FrameEval[])[0]
    if (!frame) return { injected: 0 }
    const ev = frame as unknown as { evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown> }
    type RowPick = { ts: string[]; rest: number | null; pending: number | null }
    let rows: RowPick[] = []
    let stage1Error: string | undefined
    let dbg: { tables: number; rows: number; withTeacher: number; emptyRaw: number; name0?: string } = { tables: 0, rows: 0, withTeacher: 0, emptyRaw: 0 }
    try {
      const picked = (await ev.evaluate((): { rows: RowPick[]; meta: { tables: number; rows: number; withTeacher: number; emptyRaw: number; name0?: string } } => {
        const out: RowPick[] = []
        const tables = document.querySelectorAll('#displayBox table:not(#zzxkSearchTable)')
        const meta: { tables: number; rows: number; withTeacher: number; emptyRaw: number; name0?: string } = { tables: tables.length, rows: 0, withTeacher: 0, emptyRaw: 0 }
        // 权威多师名拆分（参调研：childNodes 遍历，TEXT_NODE 收集、BR 分段）——
        // 零序列化、类型安全、两端同实现即一致。单师则一个名字。
        const splitNames = (el: Element): string[] => {
          const out2: string[] = []
          let cur = ''
          for (const ch of Array.from(el.childNodes)) {
            if (ch.nodeType === 3) cur += ch.nodeValue || ''
            else if (ch.nodeName === 'BR') {
              const t = String(cur.replace(/[\u3000\u00A0]/g, ' ').trim())
              if (t) out2.push(t)
              cur = ''
            }
          }
          const last = String(cur.replace(/[\u3000\u00A0]/g, ' ').trim())
          if (last) out2.push(last)
          return out2
        }
        tables.forEach((table) => {
          // 表头列索引：thead tr 优先，其次 tbody 首行（分类页/搜索页两种布局）。
          // 用于按列取「所有待定人数」（难度=待定/余量）。
          const cellTxt = (c: Element): string => String((c as HTMLElement).innerText || (c as HTMLElement).textContent || '').trim()
          const headTr = (() => {
            const thead = table.querySelector('thead tr')
            if (thead) {
              const txt = Array.from(thead.querySelectorAll('td, th')).map(cellTxt).join('|')
              if (txt.indexOf('教师') !== -1 || txt.indexOf('余量') !== -1) return thead
            }
            const first = table.querySelector('tbody tr')
            if (first) {
              const txt = Array.from(first.querySelectorAll('td, th')).map(cellTxt).join('|')
              if (txt.indexOf('余量') !== -1 || txt.indexOf('容量') !== -1) return first
            }
            return null
          })()
          let pendingIdx = -1
          if (headTr) {
            const hc = Array.from(headTr.querySelectorAll('td, th')).map(cellTxt)
            pendingIdx = hc.findIndex((c) => /所有待定|本专业待定/.test(c))
          }
          const trs = Array.from(table.querySelectorAll('tbody tr'))
          trs.forEach((tr) => {
            meta.rows++
            const a = tr.querySelector('td a')
            if (!a) { meta.emptyRaw++; return }
            meta.withTeacher++
            const ts = splitNames(a).filter((n) => { const s = String(n ?? ''); return s !== '教师' && s.indexOf('教师') === -1 })
            if (ts.length === 0) { meta.emptyRaw++; return }
            if (meta.name0 === undefined) meta.name0 = ts[0]!.slice(0, 24)
            const cells = Array.from(tr.querySelectorAll('td, th')).map(cellTxt)
            const restCell = cells.find((c) => /^\s*-?\d+\s*\/\s*\d+\s*$/.test(c))
            const restM = restCell ? /(-?\d+)\s*\/\s*\d+/.exec(restCell) : null
            const rest = restM ? parseFloat(restM[1]!) : null
            const pendCell = pendingIdx >= 0 ? cells[pendingIdx] : ''
            const pendM = /(-?\d+)/.exec(String(pendCell ?? ''))
            const pending = pendM ? parseFloat(pendM[1]!) : null
            out.push({ ts, rest, pending })
          })
        })
        return { rows: out, meta }
      })) as unknown as { rows: RowPick[]; meta: { tables: number; rows: number; withTeacher: number; emptyRaw: number; name0?: string } } | undefined ?? { rows: [], meta: { tables: 0, rows: 0, withTeacher: 0, emptyRaw: 0 } }
      rows = picked.rows
      dbg = picked.meta
    } catch (e) {
      stage1Error = e instanceof Error ? e.message : String(e)
    }
    const namesCount = rows.length
    if (namesCount === 0) return { injected: 0, namesCount, dbg, ...(stage1Error ? { stage1Error } : {}) }
    // stage 2: 宿主只算好评分传回页面（一行可能多位教师）；难度（N 进 1）由
    // 页面端按 Lazuli 算法就地计算（读行内余量/待定列，append 到待定列）。
    type RowTc = { t: string; rate: string; href: string }
    type RowInj = { ts: RowTc[] }
    const inject: RowInj[] = rows.map((r) => ({
      ts: r.ts.map((t) => ({
        t,
        rate: map[t] !== undefined && map[t] !== '' ? map[t]! : '',
        href: hrefMap[t] ?? (searchBase ? `${searchBase.replace(/\/+$/, '')}/` : ''),
      })),
    }))
    let injected = 0
    let stage2: string | undefined
    try {
      const raw2 = await ev.evaluate((payloadArg: unknown): string => {
        const payload = payloadArg as RowInj[]
        const badge = (rate: string, href: string): HTMLElement => {
          const el = document.createElement(href ? 'a' : 'span')
          el.dataset.dshr = '1'
          if (href) {
            (el as HTMLAnchorElement).href = href
            ;(el as HTMLAnchorElement).target = '_blank'
            ;(el as HTMLAnchorElement).rel = 'noopener'
            ;(el as HTMLElement).style.cursor = 'pointer'
          }
          const s = el
          const f = parseFloat(rate)
          if (rate === '' || !Number.isFinite(f)) {
            s.textContent = ' ★无评分'
            s.style.color = '#bbb'
            s.style.fontSize = '11px'
            return s
          }
          s.textContent = ' ⭐' + rate
          s.style.color = f >= 8.5 ? '#c00' : f < 2 ? '#4340ff' : '#333'
          s.style.fontWeight = 'bold'
          return s
        }
        const apply = (): string => {
          let n = 0, rows = 0, matched = 0
          try {
            // 每轮先清上一轮徽章再重挂：数量恒定、必显示、不累积（与早期可显示版本同构）。
            document.querySelectorAll('#displayBox table:not(#zzxkSearchTable) [data-dshr], #displayBox table:not(#zzxkSearchTable) [data-dshd]')
              .forEach((el) => { try { el.remove() } catch { /* ignore */ } })
            let i = 0
            // 与 stage1 极简版完全一致的行集：没有 td a 的行（表头/空行）一律跳过且
            // 不消耗 payload，保证 stage1 收集顺序与这里一一对应（否则末行错位丢失）。
            document.querySelectorAll('#displayBox table:not(#zzxkSearchTable)').forEach((table) => {
              const trs = table.querySelectorAll('tbody tr')
              trs.forEach((tr, _idx) => {
                if (!tr.querySelector('td a')) return
                rows++
                const info = payload[i++]
                if (!info || info.ts.length === 0) return
                // 权威多师名拆分（与 stage1 同实现）→ 每位教师各挂一个徽章（插在 <a> 后）。
                // 幂等由 apply 开头"先清 data-dshr"保证每轮一套，这里直接挂。
                const teacherLink = tr.querySelector('td a')
                if (teacherLink) {
                  const splitNames = (el: Element): string[] => {
                    const out2: string[] = []
                    let cur = ''
                    for (const ch of Array.from(el.childNodes)) {
                      if (ch.nodeType === 3) cur += ch.nodeValue || ''
                      else if (ch.nodeName === 'BR') {
                        const t = String(cur.replace(/[\u3000\u00A0]/g, ' ').trim())
                        if (t) out2.push(t)
                        cur = ''
                      }
                    }
                    const last = String(cur.replace(/[\u3000\u00A0]/g, ' ').trim())
                    if (last) out2.push(last)
                    return out2
                  }
                  // 先按名字顺序收集徽章，再一次性 after(...) 插入——保持"前师在前"顺序
                  // （逐个 insertAdjacentElement('afterend') 会把后一位插到前一位前面）。
                  // 第 2 个及以后的评分前加 <br>，每个评分单独一行；单师不受影响。
                  const badges: HTMLElement[] = []
                  splitNames(teacherLink).forEach((name) => {
                    const item = String(name ?? '') ? info.ts.find((c) => c.t === String(name ?? '')) : undefined
                    matched++
                    badges.push(item ? badge(item.rate, item.href) : badge('', ''))
                  })
                  if (badges.length > 0) {
                    const frag = document.createDocumentFragment()
                    badges.forEach((b, idx) => {
                      if (idx > 0) {
                        const br = document.createElement('br')
                        br.setAttribute('data-dshr', '1') // 随徽章一起每轮清除，防空行累积
                        frag.appendChild(br)
                      }
                      frag.appendChild(b)
                    })
                    teacherLink.after(frag)
                  }
                }
                // ── 难度标注（N 进 1）：照搬 Lazuli 页面端算法 ──
                // 余量=倒数第6列"数字/数字"前段；本专业待定=倒数第3列、所有待定=倒数第2列
                // （取 < 前数字，兼容其它插件注入）；append 到待定列，保留原数字。
                // 注入的 span 打 data-dshd（随每轮清理，防累积）；绝不标记 td 本身，
                // 否则清理逻辑会把整列删掉。
                const tdList = Array.from(tr.querySelectorAll('td'))
                const diffEl6 = tdList[tdList.length - 6]
                const majorTd = tdList[tdList.length - 3]
                const allTd = tdList[tdList.length - 2]
                const restStr = diffEl6 ? (diffEl6.textContent || '').split('/')[0] : ''
                const restN = Number(restStr.replace(/[^\d.-]/g, ''))
                const majorPending = majorTd ? Number((majorTd.innerHTML.split('<')[0]).replace(/[^\d.-]/g, '')) : NaN
                const allPending = allTd ? Number((allTd.innerHTML.split('<')[0]).replace(/[^\d.-]/g, '')) : NaN
                if (Number.isFinite(restN) && restStr.trim() !== '') {
                  // br 也要打 data-dshd：清理逻辑只删带标记的元素，否则 br 残留、
                  // 每轮注入都叠加一个空行。
                  const BR = '<br data-dshd="1">'
                  const diffSpan = (txt: string, color: string): string =>
                    `<span data-dshd="1" style="font-weight:bold; color:${color};">${txt}</span>`
                  if (restN <= 0) {
                    if (majorTd) majorTd.insertAdjacentHTML('beforeend', BR + diffSpan('无法选中', 'darkgray'))
                    if (allTd) allTd.insertAdjacentHTML('beforeend', BR + diffSpan('无法选中', 'darkgray'))
                  } else {
                    const rateHTML = (pendingN: number): string => {
                      const ratio = (Number.isFinite(pendingN) ? pendingN : 0) / restN
                      const color = ratio < 1 ? 'green' : ratio < 5 ? 'darkorange' : ratio < 10 ? '#e60c0c' : 'black'
                      const text = ratio < 1 ? '容易选中' : ratio < 5 ? '不易选中' : ratio < 10 ? '难选中' : '极难选中'
                      return BR + diffSpan(`「${ratio.toFixed(2)} 进 1」<br>${text}`, color)
                    }
                    if (majorTd) majorTd.insertAdjacentHTML('beforeend', rateHTML(majorPending))
                    if (allTd) allTd.insertAdjacentHTML('beforeend', rateHTML(allPending))
                  }
                }
                n++
              })
            })
          } catch (e) { /* best effort */ }
          return JSON.stringify({ n, rows, matched })
        }
        return apply()
      }, inject) as unknown as string
      const parsed2 = (() => { try { return JSON.parse(raw2 ?? '{}') as { n?: number; rows?: number; matched?: number } } catch { return {} } })()
      injected = Number(parsed2.n ?? 0)
      stage2 = 'rows=' + (parsed2.rows ?? '?') + ' matched=' + (parsed2.matched ?? '?')
    } catch (e) {
      stage2 = 'EVAL_ERR:' + (e instanceof Error ? e.message : String(e))
    }
    return { injected, namesCount, tsSample: rows.slice(0, 4).map((r) => r.ts.join('␟')), ...(stage2 ? { stage2 } : {}) }
  }

  /** Grid-state diagnostic (main frame only): why injection may see nothing. */
  async gridDiag(): Promise<Record<string, unknown>> {
    const page = await this.ensurePage()
    const frame = (page.frames() as unknown as FrameEval[])[0]
    if (!frame) return { frames: 0 }
    try {
      const r = await frame.evaluate(`(() => ({
        readyState: document.readyState,
        hasDisplayBox: !!document.getElementById('displayBox'),
        allTables: document.querySelectorAll('table').length,
        dispTables: document.querySelectorAll('#displayBox table').length,
        dispTBodyRows: document.querySelectorAll('#displayBox table tbody tr').length,
        gridRows: document.querySelectorAll('table[id^="table_"] tbody tr').length,
        kcmcCards: document.querySelectorAll('h3[id^="kcmc_"]').length,
        xuankeBtns: document.querySelectorAll('button.xuanke').length,
        bodyChildren: document.body ? document.body.children.length : -1
      }))()`) as unknown as Record<string, unknown>
      return r
    } catch {
      return { error: 'evaluate failed' }
    }
  }

  /** Host-internal DOM click on the current top frame (traversal helper). */
  async clickSelector(selector: string): Promise<{ ok: boolean; url: string }> {
    const page = await this.ensurePage()
    const frame = await this.frameFor(page, 0)
    await frame.click(selector, { timeout: 15_000 })
    await page.waitForTimeout(900)
    return { ok: true, url: page.url() }
  }

  /** 等待用户完成教务登录：轮询直到已登录（zdbk 站内非登录页、且页面不提示
   *  「会话已过期/重新登录」——会话过期时 URL 仍可能停在选课页），超时返回未登录。 */
  async waitForLogin(timeoutMs = 120000): Promise<{ loggedIn: boolean; url: string; su?: string }> {
    const deadline = Date.now() + Math.max(1, timeoutMs)
    while (Date.now() < deadline) {
      const url = this.currentUrl()
      if (url && /zdbk\.zju\.edu\.cn/.test(url) && !/login_slogin/.test(url)) {
        const page = await this.ensurePage().catch(() => undefined)
        const frame = page ? (page.frames() as unknown as FrameEval[])[0] : undefined
        let expired = false
        if (frame) {
          try {
            expired = /会话已过期|已退出登录|重新登录/i.test(
              (await frame.evaluate(`(() => (document.body && (document.body.innerText || '').slice(0, 400)) || '')()`) as unknown as string) || '',
            )
          } catch { expired = false }
        }
        if (!expired) {
          const su = await this.readSu().catch(() => '')
          const result: { loggedIn: true; url: string; su?: string } = { loggedIn: true, url }
          if (su) result.su = su
          return result
        }
      }
      await this.wait(1500)
    }
    return { loggedIn: false, url: this.currentUrl() }
  }

  /** Host-internal page digest (traversal comparison): table shapes, course
   *  selection buttons, and a short text preview of the current page. */
  async digest(): Promise<{ url: string; tables: Array<{ headers: string[]; rows: number }>; xkButtons: number; text: string }> {
    const page = await this.ensurePage()
    const frameList = page.frames() as unknown as FrameEval[]
    let tables: Array<{ headers: string[]; rows: number }> = []
    let xkButtons = 0
    let text = ''
    for (const frame of frameList) {
      if (!frame) continue
      try {
        const data = await frame.evaluate(`(() => {
          const tables = Array.from(document.querySelectorAll('table')).map(t => ({
            headers: ((t.querySelector('thead tr') || t.rows[0]) ? Array.from(((t.querySelector('thead tr') || t.rows[0])).cells).map(c => (c.innerText || c.textContent || '').trim()) : []),
            rows: t.querySelectorAll('tbody tr').length
          }))
          const xk = document.querySelectorAll('button.xuanke, [class*="xuanke"]').length
          const text = (document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 500)
          return { tables, xk, text }
        })()`) as unknown as { tables: Array<{ headers: string[]; rows: number }>; xk: number; text: string }
        if (data.tables.length > tables.length) tables = data.tables
        xkButtons += data.xk
        text = text || data.text
      } catch {
        // detached / cross-origin frame
      }
    }
    return { url: page.url(), tables, xkButtons, text }
  }

  /** 折叠课程卡片清单（h3#kcmc_* → id/名称/是否已展开）。 */
  async listCards(): Promise<Array<{ id: string; name: string; expanded: boolean }>> {
    const page = await this.ensurePage()
    const frame = (page.frames() as unknown as FrameEval[])[0]
    if (!frame) return []
    const ev = frame as unknown as { evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown> }
    try {
      return (await ev.evaluate((): Array<{ id: string; name: string; expanded: boolean }> => {
        return Array.from(document.querySelectorAll('h3 span[id^="kcmc_"], span[id^="kcmc_"]')).map((h) => {
          const box = h.closest('div')
          const exp = box ? box.querySelector('a.expand_close') : null
          return {
            id: h.id.replace('kcmc_', ''),
            name: String((h.textContent || '').split('\n')[0] || '').trim(),
            expanded: exp ? !exp.classList.contains('expand1') : false,
          }
        })
      })) as unknown as Array<{ id: string; name: string; expanded: boolean }> ?? []
    } catch {
      return []
    }
  }

  /** 展开指定课程卡片（点击其展开链接；页面为手风琴，一次只开一个）。 */
  async expandCard(id: string): Promise<boolean> {
    const page = await this.ensurePage()
    const frame = (page.frames() as unknown as FrameEval[])[0]
    if (!frame) return false
    const ev = frame as unknown as { evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown> }
    try {
      const ok = await ev.evaluate((cardId: unknown): boolean => {
        const h = document.getElementById('kcmc_' + String(cardId))
        const box = h && h.closest('div')
        const a = box && box.querySelector('a.expand_close.expand1')
        if (a) { (a as HTMLAnchorElement).click(); return true }
        return false
      }, id) as unknown as boolean
      await page.waitForTimeout(700)
      return ok === true
    } catch {
      return false
    }
  }

  /** 翻到下一课程页（「点此查看更多」）；无可翻页返回 false。 */
  async nextPage(): Promise<boolean> {
    const page = await this.ensurePage()
    const ev = (page.frames() as unknown as FrameEval[])[0] as unknown as { evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown> }
    if (!ev) return false
    try {
      const has = (await ev.evaluate((): boolean => {
        const a = document.querySelector<HTMLAnchorElement>('a#nextPage')
        return !!a && (a.offsetParent !== null || a.style.display !== 'none')
      })) as unknown as boolean
      if (!has) return false
      await this.clickSelector('a#nextPage')
      await this.wait(1200)
      return true
    } catch {
      return false
    }
  }

  /** 逐课程遍历当前类别：展开→（先注入评分/难度）→读表→翻页，汇总全部教学班
   *  （列对齐结构，供 course_plan/course_search/adapter 使用）。 */
  async crawlGrid(map?: Record<string, string>, hrefMap: Record<string, string> = {}, maxPages = 4): Promise<Array<{ course: string; headers: string[]; rows: string[][] }>> {
    const out: Array<{ course: string; headers: string[]; rows: string[][] }> = []
    const seenCards = new Set<string>()
    const seenTables = new Set<string>()
    let pagesSeen = 0
    for (let guard = 0; guard < 200; guard++) {
      const cards = await this.listCards()
      const fresh = cards.filter((c) => !seenCards.has(c.id) && !c.expanded)
      if (fresh.length === 0) {
        if (pagesSeen >= maxPages) break
        const more = await this.nextPage()
        if (!more) break
        pagesSeen++
        continue
      }
      for (const c of fresh) {
        seenCards.add(c.id)
        await this.expandCard(c.id)
        if (map && Object.keys(map).length > 0) {
          try { await this.injectRatings(map, hrefMap) } catch { /* best effort */ }
        }
        const t = await this.readVisibleTable()
        if (t && t.rows.length > 0) {
          const key = t.headers.join('/') + '|' + (t.rows[0] ?? []).slice(0, 3).join('/')
          if (!seenTables.has(key)) {
            seenTables.add(key)
            out.push({ course: c.name, headers: t.headers, rows: t.rows })
          }
        }
      }
    }
    return out
  }

  /** 同 crawlGrid，但每行按 DOM 语义读取（不靠列索引，表型无关）：
   *  教师=行内 <a>，节次/地点/余量=行内特征——分类页/搜索页/大班次通用。
   *  供 browser_crawl 使用。 */
  async crawlGridSem(map?: Record<string, string>, hrefMap: Record<string, string> = {}, maxPages = 4): Promise<Array<{ course: string; rows: RowSem[] }>> {
    const out: Array<{ course: string; rows: RowSem[] }> = []
    const seenCards = new Set<string>()
    const seenTables = new Set<string>()
    let pagesSeen = 0
    for (let guard = 0; guard < 200; guard++) {
      const cards = await this.listCards()
      const fresh = cards.filter((c) => !seenCards.has(c.id) && !c.expanded)
      if (fresh.length === 0) {
        if (pagesSeen >= maxPages) break
        const more = await this.nextPage()
        if (!more) break
        pagesSeen++
        continue
      }
      for (const c of fresh) {
        seenCards.add(c.id)
        await this.expandCard(c.id)
        if (map && Object.keys(map).length > 0) {
          try { await this.injectRatings(map, hrefMap) } catch { /* best effort */ }
        }
        const rows = await this.readVisibleRowsSem()
        if (rows.length > 0) {
          const key = rows.slice(0, 3).map((r) => r.teacher + r.time).join('|')
          if (!seenTables.has(key)) {
            seenTables.add(key)
            out.push({ course: c.name, rows })
          }
        }
      }
    }
    return out
  }

  /** 语义化一行教学班：不依赖列索引（表型无关）。教师=行内首个 <a>；
   *  节次=含"周X/星期X"的单元格；地点=含 校区/馆/楼/操场/教室/室 的单元格；
   *  余量=形如"数字/数字"的单元格（前段为余量，后段容量）；
   *  pend=待定（按表头可定位则取，否则 null）。 */
  private async readVisibleRowsSem(): Promise<RowSem[]> {
    const page = await this.ensurePage()
    const frame = (page.frames() as unknown as FrameEval[])[0]
    if (!frame) return []
    const ev = frame as unknown as { evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown> }
    try {
      return (await ev.evaluate((): Array<{ teacher: string; time: string; location: string; rest: number | null; raw: string }> => {
        const arrOf = (tr: Element): string[] => Array.from(tr.querySelectorAll('td, th')).map((c) => {
          const el = c as HTMLElement
          return String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
        })
        const out: Array<{ teacher: string; time: string; location: string; rest: number | null; raw: string }> = []
        document.querySelectorAll('#displayBox table[id^="table_"]').forEach((table) => {
          if ((table as HTMLElement).offsetParent === null) return
          table.querySelectorAll('tbody tr').forEach((tr) => {
            const a = tr.querySelector('td a')
            const teacher = a ? String(a.textContent || '').trim() : ''
            if (!teacher) return
            const cells = arrOf(tr)
            const time = cells.find((c) => /周[一二三四五六日]|星期[一二三四五六日]/.test(c)) || ''
            // 地点特征：含场馆/教室类地名词；排除教师/评分格（⭐★/纯评分）与节次格。
            const location = cells.find((c) =>
              /校区|体育馆|体育场|球场|场地|操场|游泳|田径|健身|教室|实验室|机房|室|馆|楼|中心|基地/.test(c)
              && !/⭐|★/.test(c)
              && !/周[一二三四五六日]|第\d/.test(c)
              && !/^\s*-?\d+\s*\/\s*\d+\s*$/.test(c)
            ) || ''
            const restCell = cells.find((c) => /^\s*-?\d+\s*\/\s*\d+\s*$/.test(c))
            const restM = restCell ? /(-?\d+)\s*\/\s*\d+/.exec(restCell) : null
            const rest = restM ? parseFloat(restM[1]!) : null
            out.push({ teacher, time, location, rest, raw: cells.join(' | ') })
          })
        })
        return out
      })) as unknown as RowSem[] ?? []
    } catch {
      return []
    }
  }

  /** 读取当前页可见（offsetParent 非 null）的最大教学班表——手风琴展开的那张。 */
  private async readVisibleTable(): Promise<{ headers: string[]; rows: string[][] } | null> {
    const page = await this.ensurePage()
    const frame = (page.frames() as unknown as FrameEval[])[0]
    if (!frame) return null
    const ev = frame as unknown as { evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown> }
    try {
      return (await ev.evaluate((): { headers: string[]; rows: string[][] } | null => {
        let best: { headers: string[]; rows: string[][] } | null = null
        const cellTxt = (tr: Element): string[] => Array.from(tr.querySelectorAll('td, th')).map((c) => {
          const el = c as HTMLElement
          return String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
        })
        document.querySelectorAll('#displayBox table[id^="table_"]').forEach((table) => {
          if ((table as HTMLElement).offsetParent === null) return
          // 兼容表头在 <tbody> 首行（分类页）与 <thead>（搜索结果页）两种情况：
          // 只含 tbody 时，<thead> 的真表头会被漏成"找不到表头"→ 列定位全空。
          const theadTr = table.querySelector('thead tr')
          const trs: Element[] = theadTr
            ? [theadTr, ...Array.from(table.querySelectorAll('tbody tr'))]
            : Array.from(table.querySelectorAll('tbody tr'))
          // 表头 = 首个含 教师/余量/容量 文案的行（thead 优先，其次 tbody 首行）
          let headIdx = -1
          for (let k = 0; k < trs.length; k++) {
            const tx = cellTxt(trs[k]!).join('|')
            if (tx.indexOf('教师') !== -1 || tx.indexOf('余量') !== -1 || tx.indexOf('容量') !== -1) { headIdx = k; break }
          }
          const headers = headIdx >= 0 ? cellTxt(trs[headIdx]!) : []
          const rows: string[][] = []
          trs.forEach((tr, k) => {
            if (k === headIdx) return
            const cells = cellTxt(tr)
            if (cells.length >= 3) rows.push(cells)
          })
          if (rows.length === 0) return
          if (!best || rows.length > best.rows.length) best = { headers, rows }
        })
        return best
      })) as unknown as { headers: string[]; rows: string[][] } | null ?? null
    } catch {
      return null
    }
  }

  // ── CDP screencast mirror (P0.5) ─────────────────────────────────────────

  /** Latest JPEG frame + its capture timestamp (0 when no frame yet). */
  mirrorFrame(): { frame: Buffer | undefined; frameTs: number } {
    this.lastPoll = Date.now()
    return { frame: this.latestFrame, frameTs: this.frameTs }
  }

  /** A fresh frame: screencast when it streams, otherwise a direct screenshot
   *  (Windows occlusion throttles screencast when the visible window is
   *  hidden/minimized — this keeps the panel live regardless). */
  async currentFrame(): Promise<{ frame: Buffer; ts: number }> {
    await this.startMirror()
    if (this.latestFrame && Date.now() - this.frameTs < 1500) {
      this.lastPoll = Date.now()
      return { frame: this.latestFrame, ts: this.frameTs }
    }
    const page = this.activePage
    if (!page || page.isClosed()) throw new Error('browser: 无活动页面')
    const shot = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false })) as Buffer
    this.latestFrame = shot
    this.frameTs = Date.now()
    this.lastPoll = Date.now()
    return { frame: shot, ts: this.frameTs }
  }

  /** Live status snapshot for the panel status endpoint. */
  mirrorStatus(): { url: string; title: string; ready: 'complete' | 'loading'; engine: string; window: string; frameAgeMs: number } {
    this.lastPoll = Date.now()
    const page = this.activePage
    const url = page && !page.isClosed() ? page.url() : ''
    const title = url ? (this.lastTitle ?? '') : ''
    return {
      url,
      title,
      ready: url ? 'complete' : 'loading',
      engine: this.engine(),
      window: this.config.windowVisibility,
      frameAgeMs: this.frameTs ? Date.now() - this.frameTs : -1,
    }
  }

  /** Start capturing screencast frames via CDP on the CURRENT page; safe to
   *  call repeatedly. Retargets when the active page changed (new tab / user
   *  navigation), so the mirror always shows what the agent is looking at. */
  async startMirror(): Promise<void> {
    const page = this.activePage
    if (!page || page.isClosed()) return
    if (this.cdp && this.mirrorPage === page) return
    await this.stopMirror()
    try {
      const context = this.context as unknown as { newCDPSession: (page: unknown) => Promise<CdpSessionLike> }
      const cdp = await context.newCDPSession(page)
      cdp.on('Page.screencastFrame', (params: unknown) => {
        const data = (params as { data?: string }).data
        if (typeof data === 'string' && data.length > 0) {
          this.latestFrame = Buffer.from(data, 'base64')
          this.frameTs = Date.now()
        }
      })
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 1, maxWidth: 1280, maxHeight: 900 })
      this.cdp = cdp
      this.mirrorPage = page
      // Optional idle watchdog (0 = keep streaming): background tabs throttle
      // timers well past 10s, so an aggressive default freezes the mirror.
      if (this.config.mirrorIdleStopMs > 0) {
        this.idleTimer = setInterval(() => {
          if (this.cdp && this.lastPoll > 0 && Date.now() - this.lastPoll > this.config.mirrorIdleStopMs) {
            void this.stopMirror()
          }
        }, this.config.mirrorIdleStopMs / 2)
      }
    } catch {
      // Mirror is best-effort: screenshot fallback happens at the HTTP layer.
      this.cdp = undefined
      this.mirrorPage = undefined
    }
  }

  /** Stop screencast capture (panel closed / plugin unload). */
  async stopMirror(): Promise<void> {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined }
    const cdp = this.cdp
    this.cdp = undefined
    this.mirrorPage = undefined
    if (!cdp) return
    try { await cdp.send('Page.stopScreencast') } catch { /* already stopped */ }
    try { await cdp.detach() } catch { /* already detached */ }
  }

  async close(): Promise<void> {
    await this.stopMirror()
    const ctx = this.context as { close?: () => Promise<unknown> } | undefined
    this.context = undefined
    this.activePage = undefined
    if (ctx?.close) { try { await ctx.close() } catch { /* already closed */ } }
  }
}

/** Structural CDP session surface used by the mirror (playwright types stay unlinked). */
interface CdpSessionLike {
  on: (event: string, listener: (params: unknown) => void) => void
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  detach: () => Promise<void>
}