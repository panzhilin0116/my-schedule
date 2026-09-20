# 开发计划 · 个人日程管理系统 v1

依据：`PRD.md` v1.0（唯一依据）
制定日期：2026-09-20
本文件只规定"怎么做、按什么顺序做、做到什么程度算完"，不修改 PRD 的任何需求。

---

## 一、技术选型与理由

| 项目 | 选择 | 理由 |
|---|---|---|
| 前端 | 原生 ES Module + 手写轻量渲染层，**零构建步骤** | 本机没有独立 Node/npm（仅可借用的裸 node.exe，不带 npm）。装了也能用，但引入 npm + 打包器不会带来任何 PRD 要求的能力，只会增加构建失败面。部署产物要求就是"静态文件 + index.html"，直接手写源码即产物 |
| 路由 | 哈希路由（`#/timetable` 等） | 免服务器 rewrite，刷新与深链都能落到 `index.html`，不依赖 `prepare_site.spa` |
| 状态 | 单一 store 模块 + 订阅式重渲染 | 单页 6 视图、每表 < 500 行，虚拟 DOM 与响应式框架都属多余开销 |
| 图表 | 手写 SVG 元件（进度环 / 柱状 / 环形 / 热力格） | 只有 4 种图形，引图表库会让移动端首屏体积翻倍 |
| 后端 | 一个 `app` Edge Function（Deno + TypeScript），入口 `functions/index.ts` | 平台的唯一服务端形态；浏览器只同源调 `/functions/v1/app` |
| 数据 | 平台托管 Postgres（Supabase 系），schema `app`，7 张表 | 见 PRD 7.2；迁移只能通过平台的受限 DDL 接口执行 |
| 鉴权 | 站点网关非公开模式（PRD 7.1，附注已确认接受该范围） | 不做注册登录 |
| 字体 | 系统等宽 + 系统无衬线栈，**不引外部字体 CDN** | 免外部依赖与阻塞请求 |
| 部署 | `prepare_site` 冻结草稿 → `publish_site` 发布 | 见 PRD 第 8 节 M1 |

本地工具链事实（决定验证方式，不要假设可 `npm install`）：
- node：`C:\Users\34118\AppData\Local\OfficePLUSAgent\resources\runtime\node.exe`（v24.15.0，裸运行时，无 npm）
- python：3.13.15，用作静态服务器
- 无 Deno → `functions/` 的 TS 入口无法本地类型检查，只能在部署后由真实请求验证；handler 的业务逻辑写成 `.mjs`，可用 node 直接跑真实代码

---

## 二、目录结构（一次性定义，后续阶段引用）

```
D:\my_schedule\
  PRD.md                     已存在
  DEV_PLAN.md                本文件
  web\                       webDirectory（源码即产物，无构建）
    index.html               已存在（骨架：starfield / rail / tabbar / topbar / view / modal-root / toast-root）
    styles.css               设计 token、布局、组件、响应式
    app.js                   启动、路由、视图注册、全局快捷键
    lib\
      api.js                 requestJson、ApiError、isWriteOutcomeUnknown、接口封装
      store.js               数据仓库：加载、乐观更新、订阅、失效重取
      time.js                周次/节次/日期/时长/连续天数计算
      dom.js                 h() 建元素、mount()、clear()
      ui.js                  Modal/抽屉、表单字段渲染、Toast+撤销、确认框、骨架、空态、错误态、左滑
      charts.js              progressRing、barSeries、donut、heatGrid
    views\
      home.js  timetable.js  tasks.js  research.js  workout.js  settings.js
  functions\                 functionDirectory（Deno 运行时）
    index.ts                 入口：Deno.serve(serveSite(handleApp, {createClient, env}))
    adapter.mjs              平台提供，**保持原样不改**
    handler.mjs              动作路由 + 方法校验 + 响应封装
    registry.mjs             7 张表的列白名单、逐字段校验器、索引与排序规则
    rules.mjs                跨行规则：级联删除、里程碑自动进度（服务端唯一实现）
  dev\                       本地用，不进任何发布产物
    preview-server.mjs       node 静态服务器 + /functions/v1/app 转发到真实 handler
    fake-supabase.mjs        内存版 Supabase 客户端（select/insert/update/delete/order/eq/gt/lt/in/limit/single）
    seed.mjs                 演示数据：13 门课、若干待办、2 个项目、30 天健身
  schema\
    v1.sql                   7 张表 + 索引的受限 DDL（早写晚用）
    v1.policies.json         7 张表的 accessPolicies（anonymous / select,insert,update,delete / public）
```

