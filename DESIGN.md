# DSH 选课助手插件 —— 详细设计（草案 v0.2 · 浙大定向）

> 目标：在 DeepSeek Harness（DSH）Web 应用中内嵌一个真实浏览器视图，Agent 通过工具自由操控该页面、读取课程信息，并在用户确认后自动完成选课。
> 范围：目标系统为**浙江大学本科选课系统**（`https://zdbk.zju.edu.cn/jwglxt/`，青果/KINGOSOFT 教务网络管理系统）；适配器机制保持可插拔，其他学校后续可接入。
> 定位：**正常选课、无延迟要求**。浙大选课为多轮次 + 志愿制（有抽签），不存在"抢点"概念；本插件不设计抢课/并发刷课机制。
> 状态：设计评审稿。P0/P1 里程碑验收标准见「里程碑」一节。

---

## 1. 目标与非目标

### 目标
- DSH Web GUI 内有一个「浏览器面板」：显示真实 Chromium 的实时画面，用户可以直接看到并手操（登录、验证码、扫码）。
- Agent 获得一套浏览器工具：导航、读取页面（结构化快照而非截图猜）、点击、输入、执行 JS、等待、截图。
- Agent 能解析课程列表为结构化数据，做时间冲突检测，生成选课方案，在审批后自动执行，最后校验「我的课表」。
- 登录态长期保留（独立浏览器 profile），验证码 / 短信 / 扫码等人类环节自动降级为「由用户在面板中手动完成，Agent 轮询等待」。
- （浙大定向）每次选课前先读当期《选课安排通知》（`xwck_ckLoginNews.html`），拿到轮次/时间/规则后照章执行；规则随学期变化无需改代码。

### 非目标（v1 不做）
- 不做抢课/并发刷课：浙大志愿制、无延迟要求，按正常节奏一次完成，仅保留简单重试（重试前征求用户同意）。
- 不做用户真实浏览器（Chrome 扩展 / CDP 接管用户浏览器）——列为备选方案的对比见第 3 节，v1 采用插件自带的独立浏览器。
- 不存储任何账号密码；凭证只存在于浏览器自身的登录态中。

---

## 2. 总体架构

```
┌─────────────────────────── DSH 宿主进程 (Node) ───────────────────────────┐
│ dsh-course-assistant (bundle 插件)                                          │
│  ├─ browser 服务 (BrowserManager)                                          │
│  │    └─ Playwright (chromium) 单例，persistent user-data-dir (每个会话隔离)│
│  ├─ 工具层 (ctx.tools.register)                                            │
│  │    ├─ 浏览器原语: browser_open/snapshot/click/type/select/check/         │
│  │    │              evaluate/wait/screenshot                               │
│  │    └─ 课程层 (基于 adapter): course_plan / course_targets /              │
│  │                            course_submit / course_verify                 │
│  ├─ CourseSystemAdapter 接口 + generic 实现（按学校可插拔）                   │
│  ├─ 会话事件（SessionEventMap 声明合并，模型可见 ⇒ 落日志）                    │
│  └─ WebSocket 通道: CDP Page.startScreencast 帧流 + 输入事件回传             │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  JSON-RPC / WS / 工具调用 / 事件流
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ DSH Web GUI 客户端 (React, slots)                                            │
│  ├─ shell.overlay 面板: 浏览器镜像视口 + 工具栏（地址栏/刷新/登录状态灯）        │
│  ├─ conversation.input.dock 条目: 状态条（当前步骤/审批待办/待人工介入）＋开面板 │
│  ├─ sidebar.footer.action 条目: 快速开/关                                        │
│  └─ CourseTable store: 候选课程表、冲突标记、方案勾选、执行结果                │
└───────────────────────────────────────────────────────────────────────────────┘
```

产物形态：一个独立插件仓库（`dsh.bundle`），通过 `dsh plugin --profile web add <本地路径>` 安装；含 Node 半部 + 浏览器半部（`dsh.client` 行）。

---

## 3. 关键设计决策（ADR 简表）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **不直接 iframe 嵌入选课系统**，改用「可插拔浏览器提供器」：本地 Chromium 镜像（默认）或用户真实浏览器（扩展/CDP 桥） | 教务系统普遍带 `X-Frame-Options` / CSP `frame-ancestors`，iframe 被拦截；即便嵌入，跨源 iframe 无法读取/操作 DOM，登录态也跨域不可达 |
| D2 | **同源代理方案（proxy + 重写）列为不采纳** | SPA 教务系统（Angular/Vue + 多主机 API）重写成本高、脆弱；登录 cookie 落到 DSH 自身 origin，等于把学生凭证暴露给应用栈，安全不可接受 |
| D3 | **操控走 Playwright/CDP 而非纯 DOM 注入** | 真实浏览器行为一致（JS、Cookie、验证码、防爬指纹），工具层拿到的是可检索的 DOM 快照，模型不必靠截图猜测 |
| D4 | **面板用 shell.overlay（root-scope list） + compose dock 条目打开** | `ui-layout` 的 `root` 已声明 `shell.overlay`（list），`ui-conversation` 声明 `conversation.input.dock`（list）；第三方插件用 `ctx.slots.inject(...)` 注册条目是官方路径（`ui-goal` GoalBar 即模板） |
| D5 | **用户手动操作与 Agent 工具调用共享同一命令队列，串行执行** | 避免「Agent 正在点选课时用户拖动了页面」产生竞态；所有输入经 CDP `Input.dispatch*` 转发，天然可排队 |
| D6 | **登录阶段只能人工完成（面板操作），Agent 只轮询状态** | 验证码/短信/扫码/二步验证无通用自动化；人工在镜像里完成，Agent 检测已登录后继续 |
| D7 | **模型可见 ⇒ 会话日志事件**（对齐 DSH 铁律） | 解析出的课程表、方案、结果都是模型可见输入，通过插件声明合并扩展 `SessionEventMap`，回放可重建 |
| D8 | 高风险工具声明 `ask` 审批 gate，走 `ctx.approval` | `tools` 管道原生支持 `{ gate: { kind: 'ask', reason } }`；执行前 GUI 弹审批，失败即拒绝 |
| D9 | 不设计"抢点/高并发"路径；重试简单、需用户再确认 | 用户明确无延迟需求；正常节奏，默认最多 3 次重试、间隔 5 秒起，重试前征求同意；`retry` 走 `Config` |
| D10 | **浏览器提供器做成可插拔 seam**：`local`（自包含 Playwright，默认）与 `external`（用户真实浏览器：扩展/CDP 桥，对齐 lum1104/dsh-browser、Kimi-WebBridge）可切换；GUI 统一为**侧边栏式可停靠面板**（非全屏 overlay），镜像定位于观察、不承载精细交互 | 镜像视口在输入法、拖拽验证码、多开场景上手体验差；真实浏览器登录态现成、所见即所得，但扩展权限面大、依赖桌面环境；两种提供器共用同一组工具/服务/快照协议/审批流，正交开发 |

