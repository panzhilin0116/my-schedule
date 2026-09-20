# 个人日程管理系统 · 开发计划（第一版）

版本：v2.0
日期：2026-09-20
依据：`PRD.md` v2.0（唯一开发依据）。旧云端版计划已存档为 `DEV_PLAN_v1存档.md`。

---

## 0. 技术选型（先定，后续阶段全部遵守）

| 维度 | 选型 | 理由 |
|---|---|---|
| 框架 | **无框架，原生 ES Module** | PRD 无后端、无构建需求；本机无 npm，避免引入打包链 |
| 语言 | 原生 HTML + CSS + JavaScript（`.js`，`type="module"`） | 直接浏览器运行，零编译 |
| 渲染 | 手写轻量虚拟：每视图一个 `render(state)` 返回 DOM，通过 `lib/dom.js` 的 `h()` 辅助建节点 | 无框架也能保持"数据→视图"单向 |
| 路由 | 自实现 Hash 路由（`#/`、`#/timetable`、`#/tasks`） | PRD §2 要求 Hash 路由 |
| 数据存储 | 课表/校历=内置常量；日程=`localStorage['schedule.tasks.v1']` | PRD §1、§5 |
| 样式 | 单个 `styles.css` + CSS 自定义属性做主题令牌；断点仅 `640px` | PRD §2 |
| 构建 | **无**。源文件即产物 | 本机无 node 生态 |
| 本地预览 | `node.exe dev/serve.mjs`（静态文件服务器，见 S0） | 本机唯一可用解释器 |
| 单元/渲染测试 | `node.exe --test v2/tests/*.test.mjs`（Node 内置 test runner，DOM 用桩） | 无 npm 依赖 |
| 部署 | 复用现有 Qoder 站点，发布 `v2/` 为站点根 | PRD §2「沿用现有站点」 |
| 浏览器验证 | browser-use MCP（截图 + snapshot + `element.click()`） | 见项目记忆：预览标签页隐藏，只能用 element.click() |

> 本机约定：PATH 无 `node`。所有命令用
> `NODE="/c/Users/34118/AppData/Local/OfficePLUSAgent/resources/runtime/node.exe"`（Node v24）。
> 不要 `npm install`、不要新建 `package.json`、不要加构建步骤。

**目录约定**：新代码全部落在 `v2/`，与旧云端 `web/ functions/ schema/` 物理隔离，互不引用。

```
v2/
  index.html
  styles.css
  main.js                 # 入口：装载 config、启动 router
  data/
    semester.js           # 校历常量（周起算日、教学周区间、节次作息表）
    courses.js            # 12 条课程常量数组
  lib/
    time.js               # 周次/节次/日期计算（纯函数）
    store.js              # localStorage 读写 + 校验 + storage 事件订阅
    dom.js                # h()、clear()、格式化等 DOM/文本小工具
    router.js             # hash 路由
    feedback.js           # toast（含撤销）、modal/drawer 浮层原语
  views/
    home.js
    timetable.js
    tasks.js
  components/
    taskForm.js           # 新建/编辑日程浮层表单（home/tasks 共用）
    courseDetail.js       # 课程只读详情浮层
    emptyState.js         # 空态/骨架/错误态占位组件
  tests/
    time.test.mjs
    store.test.mjs
    render.test.mjs       # 三视图渲染断言（DOM 桩）
dev/
  serve.mjs               # 零依赖静态服务器（新增，仅本地预览用）
```

---

## S0 · 脚手架与本地预览

**依赖**：无（起点）
**交付物**：一条命令能在浏览器打开空壳页面。

