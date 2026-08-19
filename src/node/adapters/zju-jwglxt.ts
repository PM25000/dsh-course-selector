/**
 * ZJU (zdbk.jwglxt / zhèngfāng) course-selection adapter.
 *
 * Real-system facts verified against the live instance (2026-08):
 * - Login: unified identity; after login the shell lands on index_initMenu.html
 *   (menu lives inside an iframe; gnmkdm module codes drive everything).
 * - Module map: elements carry `data-gnmkdm` + `data-dyym` (landing URL).
 *   自主选课 N253530 → /xsxk/zzxzkghb_cxZzxkGhbIndex.html (404 outside the
 *   selection window; verify during rounds), 课表 N253508 → /kbcx/xskbcx_...
 * - Course grid tables parse via the generic table reader.
 * @module dsh-course-selector/zju-jwglxt
 */
import type { BrowserManager } from '../browser-manager.ts'

export interface CourseRow {
  index: number
  code: string
  name: string
  credits: string
  teacher: string
  time: string
  location: string
  capacity: string
  enrolled: string
  /** 待定人数（所有/本专业待定，用于选中难度）。 */
  pending: string
  status: string
}

const ORIGIN = new URL('https://zdbk.zju.edu.cn').origin

/** Selection-category tabs → stable CSS selectors (verified on the live page). */
export const CATEGORY_SELECTOR: Record<string, string> = {
  '本类': 'a#blzyTool',
  '跨类': 'a[data-dl="xk_1_1"]',
  '通识必修': 'a[data-dl="xk_b"]',
  '通识选修': 'a[data-dl="xk_n"]',
  '体育': 'a#tykTool',
  '专业基础': 'a[data-dl="Z"]',
  '专业课程': 'a[data-dl="zy_b"]',
  '认证型': 'a[data-dl="xk_rdxkc"]',
  '国际化': 'a#gjhkcTool',
  '荣誉': 'a[data-dl="R"]',
  '循环补充': 'a[data-dl="xk_6"]',
  '补考': 'a[data-dl="xk_7"]',
  '搜索引擎': 'a#searchTool',
}

/** Dropdown categories: nav_tab li ordinal of their parent toggle (opened
 *  before the sub-item becomes clickable). Verified 通识必修=3, 认定型=8;
 *  通识选修=4, 专业课程=7 follow the same nav_tab ordering. */
const DROPDOWN_TOGGLE: Record<string, number> = {
  '通识必修': 3,
  '通识选修': 4,
  '专业课程': 7,
  '认证型': 8,
}

function joinUrl(base: string, path: string): string {
  if (path.startsWith('http')) return path
  return base + path
}

/** Map table headers (Chinese) onto the CourseRow fields. */
function headerMap(headers: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  const rules: Array<[keyof CourseRow, RegExp]> = [
    ['code', /课程编号|课程号|kch/],
    ['name', /课程名称|课程名|kcmc/],
    ['credits', /学分|xf/],
    ['teacher', /教师|授课|老师/],
    ['time', /上课时间|周次|节次|时间/],
    ['location', /上课地点|校区|教室|地点/],
    ['capacity', /容量|计划人数|总容量/],
    ['enrolled', /已选|已选人数|选课人数|余量|实选/],
    ['pending', /所有待定|全部待定|本专业待定/],
    ['status', /状态|备注|是否可选|面向对象|预修/],
  ]
  headers.forEach((h, i) => {
    const hh = (h || '').trim()
    if (!hh) return
    for (const [key, re] of rules) {
      if (re.test(hh) && out[key] === undefined) { out[key] = i; break }
    }
  })
  return out
}

function cellAt(cells: readonly string[], key: keyof CourseRow, map: Record<string, number>): string {
  const i = map[key]
  return i !== undefined ? (cells[i] ?? '') : ''
}

export class ZjuJwglxtAdapter {
  /** Table context of the last planCourses read (for row-action targeting). */
  lastTable: { frame: number; ordinal: number } | undefined = undefined
  /** Per-plan-row (frame, ordinal, row) so submit/cancel hit the right row. */
  rowTargets: Array<{ frame: number; ordinal: number; row: number }> = []

  constructor(private readonly origin: string = ORIGIN) {}