硬性边界：`dev/` 与 `schema/` 不得被 `webDirectory` 或 Function 包包含；`adapter.mjs` 不做任何修改；不在 `secretNames` 里声明数据库凭据（平台保留 `SUPABASE_*`）。

---

## 三、阶段划分

### S1 契约与骨架基线
**依赖**：无
**目标**：把 PRD 7.2/7.3 变成可执行文件，并让本地能起一个有界面的页面。

新建：`schema/v1.sql`、`schema/v1.policies.json`、`web/styles.css`、`web/lib/dom.js`、`web/app.js`（仅路由与视图注册）

关键实现
- `v1.sql`：仅用受限子集（`uuid/text/integer/boolean/timestamptz/jsonb`；日期与时刻为 `text`；无外键、无默认值、无 CHECK；`CREATE INDEX` 不带排序与条件）
- `app.js`：`routes` 表、`start()`、`navigate(hash)`、`renderShell()` 挂载 rail/tabbar/topbar、`keydown` 快捷键（`N`/`Esc`/`1`–`6`）
- `dom.js`：`h(tag, props, ...children)`（自动转义、支持 `dataset`/`onclick`/`class` 数组）、`mount(el, node)`、`clear(el)`
- `styles.css`：PRD 2.4 的全部 token（`--void/--panel/--line/--cyan/--orange/--green/--ink-dim`）、`.shell/.rail/.tabbar/.topbar/.view` 布局、640/1024 断点、`.panel/.chip/.badge/.progress` 基础元件、`.starfield` 星点背景（CSS 多重 radial-gradient，不用图片）

**完成标准**
1. `python -m http.server 4173 --bind 127.0.0.1 --directory web` 起来后 `curl http://127.0.0.1:4173/` 返回 200 且 HTML 含 `/app.js`
2. 6 条哈希路由都能切换，顶栏与侧栏/底栏按断点正确出现其一
3. `v1.sql` 逐条比对 PRD 7.2 字段无遗漏、无子集外语法

---

### S2 Function 后端逻辑（本地真实代码 + 假数据库）
**依赖**：S1（schema）
**目标**：全部业务读写在本地跑通真实 handler 代码，不依赖云。

新建：`functions/handler.mjs`、`functions/registry.mjs`、`functions/rules.mjs`、`functions/index.ts`、`dev/fake-supabase.mjs`、`dev/tests/s2.test.mjs`

关键实现
- `registry.mjs`：`export const TABLES = { courses: { columns: {name:{type:'text',max:60,required:true}, day_of_week:{type:'int',min:1,max:7}, start_time:{type:'hhmm'}, week_type:{type:'enum',values:['all','odd','even']}, ...}, readOnly:['id','created_at','updated_at'], orderBy:[...] }, ... }`；`validateRow(table, input, {partial})` 返回 `{ok, row, error}`
- `handler.mjs`：`handleApp({request, supabase})` → 按 `?action=` 路由；`GET bootstrap`（7 表全量 + stats），`POST create/update/remove/import/wipe`；写操作校验 `method`、`content-type: application/json`、body ≤ 64KB；ID 与 `created_at/updated_at` 由 Function 用 `crypto.randomUUID()` 与 `new Date().toISOString()` 生成；DB 错误映射为固定码（`database_request_failed` / `invalid_input` / `not_found` / `write_result_unknown`），不回传原始报错
- `rules.mjs`：服务端独有的完整性规则——删除项目级联删除其里程碑与子任务、删除里程碑级联删除子任务、子任务变化时重算未锁定的里程碑进度。
  - 修订说明（S2 开工时）：原计划的 `stats.mjs` 取消。首页与健身的聚合口径若在前后端各写一遍必然漂移，因此统一由前端 `web/lib/time.js` 实现，`bootstrap` 只返回原始行与 `serverTime`；`dev/contract-check.mjs` 合并进 `dev/tests/s2.test.mjs`，同一检查不留两份。