需创建文件：
- `dev/serve.mjs` — 读 `process.argv[2]` 为端口，默认 `5173`；按扩展名返回 `v2/**` 的静态文件，正确设置 `Content-Type`（`.js`→`text/javascript`、`.css`→`text/css`）。仅用 `node:http`、`node:fs`、`node:path`。
- `v2/index.html` — `<head>` 内 viewport/theme-color/link，`<body>` 内放置骨架容器：`#rail`（桌面顶导航）、`#topbar`、`#view`、`#tabbar`（手机底导航）、`#modal-root`、`#toast-root`，末尾 `<script type="module" src="./main.js">`。
- `v2/main.js` — 暂只 `console.log('boot')` 并 import 后续会补的 router（先注释占位）。
- `v2/styles.css` — 定义主题令牌 `:root{--bg:#070B14;--panel:#0E1524;--line:#1E2B45;--cyan:#3DD6F5;--orange:#FF8A3D;--green:#4ADE80;--mono:ui-monospace,...}`、`--bp:640px` 相关基础布局、等宽数字 `font-variant-numeric`。

**完成标准**：
1. `"$NODE" dev/serve.mjs 5173`（后台运行）后浏览器访问 `http://localhost:5173/` 返回 index.html，控制台打印 `boot`，无 404、无 MIME 报错。
2. `styles.css` 令牌可被引用（页面底色为 `#070B14`）。

---

## S1 · 数据层与时间计算（纯函数，无 UI）

**依赖**：S0
**交付物**：可被任意视图 import 的常量与纯函数，且通过单元测试。

需创建文件与关键函数：

`v2/data/semester.js`
- `SEMESTER = { week1Monday: '2026-09-07', totalWeeks: 14 }`
- `PERIODS`：14 项 `{ section, start:'08:00', end:'08:45' }`，值取自 PRD §5.1。

`v2/data/courses.js`
- `COURSES`：12 条 `{ day, startSection, endSection, name, room, color }`，逐字段照 PRD §5.2 表；`room` 为空的用 `null`。

`v2/lib/time.js`（全部纯函数，入参显式传 `now:Date` 以便测试）
- `weekOf(date): number|null` — 教学周 1–14，超区间返回 null。
- `isTeachingWeek(date): boolean`
- `weekdayOf(date): 1..7`（周一=1）
- `periodRange(section): {start:Date,end:Date}`（给定日期+节次→起止时刻）
- `coursesOn(date): Course[]` — 按 `day` 过滤，`startSection` 升序；非教学周返回 `[]`。
- `nextCourse(date): {course, at:Date}|null` — 今日中第一节 `end > now` 的课。
- `currentCourse(date): Course|null` — `start<=now<end` 的课。
- `fmtClock(date): 'HH:MM'`、`fmtCountdown(ms): 'HH:MM:SS'`、`fmtDateCN(date): '9月20日 周日'`、`weekLabel(date): '第2周'`
- `dayKey(date): 'YYYY-MM-DD'`、`addDays(date,n): Date`、`diffDays(a,b): number`

`v2/lib/store.js`
- `loadTasks(): Task[]` — 解析 `localStorage['schedule.tasks.v1']`；JSON 非法时抛 `StoreError`（供 S6 错误态捕获）。
- `saveTasks(tasks): void`
- `newTaskId(): string`
- `upsertTask(task): Task[]` / `removeTask(id): Task[]` / `toggleTask(id): Task[]`
- `validateTask(draft): {ok, errors}` — 标题必填、日期必填、起止时间成对（有始必有终且 start<=end）。
- `subscribe(cb): ()=void` — 监听 `window` 的 `storage` 事件（供多标签页同步）。
- `resetStore(): void` — 清空并写入 `[]`。

`v2/lib/dom.js`
- `h(tag, props, ...children)`、`clear(el)`、`mount(el, node)`、`qs(sel)`。

需创建测试：`v2/tests/time.test.mjs`、`v2/tests/store.test.mjs`
- time：覆盖 `weekOf` 边界（9/6→null、9/7→1、9/13→1、9/14→2、12/28→null）、`coursesOn` 对周一/周四/无课日的结果、`nextCourse/currentCourse` 用固定 `now` 断言。
- store：`validateTask` 各非法分支；`upsert/remove/toggle` 往返；`loadTasks` 遇坏 JSON 抛错。