---

## 4. 插件形态与安装

```
course-selector-assistant/
  package.json          # name: dsh-course-selector；dsh.bundle → cordis.patch.yml
  cordis.patch.yml      # 插件行：host 半部 + (dsh.client 浏览器半部行)
  tsconfig.json
  src/
    node/                 # Node 宿主半区 @入口（默认 export）
      apply.ts            # 聚合：services / tools / events / ws
      services/browser-manager.ts
      services/screencast.ts (CDP 帧流 + 输入回传)
      services/adapter-registry.ts
      adapters/generic.ts + school/xxx.ts
      skills/course-planning.ts    # 随插件捆绑的选课技能（注册接口 + 内容常量，内容后续完善）
      tools/browser/*.ts    # 9 个原语工具（各自一个文件）
      tools/course/*.ts     # 课程层 4 个工具
      events/session-events.ts  # SessionEventMap 声明合并
    client/               # 浏览器半区（dsh.client 行）
      index.ts            # apply(): slots.inject 注册 dock/overlay/footer
      slots.ts
      BrowserOverlay.tsx / BrowserViewport.tsx / CourseTable.tsx / StatusStrip.tsx
      stores/courseStore.ts (createCourseStore 工厂)
    tests/
  README.md
```

安装方式（本地开发）：
```sh
pnpm --filter <repo> build   # 或独立仓库自建
dsh plugin --profile user add ./course-selector-assistant
```
平台要求：插件声明依赖 `playwright`（chromium 作为 node_modules 局部依赖，参照社区 anweat/dsh-browser 的做法，允许"复用全局复用"回退），避免污染宿主。

**新生友好安装承诺（P0 验收纳入）**：
- 内核零下载优先：默认 `browserEngine: auto` 探测链 Edge → Chrome → 内置 chromium——新生 Windows 机器几乎必带 Edge，等于**无额外下载**；只有两者皆无才触发 `browser_install` / 提示（对齐 xylt369 的探测链）。
- 安装收敛为一条命令（`dsh plugin --profile user add <name>`，UI 内也可装），并提供图文教程（含截图）；不要求用户装 Chrome/扩展/开发者模式。
- 登录零门槛：默认 `windowVisibility: visible`，新生在镜像/本机窗口里完成一次登录（账号+密码+验证码），登录态存入持久 profile，之后免登录。

---

## 5. 宿主（Node）半区设计

### 5.1 BrowserManager 服务（`ctx.course.browser`）
- 生命周期：插件加载时惰性拉起（首次工具调用或面板打开），卸载时优雅关闭并保存 profile。
- **提供器抽象（D10）**：`BrowserProvider` 接口，两种实现——`local`（本地 Playwright，默认；对齐 anweat/dsh-browser 的运行时装）与 `external`（用户真实浏览器：Chrome 扩展或本地桥 + CDP，对齐 lum1104/dsh-browser、Kimi-WebBridge）。工具、服务方法、快照协议、审批流不感知提供器差异；`external` 只把快照/命令换成经本机回环的扩展协议。P0 只实现 `local`。
- 内核：默认 chromium（插件局部依赖，全局复用回退，参照 anweat/dsh-browser）；`browserEngine` 可切换为复用系统已装 Edge（参照 xylt369/dsh-browser 的 headed Edge 提供器，免下载）。
- 会话隔离：每个 dsh session 一个 `browserContext`（persistent context，`userDataDir = <插件数据目录>/profiles/<sessionId>`）。同 session 复用，跨 session 不共享 cookie。
- 生命周期细化（对齐 xylt369）：惰性启动、单例复用、窗口被关自动重开一次、`ctx.effect` 卸载时关闭；页面包装采用"每次工具调用新建 wrapper、底层复用同一 page"；三态窗口 `windowVisibility: visible|hidden|headless`（visible 便于人工登录/调试，headless 用于自动化与 CI）。
- **文件卫生**（对齐 lum1104 报告结论 8）：一次选课会产生大量截图与临时状态——截图经 durable attachment 引用后即清理临时文件；插件数据目录独立命名空间（`course-selector/`），截图/会话有大小上限与定期清理，不与用户工作区混放。
- 命令队列：所有页面操作（工具调用 + 用户输入回传）进入单一 FIFO 队列，互斥执行，避免竞态（D5）。
- 目标 origin 白名单：`Config.targetOrigin`（默认空 = 需人工确认首次导航）；非白名单跳转提示人工确认，防钓鱼链。
- 心跳与掉线恢复：CDP/WS 断连自动重连；页面崩溃自动 reload 并广播事件。