  async detectLogin(manager: BrowserManager): Promise<'login' | 'home' | 'unknown' | 'offline'> {
    const st = await manager.status()
    if (!st.ready || !st.activeUrl) return 'offline'
    const url = st.activeUrl
    if (/login_slogin/.test(url)) return 'login'
    if (/init_menu|index_initMenu/.test(url)) return 'home'
    return 'unknown'
  }

  /** Open 选课管理 → 自主选课 via the live menu map (falls back to the
   *  known module URL when the menu is unreachable). `cat` optionally switches
   *  the category tab (体育/本类/搜索引擎/…). */
  async openCourseCenter(manager: BrowserManager, cat?: string): Promise<string> {
    const links = await manager.collectMenuLinks()
    const entry = links.find((l) => /自主选课/.test(l['data-gnmkmc'] ?? ''))
      ?? links.find((l) => (l['data-dyym'] ?? '').includes('/xs'))
      ?? links.find((l) => /选课/.test(l['data-gnmkmc'] ?? ''))
    if (!entry) throw new Error('zju: 未在菜单中找到「自主选课」')
    const dy = entry['data-dyym']
    if (!dy) throw new Error('zju: 「自主选课」缺少 data-dyym')
    // The shell opens modules with layout=default & the logged-in su (student
    // number); without them the action 404s on this install.
    let url = joinUrl(this.origin, dy)
    if (!/layout=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'layout=default'
    const su = await manager.readSu()
    if (su && !/su=/.test(url)) url += '&su=' + encodeURIComponent(su)
    const state = await manager.open(url)
    if (cat) {
      // Dropdown categories (通识必修/选修、专业课程、认定型) need their
      // parent toggle opened before the sub-item is clickable.
      const toggle = DROPDOWN_TOGGLE[cat]
      if (toggle !== undefined) {
        await manager.clickSelector(`ul#nav_tab > li:nth-of-type(${toggle}) > a.dropdown-toggle`)
        await manager.wait(400)
      }
      const sel = CATEGORY_SELECTOR[cat]
      if (sel) await manager.clickSelector(sel)
      // 仅少数类别（跨类等）弹「主修/辅修/学院/专业」面板：检测到才执行
      await manager.wait(900)
      await this.maybeSelectDimension(manager)
    }
    return state.url
  }

  /** Some categories gate the grid behind a 主修/辅修/学院/年级/专业 panel;
   *  delegate to the manager's dimension flow (主修 + default 学院/年级 + 专业
   *  by index until 「选定」 succeeds). */
  private async maybeSelectDimension(manager: BrowserManager): Promise<void> {
    if (!(await manager.hasSelector('button#btn_cnfrm'))) return
    await manager.dimensionFlow(0)
  }

  /** 搜索引擎 tab: fill the search form and run 查询教学班. */
  async searchCourses(
    manager: BrowserManager,
    opts: { keyword?: string; weekday?: string; time?: string; category?: string; college?: string; onlyFree?: boolean } = {},
  ): Promise<void> {
    await this.openCourseCenter(manager, '搜索引擎')
    const fill = async (id: string, value: string | undefined): Promise<void> => {
      if (value) await manager.type({ frame: 0, selector: '#' + id }, value)
    }
    await fill('cxnr_1_cx', opts.keyword)
    await fill('xingq_1_cx', opts.weekday)
    await fill('sjd_1_cx', opts.time)
    await fill('kclb_1_cx', opts.category)
    await fill('kkxy_1_cx', opts.college)
    if (opts.onlyFree !== undefined) {
      await manager.click({ frame: 0, selector: 'input#cx_ylcx' })
    }
    await manager.click({ frame: 0, selector: 'button#btn_cxjxb' })
  }

  /** Parse EVERY course/教学班 table in the grid into structured rows; keeps
   *  per-row frame/ordinal targets so submit/cancel can locate the button. */
  async planCourses(manager: BrowserManager): Promise<CourseRow[]> {
    const tables = await manager.readAllTables()
    return this.tablesToRows(tables)
  }

  private tablesToRows(tables: Array<{ frame?: number; ordinal: number; headers: string[]; rows: string[][] }>): CourseRow[] {
    const rows: CourseRow[] = []
    const targets: Array<{ frame: number; ordinal: number; row: number }> = []
    for (const t of tables) {
      const map = headerMap(t.headers)
      for (let i = 0; i < t.rows.length; i++) {
        const cells = t.rows[i]!
        rows.push({
          index: rows.length,
          code: cellAt(cells, 'code', map),
          name: cellAt(cells, 'name', map),
          credits: cellAt(cells, 'credits', map),
          teacher: cellAt(cells, 'teacher', map),
          time: cellAt(cells, 'time', map),
          location: cellAt(cells, 'location', map),
          capacity: cellAt(cells, 'capacity', map),
          enrolled: cellAt(cells, 'enrolled', map),
          pending: cellAt(cells, 'pending', map),
          status: cellAt(cells, 'status', map),
        })
        targets.push({ frame: t.frame ?? 0, ordinal: t.ordinal, row: i })
      }
    }
    this.rowTargets = targets
    this.lastTable = targets.length > 0 ? { frame: targets[0]!.frame, ordinal: targets[0]!.ordinal } : undefined
    return rows
  }

  /** 遍历当前类别全部课程：逐门展开折叠的课程卡片→读教学班→翻页，全量汇总。
   *  手风琴页面一次只显示一张教学班表，必须逐门点击展开才能读全。 */
  async crawlCourses(manager: BrowserManager, cat?: string): Promise<CourseRow[]> {
    if (cat !== undefined) await this.openCourseCenter(manager, cat)
    const tables = await manager.crawlGrid()
    // crawlGrid 返回 {course, headers, rows}（无 frame/ordinal）：按表序重建成
    // 普通表结构；submit 行目标依赖 findRowAction 的页内定位，无需原 ordinal。
    return this.tablesToRows(tables.map((t, i) => ({ frame: 0, ordinal: i, headers: t.headers, rows: t.rows })))
  }

  /** Click the row's 「选课」 action by plan-row index. */
  async submitCourse(manager: BrowserManager, rowIndex: number): Promise<boolean> {
    const t = this.rowTargets[rowIndex] ?? (this.lastTable ? { frame: this.lastTable.frame, ordinal: this.lastTable.ordinal, row: rowIndex } : undefined)
    if (!t) return false
    const selector = await manager.findRowAction(t.frame, t.ordinal, t.row, '选课')
    if (!selector) return false
    await manager.click({ frame: t.frame, selector })
    return true
  }

  /** Click the row's 「退课」 action by plan-row index. */
  async cancelCourse(manager: BrowserManager, rowIndex: number): Promise<boolean> {
    const t = this.rowTargets[rowIndex] ?? (this.lastTable ? { frame: this.lastTable.frame, ordinal: this.lastTable.ordinal, row: rowIndex } : undefined)
    if (!t) return false
    const selector = await manager.findRowAction(t.frame, t.ordinal, t.row, '退课')
    if (!selector) return false
    await manager.click({ frame: t.frame, selector })
    return true
  }

  /** Open 「学生课表查询」 and return the course names it lists. */
  async verifySchedule(manager: BrowserManager): Promise<string[]> {
    const url = joinUrl(this.origin, '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508')
    await manager.open(url)
    const table = await manager.readTable()
    if (!table) return []
    const map = headerMap(table.headers)
    return table.rows
      .map((cells) => cellAt(cells, 'name', map))
      .filter((name) => name.length > 0)
  }
}

/** Simple time slot overlap check on planned rows (HH:MM-ish tokens). */
export function conflictsBetween(rows: readonly CourseRow[]): Array<[number, number]> {
  const token = (time: string): string[] => (time.match(/\d{1,2}[:：]\d{2}/g) ?? []).slice(0, 2) as string[]
  const interval = (tokens: string[]): [number, number] | null => {
    if (tokens.length < 2) return null
    const toMin = (s: string): number => {
      const [h, m] = s.split(/[:：]/).map(Number)
      return (h ?? 0) * 60 + (m ?? 0)
    }
    return [toMin(tokens[0]!), toMin(tokens[1]!)]
  }
  const iv = (row: CourseRow): [number, number] | null => interval(token(row.time))
  const out: Array<[number, number]> = []
  for (let i = 0; i < rows.length; i++) {
    const a = iv(rows[i]!)
    if (!a) continue
    for (let j = i + 1; j < rows.length; j++) {
      const b = iv(rows[j]!)
      if (!b) continue
      if (a[0]! < b[1]! && b[0]! < a[1]!) out.push([i, j])
    }
  }
  return out
}