**完成标准**：
1. `"$NODE" --test v2/tests/*.test.mjs` 全绿。
2. `COURSES.length === 12` 且逐条与 PRD §5.2 一致（对应验收 3）。
3. 无任何 DOM 依赖，可在 Node 直接 import。

---

## S2 · 外壳：路由 + 导航 + 主题布局

**依赖**：S0（样式）、S1（`time.js` 供顶栏周次展示）
**交付物**：三页可切换、导航随断点变形、顶栏显示日期+周次。

需创建/补全文件：
- `v2/lib/router.js` — `routes` 表 `{ '#/':home, '#/timetable':timetable, '#/tasks':tasks }`；`start()` 监听 `hashchange`，渲染到 `#view`，未知 hash 回落 `#/`；导出 `navigate(hash)`（供首页跳转日程页定位）。
- `v2/lib/feedback.js` — `openOverlay({title, body, mode})`：桌面居中 Modal(480px)、手机底部抽屉；`Esc`/遮罩关闭；`closeOverlay()`。`toast(message, {actionLabel, onAction, duration=5000})`。
- `v2/components/emptyState.js` — `renderEmpty({icon, text, actionText, onAction})`、`renderSkeleton()`、`renderError({onRetry})`。
- 补 `v2/main.js` — import config，调用 `router.start()`，渲染 `#rail`/`#tabbar` 导航（3 Tab：首页/课表/日程），顶栏 `#topbar` 用 `time.fmtDateCN + weekLabel`。
- 补 `v2/styles.css` — 底 Tab（`<640px` 固定底部、`≥640px` 隐藏）与顶 Tab（`≥640px` 水平、`<640px` 隐藏）互斥显示；内容区 `max-width:960px; margin:auto`；overlay/toast/empty/skeleton 样式。
- 三个 `views/*.js` 先返回占位标题（S3–S5 再实现），保证路由跑通。

**完成标准**：
1. 点导航/改 hash 能在三占位页间切换，当前 Tab 高亮。
2. 顶栏显示 `2026-09-20 周日 · 第2周` 格式（用系统当天）。
3. `375px` 见底部 3 Tab、无顶 Tab；`1280px` 反之。两档均无横向滚动条。
4. `Esc` 与遮罩点击能关闭一个测试浮层。

---

## S3 · 课表模块（只读）

**依赖**：S1（courses/time）、S2（router/overlay）
**交付物**：桌面周网格 + 手机单日轴双布局 + 只读详情浮层 + now 线。对应 PRD §5.4、验收 7/8/9。

需创建/实现文件：
- `v2/views/timetable.js` — `render(state)`：
  - 顶部周次徽标 + 星期胶囊选择器（手机显示，默认选中今天，`←/→` 或横滑切日；桌面隐藏选择器直接铺整周）。
  - 分支：`matchMedia('(min-width:640px)')` → 网格；否则单日轴。
  - 非教学周：顶部横幅「本周无教学安排（第 X 周）」（对应验收 5）。
  - now 线：教学周内按当前时刻定位红色横线，`setInterval` 每分钟刷新（页面 `visibilitychange` 时暂停）。
- `v2/components/courseDetail.js` — `open(course)`：用 `feedback.openOverlay` 展示星期/节次+具体时间/地点/「本学期 1–14 周」；**无任何编辑按钮**（验收 9）。
- 样式：网格 `grid-template-columns: 时间轴 + 7 列`，课程块按 `startSection..endSection` 跨行；单日轴按节次定位色块。

**完成标准**：
1. 桌面 1280px：周一 1-2 节「法国歌剧史与作品赏析」跨两行；周四 11-12 节「综合法语(1)」出现（验收 7）。
2. 手机 375px：默认停今天；切到周二可见 3-5 节「大学计算机基础」跨三行（验收 8）。
3. 点课程块弹只读详情，含四要素且无编辑入口（验收 9）。
4. 教学周外的日期：显示无教学横幅，不渲染课程块。
5. browser-use 在 375 与 1280 各截图一次存档核对。