### 5.2 工具集（两层）

**浏览器原语层（通用，任何网页可用）**

| 工具 | 作用 | 关键输入 | 审批 |
|---|---|---|---|
| `browser_open` | 打开/导航页面，等待 `load+settle` | `url` | 非白名单首次 ask |
| `browser_snapshot` | 返回结构化「编号交互清单 + 正文摘要 + 表单字段」快照（含 delta、预算裁减、敏感掩码，见快照协议） | `delta?`, `region?` | — |
| `browser_click` | 按快照 id 点击元素（单击/双击） | `ref`, `dbl?` | — |
| `browser_type` | 聚焦输入框输入文本（清空/追加） | `ref`, `text`, `clear?` | — |
| `browser_check` | 勾选/取消 checkbox/radio | `ref`, `checked` | — |
| `browser_select` | 下拉选择 | `ref`, `valueOrLabel` | — |
| `browser_evaluate` | 在页面上下文执行受限 JS（无网络、超时、大小上限） | `expression` | **默认不注册**（`config.evaluate=true` 才注册）；注册后默认 ask（对齐 xylt369） |
| `browser_wait` | 等待条件：selector / 文本 / 网络idle / 固定时长 | `for`, `timeout` | — |
| `browser_screenshot` | 截图（返回字节或保存路径） | `format`,`fullPage?` | — |

**课程层（调 adapter，绑定业务）**

| 工具 | 作用 | 审批 |
|---|---|---|
| `course_plan` | 按 adapter 读取开课列表 → 结构化课程表（名称/教师/时间/教室/容量/已选/余量/冲突标记）推入面板与日志 | — |
| `course_targets` | 维护本次选课目标清单（课程名/编号/优先级/学分要求），供 plan 与冲突检测使用 | — |
| `course_submit` | 对某候选课程点击「选课」；adapter 定位行内操作 → 处理确认弹层 → 返回结果 | `ask`（reason 含课程名） |
| `course_verify` | 读取「我的课表」核对是否入选，返回 diff | — |
| `course_status` | 报告浏览器/登录/最近动作状态（供 UI 状态条） | — |

**元素寻址协议**：快照给每个可交互元素分配**会话内稳定 `refId`**（可访问性树 / DOM 路径 + 标签属性合成，避免每次快照漂移），并**同时输出该元素的稳定 CSS selector**（对齐 anweat/dsh-browser 的 selector 输入）。点击/输入工具的参数接受 `ref` 或 `selector` 二选一：模型有快照时用 refId，手动/回放时可直接给 selector。`browser_evaluate` 是唯一逃生舱且默认审批。

**快照协议（编号清单式，对齐 Lum1104/dsh-browser 的成熟做法）**：`browser_snapshot` 输出固定结构——`url/title/ready` + 正文摘要 + **编号交互清单**（每项：序号 index（会话内稳定）、ref、CSS selector、文本、状态；模型可直接写 `[7] button "立即选课"` 这样的引用）+ 表单字段（说明/类型/必填/值，**敏感值恒显 `••••`**）＋ **delta 模式**（默认只回 `changed/removed/reindexed` 增量，需要全量再不带 delta 重调）＋ 截断记账（`truncated` 告知被裁剪部分）。预算由配置给（`snapshotMaxChars` 默认 12000、正文占一半；`maxInteractiveItems` 默认 60），三方协商（配置→服务→面板）。所有页面文本返回前包一层带随机 nonce 的 `<UNTRUSTED_PAGE_CONTENT>` 围栏，防提示注入。**寻址优先级**：序号 index → a11y ref → CSS selector。

### 5.3 屏幕输出通道（面板实时性）