- `index.ts`：照平台示例结构，`Deno.serve(serveSite(handleApp, {createClient, env:(n)=>Deno.env.get(n)}))`，SDK 固定 `npm:@supabase/supabase-js@2.57.4`
- `fake-supabase.mjs`：`from(table).select(cols).eq/in/gt/lt().order().limit().maybeSingle()/single()`、`insert/update/delete`，返回 `{data,error}`，行为对齐 PostgREST 语义（无匹配行 → `data:null`）

**完成标准**
1. `node --experimental-vm-modules --test dev/tests/s2.test.mjs` 全绿，至少覆盖：bootstrap 七表齐全；每表 create→read→update→read→delete→read 闭环；无匹配行的 update 返回 `not_found` 而非成功；`day_of_week=9`、`week_type='xyz'`、超长文本、缺 `name` 四种非法输入均返回 400 且不落库；GET 请求无法触发任何写动作（405）
2. 请求体超 64KB 被拒；`content-type` 非 JSON 被拒
3. `remove` 后 `bootstrap` 条数确实减少（证明删的是真实行）

---

### S3 数据客户端与应用外壳
**依赖**：S1、S2（契约）
**目标**：页面通过 `/functions/v1/app` 拿真数据（本地由假库提供），乐观更新与三态齐备。

新建：`web/lib/api.js`、`web/lib/store.js`、`web/lib/ui.js`、`web/lib/time.js`、`dev/preview-server.mjs`、`dev/seed.mjs`

关键实现
- `api.js`：`requestJson(url, init, messages)`（401/403 → "访问未授权"；非 JSON/重定向 → `invalid_response`；错误码映射中文）、`bootstrap()`、`createRow/updateRow/removeRow`、`isWriteOutcomeUnknown(e)`
- `store.js`：`init()` 拉 bootstrap；`get(table)`、`subscribe(fn)`、`mutate(table, action, payload)`（快照→本地改→通知→写云→用返回行回填 / 失败回滚 + 错误态）；写完成后按 PRD 7.4 重新拉相关表；`document.visibilitychange` 与下拉刷新触发 `refresh()`；本地只存 UI 偏好（`localStorage` 键：`ui.rail`、`ui.timetableView`、`ui.homeCardOrder`）
- `time.js`：`todayKey()`、`weekOf(date,cfg)`、`parityOfWeek`、`courseActiveOnWeek(c,week)`、`hm2min/min2hm`、`addDays`、`weekRangeOf(date,week)`、`mondayOf`、`groupByDate`、`overdueDays(task,today)`、`streakOf(workouts,today)`、`fmtRemain(ms)`
- `ui.js`：`openLayer({title,fields,values,onSubmit})`（桌面 Modal / 移动底部抽屉，同一 API，`Esc` 与下拉关闭，失败保留输入、pending 期间禁重复提交）；`fields` 为声明式描述（`text/textarea/date/time/number/select/chips/switch`）；`toast(msg,{action,onAction})`（5 秒撤销）；`confirmDialog`；`skeleton(n)`；`emptyState({icon,title,cta})`；`errorState({message,onRetry})`；`swipeDelete(el,cb)`
- `preview-server.mjs`：node 静态服务 `web/` + 把 `/functions/v1/app` 转给真实 `handleApp`（注入 `fake-supabase` 单例）+ 首次启动装载 `seed.mjs`

**完成标准**
1. `node dev/preview-server.mjs 4173` 后浏览器打开，6 个页面都渲染出 seed 数据，无 console 报错
2. 手动断网（Ctrl+C 停服务）后点任何写操作：界面回滚到原值并显示可重试错误；恢复服务后重试成功
3. 手机视口（DevTools 375px）下 `openLayer` 表现为底部抽屉且可下拉关闭
4. 刷新页面后 `ui.*` 三项偏好保持，业务数据全部来自服务端