---

## S4 · 日程模块（增删改查）

**依赖**：S1（store/time）、S2（router/overlay/toast）
**交付物**：分组列表 + 三态筛选 + 新建/编辑浮层表单 + 删除撤销。对应 PRD §5.3、§5.5、验收 10–15。

需创建/实现文件：
- `v2/components/taskForm.js` — `openCreate(onSaved)` / `openEdit(task, onSaved)`：字段 标题*、日期*、开始、结束、地点、备注；失焦即 `store.validateTask` 校验，非法禁用提交；起止成对校验（验收 10、11）。保存调 `store.upsertTask`。
- `v2/views/tasks.js` — `render(state)`：
  - 段控件 全部/未完成/已完成（默认全部）。
  - 分组：逾期 → 今天 → 明天 → 本周内 → 未来（用 `time.diffDays`）；逾期橙条、今日/临近青条（验收 12）。
  - 行：圆圈勾选（`store.toggleTask`，原地不弹层）｜标题+元信息（时间·地点）｜状态点；已完成置灰划线沉组底（验收 14）。
  - 编辑：点行 → `taskForm.openEdit`；手机左滑露删除。
  - 删除：`store.removeTask` + `feedback.toast('已删除…', {actionLabel:'撤销', onAction:恢复})`（验收 13）。
  - 右下悬浮「＋」→ `taskForm.openCreate`；空态用 `emptyState.renderEmpty`，点按钮直开新建（验收 15）。
  - 支持从首页跳转带参定位并高亮某条（读 `router` 传入的 `focusId`）。
- 样式：段控件、分组头、竖条、FAB、左滑。

**完成标准**：
1. 验收 10–15 逐条通过。
2. 刷新页面数据仍在（`localStorage` 持久，验收 1 的日程部分）。
3. 表单校验失败时提交按钮 `disabled`，通过后才写入。
4. render 单测：给定 4 条任务，分组顺序与高亮类名正确。

---

## S5 · 首页模块（今日总览）

**依赖**：S1（courses/time/store）、S2（overlay）、S4（`taskForm` 复用新建浮层）
**交付物**：五区块 + 置灰/进行中/高亮 + 秒级倒计时。对应 PRD §3、验收 4/6。

需实现文件：
- `v2/views/home.js` — `render(state)` 五区块（PRD §3）：
  1. 顶栏日期+周次（S2 已渲染，此处补月历入口按钮，点开只读迷你月历，标记有课/有日程日）。
  2. 下一节 Hero：`time.nextCourse` + `fmtCountdown`，`setInterval` 每秒；无课/已结束文案切换（验收 4、6）。
  3. 今日课程时间轴：`time.coursesOn` + `currentCourse` 标「进行中」青框，已过置灰。
  4. 今日日程：`store.loadTasks` 过滤 `date==今天`，未完成置顶，点圆圈 `toggleTask`。
  5. 临近日程：`明天≤date≤今天+3` 且未完成，按日期分组橙标签。
  - 交互：点今日日程 → `router.navigate('#/tasks')` 并传 `focusId` 定位；「＋」复用 `taskForm.openCreate`。
- 样式：Hero 卡、时间轴、徽标。

**完成标准**：
1. 工作日上午 9:00（可注入 `now` 测）：第二节前置灰、无「进行中」误标、Hero 指向 09:50 课且倒计时跳动（验收 6）。
2. 第 2 周周日：周次「第2周」，无课则 Hero「今日无课」（验收 4）。
3. 首页日程写操作仅"勾选完成"，不新增编辑入口（PRD §6）。
4. 与日程页读同一 `localStorage`，改一处另一处刷新可见。

---