- 首选：CDP `Page.startScreencast`（JPEG 帧，服务端聚合为 WS `binary` 帧推给客户端，带宽可接受；帧率 2–5 fps，可配）。
- 备选：Playwright MCP 的本地查看器页面（若复用其工具），或低频轮询 `page.screenshot()`（保底）。
- 输入回传：面板鼠标/键盘事件 → CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`（经命令队列入队，D5）。
- 客户端按需开启（面板打开才推流），节省资源。

### 5.4 会话事件（SessionEventMap 声明合并，仅模型可见的落日志）

| 事件名 | 载荷摘要 | 为何需要 |
|---|---|---|
| `course.session.navigated` | url, title, loginState | 回放重建当前页面上下文 |
| `course.planned` | 解析出的课程表行（去敏感：不包含个人凭证） | 模型决策输入，必须可重建 |
| `course.submitted` | courseId, outcome | 执行事实落日志 |
| `course.verified` | 入选列表 diff | 结果事实 |
| `course.failed` | 失败码（needs-login/page-error/user-cancelled） | 触发人工介入/简单重试 |

（纯 UI 的“正在截图、推流帧”不进日志，符合 DSH “如何画不落日志”规则。）

### 5.5 配置（`Config` 字段，全部在 cordis.yml 可调）

| 字段 | 默认 | 说明 |
|---|---|---|
| `targetOrigin` | 空 | 允许自动导航的 origin 白名单（首访需人工确认） |
| `userDataDir` | 插件数据目录 | Chromium profile 位置（持久登录态） |
| `headless` | false | 隐藏窗口（true 时纯屏幕流） |
| `browserEngine` | `auto` | `auto`（默认：**Edge→Chrome→内置 chromium 探测链**，零下载优先，对齐 xylt369）\| `chromium`（强制局部依赖内核）\| `system-edge` |
| `provider` | `local` | 浏览器提供器：`local`（自包含 Playwright，默认）\| `external`（用户真实浏览器扩展/CDP 桥，对准 lum1104） |
| `windowVisibility` | `visible` | 窗口模式：`visible`（人工登录/调试）\| `hidden`（最小化移出屏幕）\| `headless`（CI） |
| `snapshot` | `{maxChars:12000, maxItems:60, mainRatio:0.5}` | `browser_snapshot` 预算（对齐 lum1104；面板/服务三方协商） |
| `viewport` | 1280×900 | 视口尺寸 |
| `navTimeoutMs` | 30_000 | 导航超时 |
| `screencast` | `{enabled:true, fps:3}` | 面板推流 |
| `retry` | `{maxAttempts:3, baseIntervalMs:5000}` | 正常节奏的简单重试（无抢点需求；重试前需再次确认） |
| `course` | `{maxConcurrentSubmits:1, verifyAfterMs:8000}` | 业务参数 |
| `adapter` | `zju-jwglxt` | 目标学校适配器（首版为浙大） |

### 5.6 浙大目标系统画像与适配器（`zju-jwglxt`）

**平台事实（2025-2026 学年核实；每轮选课前仍以当期通知为准）**
- 系统：青果（KINGOSOFT）「教务网络管理系统」，路径统一前缀 `jwglxt`；浙大本科选课入口 `https://zdbk.zju.edu.cn/jwglxt/`，选课安排通知发布在 `xtgl/xwck_ckLoginNews.html`。同类高校（中南民族大学、江苏建筑职院等）公开的学生选课操作手册结构一致，可作适配参考。
- 登录：本校账号 + 密码 + 图形验证码（部分环境走统一身份认证/扫码）；登录态为服务端会话，关闭浏览器或长时间无操作后失效，需重新登录。
- 选课模块 `xsxk`：课程列表一行一门，含课程编号（kch）、课程名称（kcmc）、学分（xf）、教师/时间/地点、容量与已选数等列；行内「选课 / 退课」操作，点击后进入确认流程。
- 选课规则：多轮次（预选 / 正选 / 退补选），部分课程按志愿、抽签决定结果；公共外语、体育等课程另有分班与规则。**每轮的时间与规则从当期《选课安排通知》读取，不写死在代码里。**

**适配器职责（`adapters/zju-jwglxt.ts`）**

| 方法 | 职责 |
|---|---|
| `detectLogin(page)` | 由 URL 与页面特征判定：未登录 / 已登录 / 会话过期 |
| `openCourseCenter(page)` | 经菜单定位「学生选课」入口（青果以功能模块代码 gnmkdm 组织，动态发现） |
| `parseCourseRows(page)` | 当前课程列表按表头映射为结构化行：kch/kcmc/xf/教师/时间/地点/容量/已选/可选状态；兼容分页 |
| `submitCourse(page, rowRef)` | 点击行内「选课」→ 处理确认弹层 → 返回结果 |
| `cancelCourse(page, rowRef)` | 退课（同样走确认流程） |
| `verifySchedule(page)` | 读「我的课表 / 选课结果」页，返回已选课程集合与结果 diff |

**实现原则**：页面路径、列名、按钮一律从真实 DOM 动态发现（`browser_snapshot` / `browser_evaluate`），不硬编码接口名；P1 由人工在面板里完整走一遍「登录 → 选课 → 退课 → 查看课表」，把 DOM 与网络交互实录为适配器基准则（fixture 化，不触碰个人数据）。

### 5.7 对 dsh-browser 族的公开借鉴（优先参考）

