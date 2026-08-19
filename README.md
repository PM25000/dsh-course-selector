# dsh-course-selector · 浙江大学选课助手

<p>
  <img src="https://img.shields.io/badge/dsh-bundle-4B32C3?logo=deepseek" alt="dsh bundle">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg" alt="Windows | macOS">
  <img src="https://img.shields.io/badge/status-early%20access-yellow.svg" alt="early access">
</p>

> 目标系统：浙江大学本科教学管理信息服务平台 `https://zdbk.zju.edu.cn/jwglxt/`（**正方**实现，页面底部有"技术支持：正方软件股份有限公司"）。
> 定位：正常选课、无延迟要求；不设计抢课/并发机制（浙大志愿制随机筛选，无需抢序）。
> 架构与决策详见 [`DESIGN.md`](DESIGN.md)；浏览器实现参考社区 [`anweat/dsh-browser`](https://github.com/anweat/dsh-browser)、[`xylt369/dsh-browser`](https://github.com/xylt369/dsh-browser) 与 [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser)。

## 🎓 学生使用说明

这个插件让选课更直观、更好选，不需要懂代码。装好后在 DSH 里打开「选课助手」即可：

1. **打开选课系统**：点面板里的「选课」，浏览器会带你去浙大选课中心；若提示登录，用统一身份认证登录一次即可。
2. **看各科教学班**：在选课中心切「本类/跨类/通识/体育/搜索引擎…」浏览课程，点开某门课展开它的教学班。
3. **评分一眼可读**：每位教师名字旁会显示评分徽章——
   - `⭐9.8` = 查老师有评分（红色高分、深蓝低分）；
   - `★无评分` = 数据里暂无；
   - 多位教师的教学班**各自带各自的评分**（一人一行）。
4. **点评分直达查老师**：点 `⭐` 会在新标签打开该教师在查老师的评价页。
5. **让 AI 帮你规划**：把想选的几门课告诉助手，它会列出各教学班的教师/评分/节次/地点/余量，做时间冲突核对，给出**无冲突的推荐组合**——**只给建议，绝不代你点选课**。
6. **最后亲手选**：选课窗口期，按推荐的「教学班」在系统里点「选课」即可（余量/待定窗口期才有真实值）。

> 合规提醒：只操作自己账号、正常频率浏览；不要用第三方刷课/抢课——浙大是志愿制随机筛选，无需抢序。

---

## 结构

```
package.json            dsh.bundle（cordis.patch.yml）+ dsh.client（web）+ peerDeps(optional)
cordis.patch.yml        bundle patch：向 profile 插入一行插件
tsdown.config.ts        node ESM(lib/index.js) + browser CJS(lib/client.js, __ModuleLoader__.load)
tsconfig.json           独立配置（tsdown/编辑器）
tsconfig.typecheck.json 严格 typecheck（extends 仓库 base + 指向构建产物 paths）
src/node/               Node 宿主半区
  index.ts              入口：browser 服务 + browser/course 工具 + 权限门 + 镜像端点 + 技能注册
  config.ts             Config（schemastery）与默认值
  deps.ts               playwright 解析（插件局部 → 全局复用回退）
  browser-manager.ts    local 提供器：持久 context、编号快照(iframe感知)、表格/行动作/所选名校、
                        CDP screencast + 截图兜底、tab 模块页偏好
  mirror.ts             /course-selector/{open,status,mirror.jpg,digest,click,dim,menu,open-url,
                        open-preview(可达/拒嵌探测),rating-url(读/写评分站地址),
                        rating-data-url(读/写数据JSON地址),ratings(摘要/刷新)}
  url-policy.ts          URL 规范化门控（scheme 黑名单/host:port/loopback）+ XFO·CSP 嵌入性探测
  permission.ts         tools/pre-execute 权限门（SSRF + ask + 高危工具审批）
  tools.ts              browser_open/snapshot/click/type/status
  tools-course.ts       course_* 领域工具已移除（course_plan/search/rating/verify）；选课规划统一走 browser 工具 + course-planning skill
  adapters/zju-jwglxt.ts  类别映射、dimensionFlow、搜索、表格解析、提交定位
  ratings.ts            查老师评分客户端（JSON 探测+缓存+按名匹配，参 Lazuli）
  skills/course-planning.ts  随插件捆绑技能（正文含浙大适配与合规纪律）
scripts/                rebuild-offline.mjs（爬实时站重建）/ merge-teachers.mjs（新旧合并，新优先）
src/client/             Web 客户端半区（侧边栏开关 / 状态条 / 右浮层面板 + 镜像+工具栏）
```

## 构建

```sh
cd dsh-course-selector            # 项目根目录
npm install --legacy-peer-deps   # 本机 devDeps（tsdown/typescript/@types/node）+ playwright；@deepseek-ai/* 由 dsh 宿主提供
npm run typecheck                # tsc --noEmit -p tsconfig.typecheck.json（对仓库构建产物类型）
npm run build                    # tsdown → lib/index.js（node ESM）+ lib/client.js（browser CJS factory）
```

产物：`lib/index.js`（宿主，`@deepseek-ai/*`、`playwright` 外部导入）+ `lib/client.js`（浏览器半区，经 `window.__ModuleLoader__.load({id, factory})` 注册，react 外部化）。
宿主改动需重启 dsh；客户端改动仅刷新页面即可（rev 变化）。

## 离线评分数据维护（发布前/依需）

内置教师评分锚定 `data/teachers.json`（`npm run build` 时拷贝进 `lib/data/teachers.json`）。定期用实时站刷新：

```sh
# 1) 从实时查老师站重建当前在册教师（新评分/打分人数/id，断点续爬、低间隔尊重站点）
node scripts/rebuild-offline.mjs                # 见脚本内 --max/--interval/--from-id 等选项

# 2) 新旧合并：新数据优先，历史下架教师由旧库补齐（按姓名对齐，输出仍是 data/teachers.json）
node scripts/merge-teachers.mjs --old ../Lazuli/data/default.json

# 3) 打进 lib 并重启/强制刷新使生效
npm run build
```

- 说明：实时站教师 id 与 Lazuli 同空间（1~10739），但当前在册仅约 4373（大量历史 404）；合并后约 9732（新 4373 优先 + 旧补 5359）。页面 ⭐/★、评分链接（`评分站/t/<id>/`）与 `course_rating` 均消费这份数据。
- 若面板评分站地址改过，`rebuild-offline.mjs` 会优先读已保存的 `rating-url.json`；也可 `--base` 显式指定。

## 安装到 dsh（web profile）

```bash
dsh plugin --profile web add ./dsh-course-selector   # 或 .（在本仓库根目录）
dsh --profile web   # web profile 关闭 HMR，装完需重启
```

安装后：侧边栏底部「选课助手」开关、聊天输入框上方状态条、右侧浮层面板（地址栏/登录灯/镜像/“打开选课系统”按钮）；技能目录可见 `course-planning`（正文已随插件注册）。

## 已实现/验证

- [x] bundle 打包（`dsh.bundle` + `dsh.client`）；link 方式安装到本机 web profile 实测加载
- [x] 宿主：本地浏览器（engine auto 探测 Edge→Chrome→内置；visible/hidden/headless；持久登录态 profile）
- [x] 实名登录检测（URL init_menu/login 特征），无权时频道轮询
- [x] browser_* 工具：open/snapshot/click/type/status/tabs/use_page/crawl/**login_wait**（阻塞等登录拿 {loggedIn,url,su}；快照 iframe 帧编号 + href/attrs + 按帧点击；use_page 显式选页）；**browser_crawl 为 DOM 语义读行**（crawlGridSem：教师=行内 `<a>`、节次/地点/余量=行内特征，不靠列索引——分类页/搜索页/大班次通用，全量行不被快照截断）
- [x] 权限门（SSRF 防护 + 首访 ask + 高危工具审批 + allow-hosts.json 持久化）
- [x] 镜像：CDP screencast + 遮挡时截图兜底（画面始终实时）、页面切换自动重定向
- [x] 面板：三处挂载 + 工具栏 + “打开选课系统”+ **画面/课表视图切换**；默认页逻辑：无页面时已登录直达选课中心、未登录回 zdbk 根（/open）
- [x] **URL 门控 + 可达性探测**（参 DSH-better-sidebar）：`url-policy.ts` 移植其 `normalizeUrl`（scheme 黑名单/host:port 判定/loopback 拒绝，接入 open-url/rating-url 保存）；新增 `/course-selector/open-preview` 打开前探 status/XFO/CSP frame-ancestors 给出可达/拒嵌原因
- [x] **课表预览**：课表视图 = 周一~周日×节次网格（冲突标红、带评分）+ 明细；数据来自 `/course-selector/plan`（最近一次 course_plan/search 的行）
- [x] **页面评分注入**（Lazuli 同款，实测含搜索页）：`injectRatings` 两步（页内收集→`frame.evaluate(真函数, arg)` 协议传参），MutationObserver + 巡逻（遍历所有标签，任一 /xsxk/ 即接管并注入）自动续挂；`course_plan/search` 后触发；`/course-selector/inject` 手动。徽章三态：`⭐9.8`（有分）/ `★无评分`（数据缺失）/ 尾列难度；**⭐ 为可点链接**（`<a target=_blank rel=noopener>` → `评分站/t/<id>/`，新标签打开查老师教师页；无 id 教师链回首页）。修复：isHeadRow 判前 `String(x)`（防搜索表非字符串崩）、教师列用行内首个 `<a>` 定位（表型无关）
- [x] **N进1 选中难度**（course_plan/search 输出）：adapter 表解析新增 `pending` 列（所有/本专业待定），工具用 余量/待定 → `N 进 1 · 容易/不易/难/极难`（余量 0 → 无法选中）；页面注入仍以 ⭐/无评分 + 难度兜底为主
- [x] **教师评分（零配置）**：内置离线数据集随插件打包（`lib/data/teachers.json`，发布前重建）；面板仅保留「评分站」地址输入（域名常变只改这里）；`course_rating(teacher?)` 高分榜/检索、离线无名自动实时站内查；`course_plan/search` 行尾附 `⭐评分`
- [x] **ZJU 适配器**：菜单发现（data-gnmkdm/data-dyym）、自动补 `&layout=default&su=`、类别切换（直接 / 下 拉预展开 / 跨类维度面板 dimensionFlow）、课程表全量解析（readAllTables + 表头关键词映射）
- [x] 领域工具：`course_plan(cat)`、`course_search(keyword/星期/节次/类别/学院/只看未满)`、`course_verify`、`course_rating`、`course_submit(row)`（仅用户确认后、走审批；会话默认只建议不代操作）
- [x] **全类别遍历**（手风琴适配）：`course_plan/course_search` 现在会**逐门展开该类别折叠的课程卡片**读教学班并自动翻页（`manager.crawlGrid`：listCards/expandCard/nextPage），一次返回该类别全部课程行；`/course-selector/crawl` 可手动触发
- [x] course-planning 技能正文（读通知/采集/冲突与学分分析/无冲突推荐模板/只建议不代操作/通用实测经验/合规）
- [ ] 权限持久化迁移到 settings 命名空间（当前 allow-hosts.json）——P0.6
- [x] **离线评分数据维护**（已提供·依需重跑）：`scripts/rebuild-offline.mjs`（爬实时站）+ `merge-teachers.mjs`（新旧合并、新优先）→ `npm run build`（用法见正文「离线评分数据维护」；首次执行已产出 9732）
- [ ] 选课窗口期（8/24 起）真实 course_plan/submit 全链路复核——窗口开启时

## 浙大适配记录（实测，2026-08）

### 站点事实
- 登录：统一身份认证，登录态服务端会话；超时回 `login_slogin`，需人工重新登录。
- 菜单壳在 iframe（zoom 包裹）；模块以 `data-gnmkdm` + `data-dyym` 提供；模块 URL 必须带 `&layout=default&su=<学号>`，缺失时 404。
- 表格列：教师|学期|上课时间|上课地点|…|余量/容量|操作；国际化/循环补充班额外有 `男/女(余量/容量)`、`本专业待定人数`、`所有待定人数`。
- 教学班唯一键：`button.xuanke[data-xkkh]`（如 `(2026-2027-1)-PPAE0018G-0013079-1`），提交参数。
- 每学期规则以「选课安排通知」为准（四轮：预选随机筛选、预置课优先、改选重筛；学分上限等见技能正文）。

### 类别行为差异
| 类别 | 表现 | 适配 |
|---|---|---|
| 跨类(专业) | 先弹 主修/辅修/学院/年级/专业 面板，「选定」后才出课 | `dimensionFlow`（选主修+默认维度+按序试专业、处理"请选择专业!"警告重试） |
| 通识必修/选修、专业课程、认定型 | 下拉类，需先展开父级；点开直出网格 | `DROPDOWN_TOGGLE` 预展开（通识必修=3、认定=8 已验） |
| 体育/国际化/循环补充班 | 直出网格 | 普通网格解析 |
| 荣誉/补考/研究生 | 无课（空态） | 正常返回空 |
| 搜索引擎 | 独立检索表单（50 门上限、只看未满） | `course_search` |

## 安全基线（P0 起保持）

- 导航只接受 http/https，拒绝私网/回环/本地 host（SSRF）；公网站点首访 ask；`targetOrigin` 自动放行。
- 高危动作强制审批（当前 RISKY_TOOLS 为空——`course_submit` 已移除，只建议不代操作）；权限“记住”持久化 allow-host.json（settings 迁移待做）。
- 快照对敏感输入掩码；登录凭据不落盘（浏览器 profile 原生保存）。
- 浏览器 evaluate 不暴露为模型工具；开发用的 click/dim/digest 端点仅宿主内部、只在目标站点触发。
- Playwright 产物与截图落在 `$DSH_HOME/data/course-selector/`，便于清理。

---

## Contributing

欢迎贡献。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)：遵守合规（不做抢课/刷课）、URL 门控、权限门，跑通 `npm run typecheck && npm run build`。

## License

[MIT](LICENSE) © dsh-course-selector contributors