## S6 · 横切健壮性（空态/骨架/错误/跨零点/多标签页）

**依赖**：S3、S4、S5（三页已成形）
**交付物**：PRD §2 全局约定与 §7 第 6/7 条、验收 16/17 落地。

需实现：
- 错误态：`store.loadTasks` 抛 `StoreError` 时，home/tasks 捕获并渲染 `emptyState.renderError({onRetry: 一键 resetStore})`，不白屏（验收 17）。
- 骨架屏：视图切换首帧 `renderSkeleton()`，数据就绪替换（无网络，主要防闪烁/为后续留口）。
- 空态：三页无数据时的引导（课表非教学周、日程空、首页无课无日程）。
- 多标签页同步：`main.js` 调 `store.subscribe`，收到变更事件后重渲染当前视图（验收 16）。
- 跨零点：`document.visibilitychange`→可见时若 `dayKey(now)` 变化，重算并刷新分组/周次（PRD §7.2）。
- 断网可用：确认全程无 `fetch`（构建期 grep 校验）。

**完成标准**：
1. 验收 16：两标签页 A 新建、B 不刷新即见。
2. 验收 17：手工写坏 `schedule.tasks.v1` → 错误态 + 一键重置，无白屏。
3. 三页空态文案与引导按钮齐全。
4. 源码 `grep -R "fetch(" v2/` 无结果（断网可用证据）。

---

## S7 · 响应式打磨 · 浏览器验证 · 发布

**依赖**：S0–S6 全部完成
**交付物**：通过 PRD §9 全部 18 条验收，并发布到现有站点。

需做：
- 全量单测：`"$NODE" --test v2/tests/*.test.mjs` 全绿。
- 四档宽度（360/640/1024/1440）browser-use 截图，逐条走查验收 18：无横向滚动、Tab 不重叠、Modal 不超屏。
- 逐条勾验 PRD §9 的 1–18，记录结果到本文件末尾「验收记录」。
- 发布：用 sites-hosting 流程把 `v2/` 作为站点产物发布到现有站点（`projectId 01a0bc64-...1948`）；发布前需用户确认。
- 手机真机/移动仿真访问线上 URL 复验导航、课表双布局、日程持久。

**完成标准**：
1. PRD §9 十八条全部标注"通过"。
2. 线上站点访问正常，改动经刷新后 `localStorage` 数据保留。
3. 交付说明：更新本文件验收记录 + 简述已知限制（日程不跨设备）。

---

## 阶段依赖图

```
S0 ──┬── S1 ──┬── S3 ──┐
     │        │        │
     └── S2 ──┤        ├── S5 ──┐
             └── S4 ──┘         ├── S6 ── S7
                  └──────────────┘
```

文字版：
- S0 → 一切前提。
- S1、S2 可在 S0 后并行。
- S3 需 S1+S2；S4 需 S1+S2。
- S5 需 S1+S2+S4（复用 `taskForm`）。
- S6 需 S3+S4+S5。
- S7 需 S0–S6 全通过；**发布动作前必须取得用户确认**。

## 里程碑与顺序建议

| 里程碑 | 含阶段 | 可演示结果 |
|---|---|---|
| M1 骨架可跑 | S0–S2 | 三页导航切换 + 顶栏周次 |
| M2 只读课表 | S3 | 双布局课表 + 详情浮层 |
| M3 可写日程 | S4 | 日程 CRUD + 撤销 |
| M4 首页聚合 | S5 | 今日总览 + 倒计时 |
| M5 健壮收口 | S6 | 错误/空态/多标签页 |
| M6 上线 | S7 | 站点发布 + 验收全绿 |

> 每个里程碑结束都停下来给你验收，通过再进下一阶段；未经你确认不写下一阶段的代码、不发布。

---

## 验收记录（2026-09-20，S7 收口）

### A. 单元测试：56 / 56 全绿

```
"$NODE" --test "v2/tests/*.test.mjs"
```