---

### S4 设置页（学期与节次基准）
**依赖**：S3
**目标**：周次与课表坐标轴有真实来源。PRD 里首页和课表都依赖它，所以先做。

新建：`web/views/settings.js`

关键实现：`renderSettings(store)`、`semesterForm()`（起始日 + 总周数 + 实时显示"当前第 N 周"）、`periodEditor()`（增删行、`kind:'class'|'break'`、时间合法性校验：结束 > 开始、行之间不重叠）、`previewPeriodChange(before, after)` → 影响提示（"第 3 节将从 14:00 移到 15:00，影响 2 门课"）、`exportJson()`、`importJson(file)`、`wipeAll()`（需输入 `DELETE`）

**完成标准**
1. 改起始日为上周一，顶栏与首页周次读数 +1（验收 C16 前半）
2. 节次表新增/删除一行，课表网格行数与刻度同步（课表未做时先在 console 断言 `cfg.periods.length`）
3. 导出文件下载成功且为完整 7 表快照；导入回滚测试：清空 → 导入 → 条数与内容还原（C17 前半，Function 侧 `import/wipe` 在 S2 已实现）
4. 时间倒置（结束早于开始）与行重叠时保存被阻止并给字段级错误

---

### S5 日程模块
**依赖**：S3（可与 S4 并行）
**关键实现**：`renderTasks(store)`、`segments()`（今日/本周/全部/已完成）、`filterBar()`（分类 + 状态）、`groupedList()`（日期分组 + 吸顶标题 + 已完成沉底划线）、`taskForm()`、`toggleDone(task)`、`postponeMenu(task)`（今天/明天/下周）、`overdueBadge()`、`quickAddBar()`（弱解析：只识别 `X月X日`、`HH:MM`、`N分钟`，识别不了留空）
**完成标准**
1. 新增→编辑→勾选完成→取消完成→删除（左滑 + 5 秒撤销）全链路可用，刷新后状态保持
2. 截止日设为昨天时显示"逾期 1 天"+ 橙色左边框，顺延后离开逾期组（C9）
3. 无日期条目进入"收集箱"分组且不出现在今日列表
4. 分类筛选与状态筛选组合结果正确；空列表显示空态引导

### S6 课表模块
**依赖**：S4（节次表）+ S3
**关键实现**：`renderTimetable(store)`、`weekPicker()`（`‹ 第N周 ›` + 本周/单周/双周快捷 + 越界保护）、`viewSwitch()`（grid/day/list，存 `ui.timetableView`）、`gridWeek()`（纵轴由 `cfg.periods` 生成，`position:absolute` 按分钟映射高度；非本周课程 30% 透明度；当前时刻青色虚线只在今天列）、`gridDay()`、`listWeek()`、`emptySlotClick(date,time)` → 预填新建表单、`courseForm()`、`findConflicts(course, all)`（同星期 + 时间重叠 + 周型与周次范围有交集）、`courseDetail()`（只读 + 编辑/删除入口）
**完成标准**
1. 13 门课（含 2 门单周、2 门双周、1 门第 1–8 周）录入后，第 5 周与第 12 周显示结果与实际一致（C6、C4）
2. 制造重叠课后保存出现橙色冲突警告并列出课名；强制保存后两课并排红描边（C7）
3. 三视图切换、刷新保持；375px 默认日视图且无横向溢出
4. 点击网格空白新建时星期与时间已预填正确

### S7 科研模块
**依赖**：S3
**关键实现**：`renderResearchList(store)`、`renderResearchDetail(store, id)`（路由 `#/research/:id`）、`projectCard()`、`milestoneTimeline()`（纵向时间线 + 状态徽标 + 剩余天数）、`sortControl()`（桌面 HTML5 拖拽、移动端 ↑↓ 按钮，写 `sort`）、`progressControl(ms)`（自动 = 子任务完成比并锁定；解锁手填 + 「手动」徽标 + 差异提示）、`subtaskList()`（移动用手风琴展开）、`cascadeDeleteConfirm(ms)`（文案含"其下 N 个子任务"）
**完成标准**
1. PRD C10：4 条子任务勾掉 2 条 → 50%；解锁手调 80%；再勾 1 条仍为 80%
2. C11：删除里程碑的确认框写明子任务数量，确认后级联消失
3. C12：拖拽排序后刷新保持
4. 状态四态颜色与 PRD 2.4 一致；首页"近期里程碑"取全项目最近 3 个未完成