社区已有三个 `dsh-browser` 相关实现（[anweat/dsh-browser](https://github.com/anweat/dsh-browser)（npm `@anweat/dsh-browser`）、[xylt369/dsh-browser](https://github.com/xylt369/dsh-browser)（npm `dsh-tool-browser` / `dsh-browser-control` / `dsh-playwright-browser`）、[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser)（npm `dsh-chrome`））。本设计优先对齐它们的公开架构；anweat 已精读本地源码核实，xylt/lum 源码精读中，逐条补入。

#### 5.7.1 anweat/dsh-browser（源码已核实，`third-party/anweat/dsh-browser`）

**形态**：单包插件；`export const name/inject/Config/apply`；`ctx.provide('browser', service)` + `ctx.effect(() => () => service.close())`；工具用 `@deepseek-ai/dsh-tools` 的 `defineTool({ name, description, parameters, output: { schema, render }, timeoutMs, isConcurrencySafe, execute })` 注册。

**工具（9 个，名字即事实）**：`browser_open`（返回 URL/标题/可读文本/截图路径）、`browser_click`（**CSS selector 点击**）、`browser_type`（fill）、`browser_scroll`（触发懒加载）、`browser_read`（不截图读状态）、`browser_screenshot`、`browser_close`、`browser_status`（chromium 是否就绪/当前页）、`browser_install`（`playwright install chromium` 一键补内核）。

**关键实现**：惰性单例浏览器 + 一个持久 page（多步交互）；`storageStatePath`（`playwright codegen --save-storage` 产物）**复用已登录会话**；内核 chromium 共享缓存 `%LOCALAPPDATA%\ms-playwright`（缺失时 `browser_install`/`autoInstall`），`channel: chromium|msedge` 可切系统 Edge；快照目录默认 `$DSH_HOME/data/browser/snapshots`；`isConcurrencySafe: () => false` 保证串行。

**采纳到本设计**：服务+工具的插件形态、`defineTool` 注册写法、`browser_install`/`browser_status` 助手、`channel`+`executablePath`+`autoInstall` 配置、storageState 登录态复用（作为 user-data-dir 之外的备选/导出通道）、串行执行标记。**不采纳**：纯 CSS selector 寻址（对青果表格页太脆）、无审批门控、无 GUI 面板/镜像（本设计要求）。

**工具命名对齐表（本设计 ⇐ anweat）**

| 本设计 | 对齐 anweat | 差异 |
|---|---|---|
| `browser_open` | `browser_open` | 同 |
| `browser_snapshot` | （无；`browser_read` 只给纯文本） | 新增：结构化 DOM/A11y 快照，元素带 refId+CSS selector |
| `browser_click` | `browser_click` | 参数 `ref` 或 `selector` 均可 |
| `browser_type` | `browser_type` | 同 |
| `browser_select` | 无 | 新增（下拉） |
| `browser_scroll` | `browser_scroll` | 同 |
| `browser_wait` | 无 | 新增（条件等待） |
| `browser_evaluate` | 无 | 新增，受限 + 默认 ask |
| `browser_screenshot` | `browser_screenshot` | 同 |
| `browser_close` | `browser_close` | 同 |
| `browser_status` | `browser_status` | 同 |
| `browser_install` | `browser_install` | 同 |

#### 5.7.2 xylt369/dsh-browser（源码已核实，`third-party/xylt369/dsh-browser`）

**五包结构**：`@yeesy369/dsh-browser`（服务定义：`ctx.browser` 抽象缝）＋ `dsh-browser-playwright`（Provider：Edge/Chrome/内置 chromium 自动探测、`launchPersistentContext` 持久 profile、三态窗口、stealth 补丁）＋ `dsh-tool-browser`（Consumer：8 个 `browser_*` 工具，`browser_evaluate` 默认关闭）＋ `dsh-web-permission`（在 `tools/pre-execute` 瀑布挂**权限门**：`ask` 走 dsh 原生 `ctx.approval`，allowed-once 后把 host 写入 dsh-settings 的 web-permission `allowHosts`，持久化 `$DSH_HOME/settings.yaml` 热生效）＋ `dsh-browser-settings`（GUI 设置侧栏：webServer 挂 `GET/POST /dsh-browser-settings/config` 读写 profile 配置；client 经 `slots.inject` 挂 `sidebar.footer.action` + `shell.overlay`；**无 screencast / 无 iframe**）。

**SSRF 权威实现**（`dsh-browser-playwright/src/url-guard.ts`）：scheme/凭据检查 → hostname 黑名单 → IPv4/IPv6 私网字面量分类 → `lookup all:true` **先解析后校验**（防 DNS rebinding）；`allowPrivate:false` 硬编码不可配。

**A11y 寻址**：`ariaSnapshot({mode:'ai'})` 产出 `[ref=xx]`，正则抽取到运行时共享 refs，`browser_click` 按 `/^[a-z][a-z0-9]*\d+[a-z0-9]*$/i` 或已知 refs 路由到 `locator('aria-ref=…')`，否则按 CSS。`browser_evaluate` 无真正沙箱（默认关闭 + 30s 工具超时 + JSON 可序列化）。

**采纳**：①权限门"允许即持久化"的模型（写进 §8：`allowHosts` 持久化到 settings 命名空间）；②url-guard 的"resolve-then-validate"SSRF 算法（§8 照搬）；③ariaSnapshot 生成 ref 的轻量路径（比手写 A11y 树省事）；④Provider 的"内核探测 + persistent context"。**不采纳**：evaluate 无沙箱裸奔（我们要受限 + 默认 ask）。

#### 5.7.3 Lum1104/dsh-browser（源码已核实，`third-party/lum1104/dsh-browser`）

**架构**：Chrome MV3 **侧栏扩展**（操作端，有完整对话 UI 与审批弹窗）⇄ 本地 WebSocket 桥（`/ext/bridge`，回环 + 扩展 Origin 免 token、非回环需 256-bit token）⇄ dsh 桥插件（`@deepseek-ai/dsh-bridge-browser`，注入 `webServer/apiProxy/tools`）⇄ 模型。全程纯文本、无截图：模型通过**编号清单**操作真实页面。

**快照协议（对我们的直接模板）**：三层摘要而非 DOM/A11y 树——正文（readability 式）+ **编号交互清单**（`[7] button "立即选课"`）+ 表单字段（密码/卡号永不离开页面，固定 `••••`）；配套 `snapshotMaxChars=12000`/`maxInteractiveItems=60` 预算、三分法截断记账、delta 模式（changed/removed/reindexed）、`<UNTRUSTED_PAGE_CONTENT nonce>` 围栏防提示注入。元素寻址 = `(frame, documentId, index)` 稳定语义编号，批准后执行前**重查文档**防"确认与执行之间页面已变"。

**审批纵深**：桥认证（回环 + Origin 白名单）+ 写操作 **fail-closed**（deny/allow-once/**trust-session**/always-allow-reads）+ 30s 超时自动拒绝 + 撤销时撤回挂起审批；只操作活动标签页，绝不静默切页。

**采纳**：① 快照协议整体升级（§5.2）：编号清单 + delta + 预算裁减 + 掩码 + 围栏；② (frame,index)+documentId 寻址与"批准后重查"（§5.2/§8）；③ 桥认证与 fail-closed 审批（§8）；④ 会话卫生（延迟建会话、专属 workspace、清理）借鉴到我们的插件数据目录规范（§5.1）。**采纳**：① 快照协议整体升级（§5.2）：编号清单 + delta + 预算裁减 + 掩码 + 围栏；② (frame,index)+documentId 寻址与"批准后重查"（§5.2/§8）；③ 桥认证与 fail-closed 审批（§8）；④ 会话卫生（延迟建会话、专属 workspace、清理）借鉴到我们的插件数据目录规范（§5.1）。**不采纳**：依赖用户真实浏览器与扩展分发、写操作逐次人工弹窗（其报告自承"每次点击都卡人不适合需要策略层的自动化"——我们的选课执行改成"策略层 + 高危动作审批"）。

### 5.8 选课指导技能：随插件捆绑的注册接口（正文后续完善）

选课助手不只是执行选课：还要帮用户**分析课程该怎么安排**（读培养方案/通知 → 冲突与学分/前置分析 → 时间规划 → 选课策略 → 执行 → 复盘）。技能**随本插件捆绑**：装插件即获得技能，不单独安装、不依赖外部目录。

- **注册方式**（对齐 `packages/skill/skill` 的 runtime 注册，`ctx.skills.register`）：

  ```
  name:        course-planning                   （kebab-case，跨会话稳定）
  description: 指导选课的规划与分析：读培养方案/选课通知，做时间冲突、
               学分/前置约束分析，输出可执行的选课方案 （≤120 字符路由描述）
  whenToUse:   用户询问选课安排/课程规划/时间冲突/学分要求/备选课时，
               或进入 course_plan → course_submit 流程时
  invocation:  缺省 = 模型/用户双可调用
  source:      'runtime'（插件 apply() 中注册，卸载即消失）
  content:     正文放 src/node/skills/course-planning.ts 常量（或捆绑 md 内联），
               本版先放占位正文，后续版本填入完整内容——接口不变
  ```

- **内容大纲（接口为它预留，正文后续填写）**：
  1. 读引导：读当期《选课安排通知》＋ 用户提供的培养方案/学业要求，确认约束（学分上限、必修/选修、轮次与志愿规则）；
  2. 采集：`course_plan` 取课程列表并结构化（时间/教师/容量/余量）；
  3. 分析：时间冲突、周学时负荷、前置与后续课关系、容量风险、志愿轮次策略；
  4. 方案：候选课表 + 冲突报告 + 风险标注 → 用户勾选确认；
  5. 执行与校验：依序 `course_submit`（审批）→ `course_verify` 读「我的课表」核对；
  6. 回执：输出选课摘要（课程、时间、学分、风险备注）。
- **职责边界**：技能只在提示词层编排 `course_*`/`browser_*` 工具与冲突检测服务（§5.2/§7），不新增平台机制；正文完全可替换，不影响工具与审批。
- **P0 验收**：插件安装后技能目录可见 `course-planning`（正文为占位文案），`skill` 工具可加载；后续填正文不需要动接口。

---

## 6. 客户端（浏览器）半区设计

### 6.1 挂载点与面板形态（侧边栏式，可停靠，D10）

挂载点（均已在 DSH 客户端确认存在）：
- `ctx.slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'course-selector', … }, SidebarAction))`
  —— 侧边栏底部开关，常驻入口。
- `ctx.slots.inject('conversation.input.dock', () => …({ name: 'conversation.input.dock', id: 'course-status', order: 60, … }, StatusStrip))`
  —— dock 状态条：登录态/当前步骤/待人工介入/提供器模式（local\|external）。
- 面板主体：`shell.overlay`（root-scope list）注册的**约 1/3 宽侧边面板**（可停靠、可折叠），非全屏；标题栏含地址栏、后退/前、刷新、登录态灯、「用系统浏览器打开」按钮；下方为课程表 + 执行状态。

### 6.2 组件树与状态流

```
BrowserSidePanel（可停靠侧栏，约 1/3 宽）
 ├─ Toolbar: 地址栏/后退/前/刷新/登录灯/「用系统浏览器打开」/折叠
 ├─ ViewMode:
 │    ├─ 镜像（provider=local）  ← screencast WS，低帧率观察为主，
 │    │                          轻交互（点击/输入）也可经 WS 回宿主命令队列
 │    ├─ 控制台（provider=external）: 无镜像，仅快照要点 + 打开按钮，
 │    │                             Agent 操作发生在用户真实浏览器
 │    └─ 课表: 订阅 course.planned → 表格（冲突标记/勾选/结果）
StatusStrip: 当前选课步骤、等待人工登录/审批、执行反馈、提供器模式
SidebarAction: 开关图标
```

### 6.3 镜像在外的策略（回应"镜像好用吗"）

- 镜像只读观察为主，Agent 抓取与点击走工具层（CDP/快照），不依赖用户在镜像中精细操作。
- 需要人工精细交互的场景（拖拽验证码、复杂表单）：面板提供「用系统浏览器打开」一键跳到真实浏览器（local 模式下在系统默认浏览器打开同一 URL），或直接切 external 提供器在真实 Chrome 中操作；完成后再由 Agent 恢复快照继续。
- 面板打开时才推流，帧率 2–3 fps 可配；用户无感时自动暂停推流（仅保留状态灯）。

### 6.3 store（`createCourseStore` 工厂，唯一的跨组件状态）

- `courseRows[]`（来自 `course.planned` 事件的投影）、`selectedIds`（用户勾选）、`plan`（冲突检测后建议）、`submitProgress`、`lastError`。
- 只存共享交互态；浏览器帧与会话数据都留在对象层，不走 store。

### 6.4 「面板即浏览器」的交互细则

路线说明：「面板即浏览器」不是把用户浏览器镶进面板，而是插件自己的 Chromium 跑在 DSH 宿主内，**面板是它的实时观察窗 + 遥控器**。

- **两条操作通道，共用同一个页面**（都走命令队列，D5）：
  1. **可见窗口**（默认 `windowVisibility: visible`）：真实独立 Chromium 窗口，原生输入法、拖拽、扫码、原生粘贴全可用——**登录/密码/拖拽验证码阶段用它**，体验等同普通浏览器；窗口里的操作 Agent 下一命令自然接得住（同 profile 同页面）。
  2. **面板轻交互**（screencast 镜像 + CDP 事件回传）：鼠标点击、方向键/Enter、滚动可用，够日常点选/勾选；非标准键盘与输入法在镜像里受限，遇到复杂输入切可见窗口。
- **工具栏**：后退/前进/刷新/停止；地址栏展示当前 URL（编辑需过导航审批）；登录态灯；「在系统浏览器打开当前页」兜底按钮（放弃控制权换原生便利，用于异常情况的最后手段）；镜像折叠态仅显示状态条。
- **弹窗与新窗口策略**：`window.open` / 新标签 → 面板提示，默认在可见窗口打开，Agent 后续经快照重取；页面 `alert/confirm`、下载等系统级对话框 → 可见窗口处理（headless 模式注入自动接受/取消，避免卡死）。
- **面板三视图联动**：镜像视图（观察）＋ 课表视图（`course.planned` 渲染为可勾选表格、冲突标红）＋ 快照视图（当前编号清单文本，可在面板直接点选某个 `[n]` 触发 Agent 点击）。每次工具执行，状态条回显（如 `已点击 [7] button "立即选课"`）。
- **结束即清**：会话关闭/任务完成 → 停镜像流、清理临时文件；persistent profile 保留登录态（可配置保留时长或手动清除）。

### 6.5 客户端插件守则对齐

- 组件仅消费四份 props（runtime/render-slots/store/inject），不碰 ctx、不自行订阅外部源（面板帧订阅走 injected hooks compartment，宿主 WS 由注入回调提供帧）。
- 事件只读当前 event；不扫描会话全文。

---

## 7. 选课工作流（状态机）

```
idle ─(用户说"选课"/点面板)─▶ logging(未登录→等人工) ─▶ browsing ─▶ planning
planning ─(course_plan：先读当期选课通知拿到轮次/规则)─▶ planned ─(冲突检测+evaluate)─▶ proposed
proposed ─(用户勾选+确认)→ awaitingApproval ─(course_submit, ask 审批)─▶ executing
executing ─(course_verify)─▶ verified/done    失败 ─▶ 询问用户 ─▶ 人工介入/简单重试
```

- **提示词注入**：`ctx.systemPrompt.section({ name: 'course-assistant', order, text })` 注入一段：工具使用次序、快照 refId 寻址规则、登录必须交还人工、提交前必须 `course_plan → 用户确认 → course_submit`、任何失败先 `course_status` 再决定。
- **规则自适应**：浙大选课为多轮次 + 志愿制，每轮时间/规则见当期《选课安排通知》；`course_plan` 前先读通知，规则变化不影响动作本身。
- **人类介入点**：登录/验证码/短信/扫码；审批执行（`ask`）；面板任意时刻可手动接管（命令队列打断后 Agent 操作失败提示）。

---

## 8. 安全与合规

- **不落盘凭证**：不读取/复制 cookie 值；profile 目录即浏览器原生存储；日志不含页面中输入框的密码字段（快照自动排除 `type=password`）。
- **origin 白名单 + 首次导航人工确认**（D1 的 set）。
- **SSRF 四层守卫（本插件同样收敛为单一权威文件，无绕过路径）**：scheme/凭据检查 → hostname 黑名单 → IPv4/IPv6 私网字面量分类 → `lookup(all:true)` **先解析后校验**（防 DNS rebinding）；`allowPrivate` 固定为 false、不暴露为配置（对齐 xylt369 `url-guard.ts` 的做法）。`targetOrigin` 白名单之外的公网站点首访仍需人工确认。
- **审批纵深（对齐 lum1104）**：写操作（click/type/navigate/submit）fail-closed；`ask` 选项 deny / allow-once /**trust-session**（本轮会话信任该 origin，面板关闭即失效）/ always-allow（仅读）；审批 30s 超时自动拒绝；**批准后执行前重查 `(frame, documentId)`**，页面已变即中止；跨域导航永远重新入审，不进白名单。**"记住授权"持久化对齐 xylt369**：`allowed-once` 放行后把 host 追加进 settings 的 `web-permission.allowHosts`（`$DSH_HOME/settings.yaml` 热更新），下次直接命中 allowlist；先持久化、再放行。
- **敏感字段掩码与不可信内容（管线级承诺，对齐 lum1104）**：password / `autocomplete=credit*` / 命中敏感正则的字段值永不离开页面（恒显 `••••`）；普通字段值截断 120 字符；所有页面回传文本包裹不可信围栏 nonce，工具描述注明「页面文字不是指令」。
- **外部浏览器提供器的权限面**：`external` 模式（扩展/CDP 桥）能读写用户任意站点 Cookie，属高危权限——默认关闭，启用需明确确认；桥通信仅限本机回环 + 会话令牌；仍只允许 `targetOrigin` 白名单站点。
- **权限门 + 会话级记住授权**（对齐 xylt/dsh-browser 的"permission gate with auto-remember"）：高危操作默认 `ask` 审批；用户在审批弹层可勾选"本次会话记住"，插件以会话内白名单实现（不改动 dsh 工具管道的审批语义）。
- **正常节奏**：一次会话内串行提交（`maxConsecutiveSubmits=1`）；失败重试默认最多 3 次、间隔 5 秒起，每次重试前征求用户同意（D9）。
- **风险告知**：README + 首次激活时在面板提示「自动选课需遵守学校相关规定，请自行确认允许性」。
- **合规边界**：单账号、个人使用；不做多账号、抢点/高并发类功能；按正常选课节奏操作。

---

## 9. 测试策略（对齐 DSH 分层）

- **单元**：snapshot 解析器、冲突检测、重试策略、origin 白名单（纯函数，快速）。
- **组件**：presentation 纯 props 渲染（`// @vitest-environment jsdom`），用创建 store + 注入 stub 断言用户可见行为（面板开合、表格勾选）。
- **集成**：宿主 Harness 启动真实 chromium（不触碰真实教务 API，用本地静态 html fixture 作为「假教务系统」），跑一次 `course_plan → course_submit → course_verify` 快照（keyless）。
- **产物快照**：遵循 DSH snapshot 惯例，fixture 在 macOS/Linux 可回放。
- **不覆盖**：真实学校系统的真实接口（无账号无法自动化、且不合规）。

---

## 10. 里程碑与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 骨架**（3-5 天） | bundle 可安装；local 提供器（BrowserManager：惰性启动/三态窗口/持久 profile）；原语 open/snapshot/click/type/status；**编号快照协议（delta+掩码+围栏）**；**权限门 `tools/pre-execute` + `allowHosts` 持久化（对齐 xylt369）**；侧边栏面板（镜像观察 + 命令回传）；状态条 | 安装后可用自然语言让 Agent 打开任意公网页面并快照；权限门能 ask/deny 且"记住"生效；visible 模式下面板可人工登录；Agent 快照内容与页面一致 |
| **P1 适配**（2-4 天） | 浙大 `zju-jwglxt` 适配器；`course_plan` 结构化输出；课程表面板 | 用 mock fixture 先行：Agent 能读取完整开课表并结构化成表格展示；连真机后（人工登录）同样通过 |
| **P2 决策与执行**（1 周） | 冲突检测、方案推荐、`course_submit`（ask 审批）、简单重试、`course_verify` | 在 fixture 上全流程：计划 → 审批 → 执行 → 校验通过；失败路径有明确日志与人工介入提示 |
| **P3 打磨** | 多适配器拆分、断线恢复、推流质量、文档 | 无已知崩点；README 与 Model Experience 完整 |

---

## 11. 已知风险与开放问题

- **学校系统差异**：浙大已确认是青果 `jwglxt` 的志愿制选课；仍以当期页面与 DOM 为准，适配器按 5.6 动态解析、不硬编码接口名。
- **验证码 / 会话**：图形验证码与统一身份认证的短信/扫码无法自动化，必须由用户在面板手动完成；服务端会话可能随时失效，Agent 检测后停下并提示重新登录。
- **访问条件**：`zdbk.zju.edu.cn` 可能要求校园网/VPN 环境，或登录时段限制；无法访问时 Agent 报告环境问题而非盲目重试。
- **`browser_evaluate` 的权限边界**：默认 `ask`，纳入审批流水线。
- **多入口冲突**：若 `conversation.input.dock` 被第三方占用同一 id（如 terminal 之类），用唯一前缀 `course-selector-*` 规避（`order` 冲突只影响顺序，不影响可用性）。

---

## 12. 参考

- 浙大选课（定向资料）：选课安排通知（[bksy.zju.edu.cn 教学运行](https://bksy.zju.edu.cn/2025/0519/c76672a3052207/page.htm)，[zdbk 教务系统新闻原文](https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_ckLoginNews.html?doType=save&xwbh=3572A0DE05937A1DE0630BA6CA0AC354)）、[图灵班选课指南](https://turing2025.tonycrane.cc/course_selection/)、[工试学长组选课资料](https://zju-enginpilot.github.io/Kickstart/Study/CourseSelection/)、[新生选课报道（澎湃）](https://www.thepaper.cn/newsDetail_forward_31458913)
- 社区 DSH 插件（架构对照）：[anweat/dsh-browser](https://github.com/anweat/dsh-browser)（npm `@anweat/dsh-browser`：自包含 Playwright 运行时 + browser 服务 + 9 工具）、[xylt369/dsh-browser](https://github.com/xylt369/dsh-browser)（npm `dsh-tool-browser`/`dsh-browser-control`/`dsh-playwright-browser`：Edge 提供器 + SSRF 导航 + a11y 点击 + 权限门）、[giiiiiithub/terminal](https://github.com/giiiiiithub/terminal)（host+browser 面板骨架）、[MicroHEROX/dsh-Kimi-WebBridge](https://github.com/MicroHEROX/dsh-Kimi-WebBridge)（CDP 桥）、[jiayan-xu/dsh-nuphus-mcp](https://github.com/jiayan-xu/dsh-nuphus-mcp)（CDP+OCR）、[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser)（npm `dsh-chrome`，浏览器扩展方案）
- 抢课脚本（青果系统及其他教务接口参考）：[NJUClassGrabber](https://github.com/TheFunny233/NJUClassGrabber)、[ustc_course_selector](https://github.com/Kobe972/ustc_course_selector)、[SUSTech-tis-cheater](https://github.com/vollate/SUSTech-tis-cheater)、[ecust-choose-lesson](https://github.com/Mo-llor/ecust-choose-lesson)、[YNU-xk_spider](https://github.com/davidwushi1145/YNU-xk_spider)、[auto-class-hitwh](https://github.com/finger-bone/auto-class-hitwh)
- LLM 浏览器 Agent 生态：browser-use（[MCP 版](https://github.com/wenpingwu001/mcp-browser-use)）、[Playwright MCP](https://github.com/microsoft/playwright-mcp)
- DSH 平台机制：`packages/core/tools`（`ask` 审批 gate）、`packages/core/system-prompt`（section）、`packages/client/ui-slots`（slot 系统）、`packages/client/ui-layout`（`shell.overlay`）、`ui-conversation`（`conversation.input.dock` / `details`）、`.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md`（slot 标准）