| 文件 | 阶段 | 条数 |
|---|---|---|
| `store.test.mjs` | S1/S4 | 6 |
| `time.test.mjs` | S1 | 8 |
| `shell.test.mjs` | S2 | 7 |
| `timetable.test.mjs` | S3 | 9 |
| `tasks.test.mjs` | S4 | 9 |
| `home.test.mjs` | S5 | 9 |
| `robustness.test.mjs` | S6 | 8 |

### B. PRD §9 十八条：真实浏览器逐项走查，18 / 18 通过

脚本 `.measure/acceptance.mjs`（零依赖 CDP，驱动 headless Edge，只操作自建的 target），`exit=0`。

| # | 验收项 | 实测证据 |
|---|---|---|
| 1 | 新建 3 条，关标签页重开仍在且状态不变 | 新建浮层写入 3 条；新标签页打开后标题、勾选状态、列表条数一致 |
| 2 | 换浏览器/设备看不到同一份日程（声明的边界） | 各模块零网络调用，数据只落本机 localStorage |
| 3 | 课表常量 12 条且字段与 PRD 5.2 一致 | day/节次/名称/地点逐字段相同，两节无地点为 null |
| 4 | 真实今天 2026-09-20（第 2 周周日） | 顶栏「9月20日 周日 · 第2周▦」+ Hero「今日无课」 |
| 5 | 2026-12-28 超 14 周 | Hero「假期中 · 今日无课」，课表横幅「本周无教学安排（第17周）」，课程块 0 |
| 6 | 工作日上午课间 09:40 | 1-2 连堂（至 09:35）置灰、其余未开始、无「进行中」；下一节 09:50 倒计时 `00:10:00 → 00:09:57` 逐秒跳动 |
| 7 | 桌面 1280 课表网格 | 7 列；法国歌剧史 col2 row2/span2；综合法语(1) col5 row12/span2 |
| 8 | 手机 375 课表 | 默认停在今天胶囊；切周二 3 块，大学计算机基础 `grid-row:4 / span 3` |
| 9 | 点课程块 → 只读详情 | 含星期/节次/时间/地点，仅关闭入口，无编辑按钮 |
| 10 | 标题留空 | 刚打开禁用 → 合法启用 → 清空失焦报「标题不能为空」并重新禁用 |
| 11 | 只填开始时间 | 提交禁用 + 提示「开始与结束时间需成对填写」，未写入存储 |
| 12 | 逾期/今天分组配色 | 组序「逾期 (1) / 今天 · 9月20日 周日 (1)」；逾期橙条、今天青条 |
| 13 | 删除撤销窗口 | 5 秒内点「撤销」恢复；超时后列表与存储均无残留、toast 自动收起 |
| 14 | 完成项表现 | 划线（line-through）置灰沉底；切「未完成」只剩另一条 |
| 15 | 空态引导 | 「还没有日程，点右下角记一笔」→ 直接打开「新建日程」浮层 |
| 16 | 双标签页同步 | A 页写入后 B 页未刷新即渲染（storage 事件驱动） |
| 17 | 非法 JSON | 错误态「本地日程数据损坏，无法读取」→ 一键重置回到空态，不白屏 |
| 18 | 四档宽度不破版 | 见 C 表；导航在 640 断点切换，Tab 无重叠，Modal 不超屏 |

### C. 响应式量测：4 档宽度 × 5 种状态

脚本 `.measure/responsive.mjs`（CDP `Emulation.setDeviceMetricsOverride` 精确设定 CSS 宽度，驱动真实 `index.html`），`exit=0`。

| 视口 | 状态 | scrollW−clientW（横向溢出） | 导航形态 | 浮层 |
|---|---|---|---|---|
| 360 | 首页 / 月历 / 课表 / 日程 / 新建 | 0 | 底部 Tab | 月历 360px@0（满宽抽屉）、新建 360px@0 |
| 640 | 同上 5 态 | 0 | 左侧栏 | Modal 480px@80（居中） |
| 1024 | 同上 5 态 | 0 | 左侧栏 | Modal 480px@272 |
| 1440 | 同上 5 态 | 0 | 左侧栏 | Modal 480px@480 |