### S8 健身模块
**依赖**：S3
**关键实现**：`renderWorkout(store)`、`quickLogForm()`（默认今天、类型 chips 含自定义、时长快捷 15/30/45/60/90 + ±5 微调、三态完成度图标按钮）、`recordList()`（按周分组，未训练日显示为暗灰占位）、`statsPanel()`（本周/本月/自定义区间；`charts.progressRing` 目标完成、`charts.donut` 类型分布、`charts.barSeries` 近 8 周）、`heatGrid()`（近 3 个月）、`streak()`（缺练归零、部分不清零）
**完成标准**
1. C13：3 天训练 + 1 天缺练 → 连续天数归零；把缺练改为部分完成 → 连续不断
2. C14：首页"本周健身"数字与本页统计逐项相等
3. C15：从点「记一笔」到保存成功 ≤ 3 次点击
4. 类型自定义后，下次表单 chips 中出现该项

### S9 首页聚合
**依赖**：S4、S5、S6、S7、S8
**关键实现**：`renderHome(store)`、`hudBar()`（日期星期 + 第 N 周/共 M 周 + `charts.progressRing` 今日完成 + "下一站"倒计时）、`nextDueItem()`（最近未完成待办 → 退到最近未完成里程碑 → 都无则空文案）、`cardTodayCourses()`（时间序 + 当前时间指示线 + 已结束 40% 透明）、`cardTodayTasks()`（可勾选，唯一可在首页写入的动作）、`cardMilestones()`、`cardWorkouts()`、`cardOrder()`（长按拖拽，存本地）
**完成标准**
1. 四分区数字与明细页逐项一致（C14 + 手工比对课程与待办）
2. 在首页勾选一条待办，日程页与另一台设备刷新后同步（C3 子集）
3. 无课无待办的周末显示空态而非空白；1280px 与 375px 下卡片布局按 PRD 第 3 节
4. 倒计时在跨天时自动更新（过 00:00 或页面重新可见时重算）

### S10 全局打磨与无障碍
**依赖**：S4–S9
**关键实现**：统一的加载骨架、错误重试、空态文案（中文，无占位符残留）；`prefers-reduced-motion` 降级；键盘导航与焦点管理（打开浮层聚焦首字段、关闭还原焦点）；`aria-label` 补齐图标按钮；触控目标 ≥ 44px 复查；文档标题与描述；`index.html` 品牌文案与 PRD 一致
**完成标准**
1. C18：断网打开应用显示可读错误态 + 重试，无未捕获异常
2. C19：清空数据后 6 个页面均为空态引导
3. C2：375px 无横向滚动、无文字截断；Tab 键可完成一条待办的新建全流程

### S11 云端初始化与建库（首次涉及云资源，需你授权）
**依赖**：S1–S10（PRD 与平台都要求"先有可评审的真实前端，再建云"）
步骤
1. `get_local_context` 确认会话目录为 `D:\my_schedule`
2. `prepare_site`：`webDirectory:'web'`、静态-only 引导草稿（不带 Function 与数据库参数）、新 `actionId` + 名称与子域名 → **保留返回的 Project/Site ID，不发布这个引导草稿、不展示其发布确认**
3. `ensure_backend`：`database` + `functions` 能力 → 等待 Operation 完成
4. `get_database` 读 `schema_version` 与 `schema_fingerprint`
5. `create_database_migration`（SQL 用 `schema/v1.sql`、`accessPolicies` 用 `v1.policies.json`、两个新 UUID、上面读到的 version/fingerprint）→ 审阅返回的归一化 SQL 与策略
6. `apply_database_migration`（带 revision/version/fingerprint/sqlSha256 + `confirm:true`）→ 轮询 Operation 至终态
7. `get_database` + `list_database_tables` + `get_database_table` 复核 7 张表列与最终 `schema_version`，记下 `requiredSchemaVersion`
**完成标准**：7 张表在云上存在且列与 PRD 7.2 完全一致；`schema_version` 已取到整数值；迁移为终态成功（不是 accepted/running）