说明：课表页在 640/1024 下 `innerWidth` 比 `clientWidth` 大 15px，是纵向滚动条占位（12 节次高度超屏），`scrollWidth == clientWidth` 即无横向溢出，属正常。

### D. 已知限制（与 PRD 一致，非缺陷）

1. 日程数据只存在本机浏览器 `localStorage`（key `schedule.tasks.v1`），换浏览器/设备/清缓存即不同步 —— PRD §8 明确第一版不做云同步。
2. 课表为内置常量（12 条），改课需改 `v2/data/courses.js` 并发版，第一版不提供编辑入口（PRD §4/§8）。
3. 不做提醒推送、不做冲突检测、不做多账号（PRD §8）。

### E. 发布状态

**未发布。** 本地开发服务器（`dev/serve.mjs`，端口 5173）验证通过；按 DEV_PLAN.md 与你的要求，发布到站点前需你明确确认。

---

## 功能验收走查（2026-09-20 第二轮，独立于上面 18 条）

第一轮（上面 A/B/C）验的是「PRD 写了什么，代码做到没有」。这一轮换一个立场重做：假设 PRD 本身可能有洞，逐条对照 PRD §2–§7 在真实浏览器里量测，并专门去戳 PRD **没写**的地方（断网、存储写满、XSS、超长文本、手势边界、跨月、焦点、动画叠放）。

脚本：`.measure/audit.mjs`（32 项，CDP 驱动真实 `index.html`，桌面 1280×900 + 手机 375×740 双标签页），耗时约 72 秒。

### 结论摘要

| 严重度 | 数量 | 条目 |
|---|---|---|
| 阻塞性 | 0 | —— 三页可用、数据不丢、不白屏、不破版 |
| 功能性 | 2 | F-1 断网重载不可用；F-2 存储写满时静默失败 |
| 体验性 | 4 | E-1 月历不能翻月；E-2 备注不可见；E-3 首页子块空态太弱；E-4 空态文案与按钮重复 |
| 文档与实现不一致 | 4 | D-1 桌面导航形态；D-2 主题色值；D-3 PRD§9.6 时点自相矛盾；D-4 筛选态跨页保持未定义 |

### 功能性

**F-1 · 断网后刷新/重开就打不开（PRD §7.6「断网可完整使用」不成立）**
CDP 切离线 + `Page.reload(ignoreCache)` → 直接落到浏览器错误页（`#view` 不存在，title 变 `localhost`），`navigator.serviceWorker.controller = null`。
已在屏内的标签页断网仍可正常读写（数据在 localStorage），所以"用到一半断网"没事，但"断网时重新打开"不行。
两条路：① 加一个只预缓存 7 个静态文件 Service Worker（仍然零后端、零接口，不改 PRD 边界）；② 把 PRD §7.6 改成「已加载页面断网仍可用；重新打开需网络」。

**F-2 · localStorage 写满 / 无痕模式：保存静默失败**
把 `setItem` 打成抛 `QuotaExceededError` 后点保存：捕获到未处理异常 `Uncaught QuotaExceededError`，浮层停在原地、没有 toast、列表没变——用户视角是"点了保存没反应"。
PRD §5.3 只定义"数据存哪"，没定义"存不下怎么办"。建议在 `saveTasks` 外面包一层 try/catch，失败时 toast「本机存储空间不足或已被禁用，未保存」。（注意别复用它现在的错误态：写失败≠数据损坏。）

### 体验性