### S12 接真库 + 完整打包 + 访问控制
**依赖**：S11
步骤
1. 前端仍打真实同源 `/functions/v1/app`；本地继续用 `preview-server` 跑回归，云上以真实请求验证
2. `prepare_site`：`webDirectory:'web'`、`functionDirectory:'functions'`、`databaseAccess:'read_write'`、`requiredSchemaVersion` = S11 值、复用 `projectId`、**新 actionId**
3. 等 Functions 就绪；`get_access_policy` 读 `available_modes` → 选非公开模式并 `update_access_policy`（该操作会同时挡住页面与 Function）→ 复核 `get_site`
4. 部署后真实请求验一次读写闭环（`bootstrap` + 一条 create + 一条 delete）
**完成标准**：`prepare_site` 产出 ready 草稿；Function 已就绪；访问策略为非公开模式且 `get_access_policy` 回读一致；云上真实读写出结果（这三件事分别记录，不互相推导）

### S13 发布与验收（发布需你授权）
**依赖**：S12
步骤：`publish_site` → 轮询确认 `published` 与 active release → `show_publish_confirmation` 交付预览入口 → 手机与桌面同一网址跑 PRD 第 10 节 C1–C19
**完成标准**：C1–C19 逐条记录"通过 / 未通过 / 未验证（并写明原因）"。静态预览不执行 Function，后端行为必须以已发布站点的真实请求为准，不得用预览或本地 fixture 充当通过证据。

---

## 四、依赖关系

```
S1 ──► S2 ──► S3 ─┬─► S4 ─┬─► S6 ─┐
                  │       │       │
                  ├─► S5 ─┤       │
                  ├─► S7 ─┼─► S9 ─┴─► S10 ─► S11 ─► S12 ─► S13
                  └─► S8 ─┘
```
- 可并行：S5 / S7 / S8 三条互不依赖；S4 只阻塞 S6
- 强串行：S2 必须在 S3 之前（契约先定）；S11 必须在 S12 之前（要 Site ID 与 schema 版本）；S13 必须最后
- 跨阶段不变式：字段与动作只在 `registry.mjs` + `schema/v1.sql` 定义一次，前端表单不得出现库里没有的字段

## 五、需要你在场的三个授权点

| 阶段 | 会产生的外部影响 |
|---|---|
| S11 步骤 2 | 创建云项目与站点（首次动用云资源） |
| S11 步骤 3 | 启用数据库与 Functions 后端（平台资源） |
| S13 | 发布到公网网址（对外可见，虽然已设非公开访问） |

其余阶段全部只改本机 `D:\my_schedule` 里的文件，不需要逐次确认。

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 受限 DDL 与 PRD 字段冲突（不支持 FK/默认值/date 类型） | PRD 已按子集设计；S1 就把 `v1.sql` 拿去 `create_database_migration` 之前逐条自查，S11 一次通过 |
| Function 本地无法跑 Deno，`index.ts` 只能部署后验证 | 把全部业务逻辑放 `.mjs`（node 可直跑），`index.ts` 只做 3 行装配，出错面收敛 |
| 零构建 → 手写渲染层容易漏状态 | S3 就把 `skeleton/empty/error/optimistic` 做成唯一入口，各视图不许自行拼错误处理 |
| 站点访问模式实际不支持"密码"只支持邀请制 | S12 读 `available_modes` 后再定；若为邮箱邀请白名单，效果强于密码，届时告知你 |
| 移动端课表密度 | 已定三视图，小屏默认日视图；周视图横向可滚 |
| 首次真实读写在云端失败但界面看起来正常 | S12 的完成标准要求以真实请求结果单独记账；S13 逐条 C 项标注证据来源 |