- **E-1 迷你月历只有当前月**，无左右翻月按钮（面板内按钮只有 `✕`）。10 月的日程在 9 月的月历上没有任何提示地不存在；课程标记本身正确（9 月 18 个工作日均标「有课」，日程 2 天标「有日程」，今日格为 2026-09-20）。
- **E-2 备注（note）存了但看不见**：列表行文本只有「带备注」，既不明示也没有「有备注」角标，只有进编辑浮层才能看到——容易让人以为没保存成功。
- **E-3 首页「今日日程」空态是一行裸文字**「今天没有日程」，没有图标/按钮；PRD §2.3.3 要求每页空态含「图标+引导语+主按钮」。日程页合规（`◇` + 引导语 + 按钮）。
- **E-4 日程页空态文案与按钮重复**：`还没有日程，点右下角记一笔` + 按钮 `记一笔`，读起来是"…记一笔 〔记一笔〕"，且文案指"点右下角"而按钮就在眼前。

### 文档与实现不一致（需要你裁决：改 PRD 还是改代码）

- **D-1** PRD §2 与 §7.1 写"桌面（≥640px）顶部水平 Tab"，实现是 **208px 左侧栏**（顶栏内 0 个 Tab，底部 Tab `display:none`）。内容区 `max-width: 960px` 居中 ✓。
- **D-2** PRD §2 的六个 hex（`#070B14/#0E1524/#1E2B45/#3DD6F5/#FF8A3D/#4ADE80`）在 `v2/styles.css` 里 **一个都没有**；实际是你后来定的低饱和液态玻璃 token（`--base #07080f`、`--accent #86c9de`、`--warn #e0a97c`、`--ok #9bd0a6`，描边用半透明白）。→ 应把 PRD §2 视觉段改写成"以 `styles.css` 顶部 token + `design.test.mjs` 契约为准"。
- **D-3** PRD §9.6 说"09:00 打开首页：第二节之前的课全部置灰……下一节卡指向 09:50"。按 §5.1 作息，09:00 正处第 2 节（08:50-09:35）内，而 1-2 连堂 = 08:00-09:35 还在上，所以置灰它等于说谎。实现选择：大标题=09:50 的课 + 倒计时 `还有 00:50:00`（满足"指向 09:50"），同时 kicker 显示"进行中：法国歌剧史…"。行为合理，PRD 措辞需要澄清（建议把时点改成 09:40，或明确"连堂按整块判定"）。
- **D-4** 筛选（全部/未完成/已完成）是模块级状态，离开页面再回来仍保持。PRD 未定义，行为本身可接受，记为待确认。

### 这一轮新验证为"没问题"的部分（第一轮没覆盖）

- 控制台与请求全程干净：桌面+手机各 3 页、月历/新建/课程详情浮层、未知路由 `#/nope`，0 条 error/warning/failed request。
- XSS：标题写 `<img src=x onerror=...>` 按纯文本渲染，未执行、未插入节点。
- 375px 下 100 字无空格长标题：页面与条目内部均无横向溢出（row clientW == scrollW == 339）。
- 表单校验补漏：结束早于开始 → 「结束时间不能早于开始时间」且禁用提交；只填结束时间同样拦截。
- 手势：手机抽屉下拉 >80px 关闭 ✓；单日轴右滑 120px 日→六、左滑切回 ✓（≤40px 不响应）；列表左滑删除阈值 60px 生效（30px 不误删）。
- 焦点：浮层 Esc 关闭后焦点回到 `.fab`。
- Toast 叠放：连续删两条，两个 toast 在流内不重叠、均在屏内（容器底 876/900），各自带撤销按钮；此前一次读到"超出视口 2px"是**后台标签页 CSS 动画被节流**造成的瞬时帧，落位后正常。
- 表格数字：`.hm-course-time`/Hero 倒计时 `font-variant-numeric: tabular-nums`，首字体 `ui-monospace`。
- 课程详情：无地点的「体育(1)」显示 `地点 未指定`，字段齐全（星期/节次/时间/周期），面板内仅 `✕`。
