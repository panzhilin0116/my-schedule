// S3 完成标准里"六个页面渲染出来、浮层表单能用"这部分的可自动验证版本。
// 用 dev/tests/dom-stub.mjs 的最小 DOM 真实渲染视图，断言的是界面上的文字，
// 而不是"函数没抛异常"——人工点页面时暴露的空白标题正是这类缺陷。
// 公共脚手架在 render-harness.mjs（与 S4 之后的渲染用例共用）。
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_NAMES } from '../../functions/registry.mjs';
import { createPreviewServer } from '../preview-server.mjs';
import * as T from '../../web/lib/time.js';
import {
  TODAY, TIME, app, prefs, intervals, winHandlers, withDom, emitWindow, settle, waitUntil, texts,
  stateFrom, seedState, emptyAppState, fakeCtx, viewRenders, viewArgs, assertNoBlankLabels,
  fieldWrap, topTitle, clockText, railOf, toastTexts, go,
} from './render-harness.mjs';


// ── 六个视图：种子数据下的真实渲染 ─────────────────────────

test('S3 六个视图用种子数据渲染后，所有标题位都有文字（不允许空白标题）', async () => {
  await withDom(async () => {
    const all = await viewRenders();
    const state = seedState();
    const { ctx } = fakeCtx();
    for (const [key, render] of Object.entries(all)) {
      const node = render(viewArgs[key](state, ctx));
      assert.ok(node && node.localName, `${key} 没有返回元素`);
      assert.ok(texts(node).trim().length > 20, `${key} 渲染内容过少，疑似整页空白`);
      assertNoBlankLabels(node, `${key} 视图`);
    }
  });
});

test('S3 空库时每个视图都给出带说明的空态，而不是白屏或报错', async () => {
  await withDom(async () => {
    const all = await viewRenders();
    const state = emptyAppState();
    const { ctx, calls } = fakeCtx();
    for (const [key, render] of Object.entries(all)) {
      const node = render(viewArgs[key](state, ctx));
      const empty = node.querySelector('.empty');
      assert.ok(empty, `${key} 空库时应有空态区块`);
      assert.ok(empty.querySelector('p').textContent.trim(), `${key} 空态缺少说明文字`);
      assert.ok(empty.querySelector('svg'), `${key} 空态缺少图形`);
    }
    // 科研详情页指向一个已被其他设备删掉的项目
    const research = (await import('../../web/views/research.js')).renderResearch;
    const gone = research({ state, ctx, time: TIME, sub: 'ffffffff-0000-4000-8000-000000000000' });
    assert.equal(gone.querySelector('.empty p').textContent, '这个项目已不存在');
    gone.querySelector('.empty button').fire('click');
    assert.ok(calls.includes('navigate:#/research'), '空态里的返回按钮要真的能返回');
  });
});

test('S3 首页 HUD 反映种子数据：日期、周次奇偶、今日完成度与下一站', async () => {
  await withDom(async () => {
    const { renderHome } = await import('../../web/views/home.js');
    const node = renderHome(viewArgs.home(seedState(), fakeCtx().ctx));
    const hud = node.querySelector('.hud');
    assert.ok(hud, '首页缺少 HUD 区块');
    assert.equal(hud.querySelector('.readout b').textContent, '9月20日 周日');
    assert.equal(hud.querySelector('.week').textContent, '第 5 周 / 共 18 周 · 单周');
    assert.equal(hud.querySelector('.sub').textContent, '今日待办 0/6 已完成');
    // 下一站 = 最早未完成待办（种子里逾期 5 天的报销事项）
    assert.equal(hud.querySelector('.next .label').textContent, 'NEXT DEADLINE');
    assert.equal(hud.querySelector('.next .title').textContent, '报销实验器材');
    assert.match(hud.querySelector('.next .remain').textContent, /9月15日 周二 · .+/);
    assert.equal([...node.querySelectorAll('section.panel h3')].map((item) => item.textContent).join(','),
      '今日课程,今日待办,近期里程碑,本周健身');
  });
});

test('S3 首页四分区内容对得上种子数据（课程/逾期/里程碑进度/健身读数）', async () => {
  await withDom(async () => {
    const { renderHome } = await import('../../web/views/home.js');
    const { ctx, calls } = fakeCtx();
    const node = renderHome(viewArgs.home(seedState(), ctx));
    const body = texts(node);
    assert.ok(body.includes('创新创业实践'), '周日的单周课要出现在今日课程');
    assert.equal(node.querySelectorAll('.list-row').length, 1 + 6 + 3, '1 门课 + 6 条今日待办 + 3 个里程碑');
    assert.ok(body.includes('逾期 5 天') && body.includes('逾期 3 天') && body.includes('逾期 2 天'), '逾期待办要标出天数');
    assert.ok(!body.includes('和导师组会汇报'), '明天到期的事项不属于今日待办');
    assert.ok(!body.includes('图书馆还书'), '已完成的逾期事项不再出现在今日待办');

    const milestones = [...node.querySelectorAll('section.panel')][2];
    assert.equal([...milestones.querySelectorAll('.title')].map((item) => item.textContent).join(','),
      '数据集整理与标注,能耗数据接入,基线模型复现', '近期里程碑没有按目标日最近排序');
    assert.equal([...milestones.querySelectorAll('.num')].map((item) => item.textContent).join(','), '25%,0%,67%');
    assert.match(texts(milestones), /还剩 \d+ 天|已过期 \d+ 天/);

    const workout = [...node.querySelectorAll('section.panel')][3];
    assert.equal([...workout.querySelectorAll('.readout-cell .k')].map((item) => item.textContent).join('/'),
      '次数/时长/连续天数');
    for (const cell of workout.querySelectorAll('.readout-cell .v')) {
      assert.match(cell.textContent, /^\d+( 分钟)?$/, `健身读数不是数字：${cell.textContent}`);
    }

    node.querySelector('.list-row .tick').fire('click');
    assert.equal(calls[0], 'update:tasks', '首页勾选没有走 store 写入');
    assert.equal(calls[1].done, true);
  });
});

test('S3 首页今日课程只列本周真的上课的课程，单双周不混', async () => {
  await withDom(async () => {
    const { renderHome } = await import('../../web/views/home.js');
    // 2026-09-21 是周一；起始日 2026-09-14 → 第 2 周（双周）
    const config = { id: 'cfg', start_date: '2026-09-14', total_weeks: 18, periods: [] };
    const tables = Object.fromEntries(TABLE_NAMES.map((name) => [name, []]));
    tables.semester_config = [config];
    tables.courses = [
      { id: 'c1', name: '单周才上的计算机网络', teacher: '陈致远', location: 'A415', day_of_week: 1, start_time: '14:00', end_time: '15:40', week_type: 'odd', start_week: 1, end_week: 16, color: '#4ADE80', note: null, sort: 0 },
      { id: 'c2', name: '每周都上的数据结构', teacher: '王立群', location: 'A302', day_of_week: 1, start_time: '08:00', end_time: '09:40', week_type: 'all', start_week: 1, end_week: 16, color: '#3DD6F5', note: null, sort: 1 },
    ];
    const node = renderHome({
      state: stateFrom(tables, { config }),
      ctx: fakeCtx().ctx,
      time: { today: '2026-09-21', now: new Date('2026-09-21T09:00:00') },
    });
    const body = texts(node);
    assert.ok(body.includes('每周都上的数据结构'), '每周课应出现在今日课程');
    assert.ok(!body.includes('单周才上的计算机网络'), '双周这周不该显示单周课程');
    assert.ok(body.includes('第 2 周 / 共 18 周 · 双周'), '周次奇偶标注错了');
    assert.ok(!body.includes('单周'), '今日课程里不该残留单周标记');
  });
});

test('S3 学期外首页退回假期态：周次读数与课程区都不编造数据', async () => {
  await withDom(async () => {
    const { renderHome } = await import('../../web/views/home.js');
    const state = seedState();
    state.config = { ...state.config, start_date: '2030-03-01' };
    const node = renderHome(viewArgs.home(state, fakeCtx().ctx));
    assert.equal(node.querySelector('.hud .week').textContent, '不在学期内');
    assert.equal(node.querySelector('.home-grid section.panel .empty p').textContent, '不在学期内');
    assert.ok(texts(node).includes('到设置里确认学期起始日'));
  });
});

test('S3 课表页按周次铺开七天，节数按本周是否上课统计', async () => {
  await withDom(async () => {
    const { renderTimetable } = await import('../../web/views/timetable.js');
    const state = seedState();
    const { ctx, calls } = fakeCtx();
    const node = renderTimetable({ state, ctx, time: TIME, query: new URLSearchParams() });
    assert.equal(node.querySelector('.week-picker .current').textContent, '第 5 / 18 周');
    assert.equal(node.querySelector('.tt-toolbar .badge.cyan').textContent, '单周');
    const cells = node.querySelectorAll('.tt-cell');
    assert.equal(cells.length, 7, '一周七天都要有课程列');
    // 本周节数只算真的上的课：双周课画在同一列里，但不能混进计数
    const liveOf = (cell) => cell.querySelectorAll('.tt-course').length
      - cell.querySelectorAll('.tt-course.is-ghost').length;
    assert.equal(cells.map(liveOf).join('/'), '2/2/1/2/2/1/1', '周三/周五的双周课不该计入本周节数');
    assert.equal(cells.map((cell) => cell.querySelectorAll('.tt-course.is-ghost').length).join('/'),
      '0/0/1/0/1/0/0', '本周不上的课要画成 ghost，而不是凭空消失');
    assert.match(texts(node.querySelector('.panel.tight')), /本周 11 节，另有 2 门本周不上/);
    assert.equal(node.querySelectorAll('.tt-cell.is-today').length, 1);
    assert.ok(cells[6].classList.contains('is-today'), '周日就是今天，要标出来');
    assert.ok(texts(cells[6]).includes('创新创业实践'), '今天的课程要落在今天那一列');

    // 切到第 6 周（双周）：大学英语变成实色，单周课程转成 ghost
    const even = renderTimetable({ state, ctx, time: TIME, query: new URLSearchParams('week=6&dow=3') });
    const english = [...even.querySelectorAll('.tt-course')].find((item) => item.querySelector('b').textContent === '大学英语（四）');
    assert.ok(english, '双周课表应出现双周课程');
    assert.equal(english.classList.contains('is-ghost'), false, '第 6 周大学英语是要上的课');
    assert.equal(even.querySelectorAll('.tt-course.is-ghost').length, 3, '第 6 周该有三门单周课标灰');
    assert.ok(even.querySelectorAll('.tt-course.is-ghost')
      .every((item) => item.getAttribute('aria-label').includes('本周不上')),
    'ghost 色块要用无障碍标签说明本周不上（截图之外的读屏口径）');
    assert.match(texts(node.querySelector('.tt-legend')), /本周不上/, '图例要解释 ghost 的含义');
    node.querySelector('.week-picker button.iconbtn').fire('click');
    assert.ok(calls.includes('navigate:#/timetable?week=4&dow=7'), '上一周按钮没有走路由');
    node.querySelectorAll('.week-picker button.iconbtn')[1].fire('click');
    assert.ok(calls.includes('navigate:#/timetable?week=6&dow=7'), '下一周按钮没有走路由');
  });
});

test('S3 课表页没有课程的一周显示空档提示，不留下空白分组', async () => {
  await withDom(async () => {
    const { renderTimetable } = await import('../../web/views/timetable.js');
    const base = seedState();
    const { ctx } = fakeCtx();
    const node = renderTimetable({
      state: { ...base, tables: { ...base.tables, courses: [] } },
      ctx, time: TIME, query: new URLSearchParams(),
    });
    // 一门课都没有：不画七天空网格，直接给录入引导，但周次条要保留，页面结构不该突变
    assert.equal(node.querySelectorAll('section.group').length, 0, '不该留下空白分组');
    assert.equal(node.querySelectorAll('.tt-cell').length, 0);
    assert.ok(node.querySelector('.week-picker'), '空态也要保留周次条');
    const empty = node.querySelector('.empty');
    assert.equal(empty.querySelector('p').textContent, '还没有课程');
    assert.ok(texts(empty).includes('空白时段'), '空态要说清楚怎么录入');
    empty.querySelector('button').fire('click');
    assert.ok(document.getElementById('modal-root').querySelectorAll('.layer')
      .some((layer) => layer.querySelector('.eyebrow')?.textContent === 'COURSE'), '录入按钮没有打开新增课程浮层');
    (await import('../../web/lib/ui.js')).clearOverlays();

    // 有课但整天空着：列表视图逐天标注空档，并给出该天新建入口
    const listCtx = fakeCtx().ctx;
    listCtx.store.pref = (key, fallback) => (key === 'ui.timetableView' ? 'list' : fallback);
    const mondayOnly = { ...base, tables: { ...base.tables, courses: base.tables.courses.slice(0, 1) } };
    const list = renderTimetable({ state: mondayOnly, ctx: listCtx, time: TIME, query: new URLSearchParams() });
    const groups = list.querySelectorAll('section.group');
    assert.equal(groups.length, 7, '列表视图仍要按七天分组');
    assert.equal([...groups].map((group) => group.querySelector('.count').textContent).join('/'),
      '1/1 节/无课/无课/无课/无课/无课/无课');
    const empties = groups.filter((group) => group.querySelector('.count').textContent === '无课');
    assert.equal(empties.length, 6);
    for (const group of empties) {
      assert.ok(texts(group).includes('这一天没有安排课程'), `${texts(group)} 应说明为什么是空的`);
      assert.equal(group.querySelectorAll('.list-row').length, 0, '空档日不该画出幽灵课程行');
      group.querySelector('button.btn').fire('click');
    }
    assert.equal(document.getElementById('modal-root').querySelectorAll('.layer').length, 6,
      '空档日的「这一天加一门课」要真的能新建');
    (await import('../../web/lib/ui.js')).clearOverlays();

    // 没有学期基准时不猜周次
    const bare = renderTimetable({ state: emptyAppState(), ctx: fakeCtx().ctx, time: TIME, query: new URLSearchParams() });
    assert.equal(bare.querySelector('.empty p').textContent, '还没有学期基准');
    bare.querySelector('.empty button').fire('click');
    assert.equal(globalThis.location.hash, '#/settings', '缺学期基准时空态要把人带到设置页');
  });
});

test('S3 日程页按日期分组，逾期段有标记、收集箱单独一组', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { ctx, calls } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(), ctx));
    // S5 起默认只看「今日」，分组要覆盖全表，先切到「全部」
    node.querySelectorAll('.seg button').find((item) => item.textContent.startsWith('全部')).click();
    const heads = [...node.querySelectorAll('.group-head h3')].map((item) => item.textContent);
    assert.equal(heads[0], '9月15日 周二 · 已逾期', `逾期分组要在最前并标出：${heads.join(' | ')}`);
    assert.equal(heads.filter((item) => item === '今天').length, 1);
    assert.equal(heads.at(-1), '收集箱 · 未定日期', '无日期项要落在最后');
    assert.equal([...node.querySelectorAll('.group-head .count')].map((item) => item.textContent).join('|'),
      '0/1|1/1|0/1|0/1|1/1|0/3|0/1|1', '每组的完成计数要按 已完成/总数 显示，收集箱只报条数');
    assert.ok(node.querySelector('section.group').classList.contains('is-overdue'));
    assert.match(texts(node.querySelector('.list-row .meta')), /逾期 5 天/, '逾期行要标出逾期天数');

    node.querySelector('.list-row .iconbtn.danger').fire('click');
    assert.ok(calls.includes('remove:tasks'), '删除按钮没有走 store.remove');
    const toastNode = document.getElementById('toast-root').querySelector('.toast');
    assert.ok(toastNode, '删除后要给出撤销提示');
    assert.match(toastNode.textContent, /已删除「.+」/);
    assert.equal(toastNode.querySelector('button').textContent, '撤销');

    // 快速添加：回车即写入服务端
    const input = node.querySelector('input');
    input.value = '  明早交表  ';
    input.fire('keydown', { key: 'Enter' });
    await settle(2);
    const created = calls.find((item) => typeof item === 'object' && item.title);
    assert.equal(created.title, '明早交表', '快速添加要 trimmed');
    assert.equal(created.due_date, TODAY);
    assert.equal(input.value, '');
  });
});

test('S3 科研页项目卡片汇总口径与详情页一致', async () => {
  await withDom(async () => {
    const { renderResearch } = await import('../../web/views/research.js');
    const state = seedState();
    const { ctx } = fakeCtx();
    const list = renderResearch({ state, ctx, time: TIME, sub: '' });
    const bodies = [...list.querySelectorAll('.proj-card')].map((card) => texts(card));
    assert.equal(bodies.length, 2);
    assert.ok(bodies[0].includes('基于深度学习的目标检测加速') && bodies[0].includes('3 个里程碑'));
    // 项目进度 = 里程碑平均：round((25+67+15)/3) = 36
    assert.ok(bodies[0].includes('36%'), `项目进度口径不对：${bodies[0]}`);
    assert.ok(bodies[0].includes('进行中'), '状态要显示中文标签而不是 not_started');
    assert.ok(bodies[1].includes('0%') && bodies[1].includes('1 个里程碑') && bodies[1].includes('未开始'));

    const detail = renderResearch({ state, ctx, time: TIME, sub: state.tables.research_projects[0].id });
    assert.equal([...detail.querySelectorAll('.tl-item .tl-head h4')].map((item) => item.textContent).join(','),
      '数据集整理与标注,基线模型复现,嵌入式部署与延迟测试');
    assert.equal([...detail.querySelectorAll('.tl-node')].map((item) => item.textContent).join(','), '1,2,0', '时间轴节点要显示子任务完成数');
    assert.ok(texts(detail).includes('手动'), 'manual_progress 的里程碑要标手动');
    assert.ok(texts(detail).includes('写采集脚本') && texts(detail).includes('跑通 YOLOv8 官方实现'));
    assert.equal([...detail.querySelectorAll('.tl-body .progress i')].map((item) => item.style.width).join('/'), '25%/67%/15%');
  });
});

test('S3 健身页读数与首页同源，记录按日期倒序分组', async () => {
  await withDom(async () => {
    const { renderHome } = await import('../../web/views/home.js');
    const { renderWorkout } = await import('../../web/views/workout.js');
    const state = seedState();
    const home = renderHome(viewArgs.home(state, fakeCtx().ctx));
    const node = renderWorkout(viewArgs.workout(state, fakeCtx().ctx));
    const homeCells = [...home.querySelectorAll('.readout-cell .v')].map((item) => item.textContent);
    const cells = [...node.querySelectorAll('.readout-cell .v')].map((item) => item.textContent);
    assert.equal(cells[0], homeCells[0], '健身页与首页的本周次数不一致：两处各算了一遍');
    assert.equal(cells[3], homeCells[2], '连续天数两处算法不一致');
    assert.match(node.querySelector('.panel-head h3').textContent, /^9\/14 – 9\/20$/);

    // S8 起列表按自然周分组，日内从新到旧：断言换成"整页日期不递增且每笔都在"
    const listed = [...node.querySelectorAll('.card-list .list-row')].map((row) => row.dataset.date);
    assert.equal(listed.some((date, index) => index && date > listed[index - 1]), false, '记录要按日期从新到旧');
    const seeded = state.tables.workouts.map((item) => item.workout_date);
    for (const date of new Set(seeded)) {
      assert.ok(listed.includes(date), `${date} 的记录在列表里找不到`);
    }
    assert.equal(listed.filter((date) => date).length, node.querySelectorAll('.card-list .list-row').length,
      '每一行都要标出自己的日期');
    const body = texts(node);
    assert.ok(body.includes('缺练') && body.includes('完成') && body.includes('部分'), '状态标签要区分三态');
    const weekRows = state.tables.workouts
      .filter((item) => item.workout_date >= '2026-09-14' && item.workout_date <= '2026-09-20' && item.duration_min > 0);
    const legend = [...node.querySelectorAll('.donut-legend .name')].map((item) => item.textContent);
    assert.deepEqual(legend.slice().sort(), [...new Set(weekRows.map((item) => item.type))].sort(),
      '类型分布要用中文类型，且区间内每个有类型的类型都要出现');
  });
});

test('S3 设置页展示学期基准、节次表与七类数据的云端概况', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const node = renderSettings(viewArgs.settings(seedState()));
    const cells = [...node.querySelectorAll('.readout-cell')]
      .map((cell) => `${cell.querySelector('.k').textContent}=${cell.querySelector('.v').textContent}`);
    assert.ok(cells.includes('起始日=2026-08-17'), cells.join(','));
    assert.ok(cells.includes('总周数=18'));
    assert.ok(cells.includes('当前周次=第 5 周'));
    assert.ok(cells.includes('节次数=10'));
    assert.ok(cells.includes('课程=13') && cells.includes('日程=10') && cells.includes('子任务=8'));
    assert.ok(cells.includes('学期配置=1'), '七类数据都要有概况读数');
    assert.equal(node.querySelectorAll('.readout-cell').length, 4 + 7);
    assert.equal([...node.querySelectorAll('.list-row .title')].length, 10, '节次表要逐节列出');
    assert.ok(texts(node).includes('午休') && texts(node).includes('休息'));
    assert.ok([...node.querySelectorAll('.readout-cell .k')].some((item) => /^上限 \d+$/.test(item.textContent)), '要提示各类记录上限');
    assert.match(texts(node), /最近同步 2026-09-20T12:00:00\.000Z/);
    assert.equal(renderSettings(viewArgs.settings(emptyAppState())).querySelector('.empty p').textContent, '还没有学期基准');
  });
});

// ── 图标：浏览器里的真实形态 ──────────────────────────────

test('S3 图标是合法 SVG：.icon 类与驼峰 viewBox 都不被属性名改写吃掉', async () => {
  await withDom(async () => {
    const { renderHome } = await import('../../web/views/home.js');
    const node = renderHome(viewArgs.home(seedState(), fakeCtx().ctx));
    const svgs = node.querySelectorAll('svg');
    assert.ok(svgs.length > 0, '首页没有渲染任何图标，断言等于空转');
    // S9 起首页上还有图表用的 svg：它们不是图标，尺寸口径自有其类名，
    // 但"驼峰属性没被改写成 kebab"这条底线对两者一样成立
    const icons = svgs.filter((item) => item.classList.contains('icon'));
    assert.ok(icons.length > 0, '首页没有一个图标类 svg');
    for (const item of icons) {
      assert.equal(item.namespaceURI, 'http://www.w3.org/2000/svg');
      assert.equal(item.getAttribute('viewBox'), '0 0 24 24', 'viewBox 被改成 kebab 就不是合法 SVG 属性');
      assert.ok(item.querySelector('path')?.getAttribute('d')?.length > 10, '图标没有描出路径');
    }
    const charts = svgs.filter((item) => !item.classList.contains('icon'));
    assert.ok(charts.length > 0, '首页没有图表 svg，这一轮等于没查');
    for (const item of charts) {
      assert.equal(item.namespaceURI, 'http://www.w3.org/2000/svg');
      assert.ok(item.getAttribute('viewBox'), '图表 svg 的 viewBox 被改写成 kebab 了');
      assert.ok(item.className.trim().length > 0, '图表 svg 要有自己的类名，CSS 才给得了尺寸');
    }
  });
});

// ── 应用外壳：真实 start() + 服务器真实数据 ────────────────

test('S3 外壳真实启动：路由、快捷键、下拉刷新、跨天重绘与偏好留存', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  try {
    await withDom(async () => {
      globalThis.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : `${origin}${input}`, init);
      app.start();
      // 启动即回读：首屏是骨架，数据到了才换成真实内容
      assert.ok(topTitle().length > 0, '顶栏标题没有随启动渲染');
      assert.equal(document.getElementById('view').querySelector('.skeleton') !== null, true, '加载期没有骨架屏');
      assert.equal(await waitUntil(() => app.store.state.status !== 'loading' && app.store.state.status !== 'idle'), true, 'bootstrap 没有回读完成');
      assert.equal(app.store.state.status, 'ready', JSON.stringify(app.store.state.error));
      assert.equal(app.store.state.tables.courses.length, 13);
      assert.equal(document.getElementById('view').querySelector('.skeleton'), null, '数据到位后骨架没被换掉');

      assert.equal(railOf().querySelectorAll('a').length, 7, '侧栏 = 标识 + 5 个导航页 + 设置');
      assert.equal([...railOf().querySelectorAll('.nav-label')].map((item) => item.textContent).join('/'),
        '任务舱/课表/日程/科研/健身/设置');
      assert.equal(document.getElementById('tabbar').querySelectorAll('a').length, 5, '底部导航不含设置');

      const EXPECT = {
        '#/': ['任务舱', '本周健身'],
        '#/timetable': ['课表', '第 5 / 18 周'],
        '#/tasks': ['日程', '快速记一条'],
        '#/research': ['科研', '基于深度学习的目标检测加速'],
        '#/workout': ['健身', '连续天数'],
        '#/settings': ['设置', '云端数据概况'],
      };
      for (const [hash, [title, marker]] of Object.entries(EXPECT)) {
        await go(hash);
        const view = document.getElementById('view');
        assert.equal(topTitle(), title, `${hash} 顶栏标题不对`);
        assert.equal(document.title, `${title} · 日程任务舱`);
        assert.ok(texts(view).includes(marker), `${hash} 页面缺少关键内容`);
        assertNoBlankLabels(view, hash);
        const active = [...railOf().querySelectorAll('a.nav-item')].filter((item) => item.getAttribute('aria-current') === 'page');
        assert.equal(active.length, 1, `${hash} 的当前页标记数量不对`);
      }
      await go('#/nope');
      assert.ok(texts(document.getElementById('view')).includes('本周健身'), '未知路由应退回首页而不是白屏');

      // 程序化跳转要写回地址栏：周次只活在查询串里，不写回去刷新就回到本周
      await go('#/timetable');
      const weekOfView = () => document.getElementById('view').querySelector('.week-picker .current').textContent;
      assert.equal(weekOfView(), '第 5 / 18 周');
      document.getElementById('view').querySelectorAll('.week-picker .iconbtn')[1].fire('click');
      assert.match(globalThis.location.hash, /^#\/timetable\?week=6&dow=[1-7]$/,
        '下一周按钮没有把周次写回地址栏，刷新与后退都会丢画面');
      assert.equal(weekOfView(), '第 6 / 18 周');
      await go('#/timetable?week=5&dow=3');
      assert.equal(weekOfView(), '第 5 / 18 周', '后退到上一个地址时周次要跟着回去');
      await go('#/');

      // 数字快捷键：改 hash 由 hashchange 驱动渲染，和浏览器一致
      const preventedKeys = emitWindow('keydown', { key: '3' });
      assert.equal(preventedKeys, true, '快捷键没有消费事件');
      assert.equal(globalThis.location.hash, '#/tasks');
      assert.equal(topTitle(), '任务舱', '只改 hash 不该立刻换页');
      emitWindow('hashchange');
      await settle(2);
      assert.equal(topTitle(), '日程');
      // 输入框里敲 N 不该打开浮层
      const layerMod = await import('../../web/lib/ui.js');
      const box = document.createElement('input');
      emitWindow('keydown', { key: 'n', target: box });
      assert.equal(layerMod.layerIsOpen(), false, '在输入框里按 N 弹出了浮层');
      emitWindow('keydown', { key: 'n' });
      assert.equal(layerMod.layerIsOpen(), true, 'N 键没有打开当前页的新建浮层');
      assert.ok(document.body.textContent.includes('新增日程'));
      assert.equal(emitWindow('keydown', { key: 'Escape' }), true, 'Esc 没有关闭浮层');
      assert.equal(layerMod.layerIsOpen(), false);

      // 下拉刷新：触到阈值就回读服务端并给出反馈
      const view = document.getElementById('view');
      view.fire('touchstart', { touches: [{ clientY: 10 }] });
      view.fire('touchmove', { touches: [{ clientY: 130 }] });
      view.fire('touchend', { changedTouches: [{ clientY: 130 }] });
      assert.equal(await waitUntil(() => toastTexts().some((text) => text.includes('已同步最新数据')), 4000), true,
        `下拉刷新没有给出同步反馈：${JSON.stringify(toastTexts())}`);

      // 跨天检查：同一天不打扰，换日立即重绘顶栏
      const rollover = intervals.find((item) => item.ms === 30000);
      assert.ok(rollover, '没有注册 30 秒的跨天检查');
      const firstBlock = document.getElementById('view').children[0];
      rollover.handler();
      assert.equal(document.getElementById('view').children[0], firstBlock, '同一天不该整体重绘');
      const before = clockText();
      const nextDay = Date.now() + 86400000;
      mock.timers.enable({ apis: ['Date'], now: nextDay });
      try {
        rollover.handler();
        assert.notEqual(clockText(), before, '跨天后顶栏日期没有更新');
      } finally {
        mock.reset();
      }
      rollover.handler();
      assert.equal(clockText(), before, '日期键与已渲染日期不一致时，检查应当重绘回来');

      railOf().querySelector('.collapse').fire('click');
      assert.equal(railOf().dataset.collapsed, 'true', '折叠按钮没有生效');
      assert.equal(prefs.get('ui.rail'), 'true', '折叠状态没有写入本地偏好');
      assert.deepEqual([...prefs.keys()], ['ui.rail'], 'localStorage 只该放这一条 UI 偏好');
    });

    // 换一份 DOM 相当于刷新：偏好要从 localStorage 读回来
    await withDom(async () => {
      app.render();
      assert.equal(railOf().dataset.collapsed, 'true', '折叠偏好没有跨会话留存');
      assert.equal(railOf().querySelector('.collapse').getAttribute('aria-label'), '展开侧栏');
    });
  } finally {
    globalThis.fetch = realFetch;
    prefs.clear();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── 浮层表单、确认框与手势 ─────────────────────────────────

test('S3 浮层表单：必填未填拦住提交，错误只出现在对应字段上', async () => {
  await withDom(async () => {
    const { openLayer, fieldsFor, layerIsOpen } = await import('../../web/lib/ui.js');
    let submitted = 0;
    const layer = openLayer({
      title: '新增日程',
      fields: fieldsFor('tasks', { only: ['title', 'due_date', 'duration_min'] }),
      values: {},
      onSubmit: async () => { submitted += 1; },
    });
    const form = layer.body.querySelector('form');
    assert.ok(form && form.classList.contains('field-stack'));
    assert.equal(form.querySelectorAll('.field').length, 3, '浮层里出现了未声明的字段');
    form.fire('submit');
    await settle(2);
    assert.equal(submitted, 0, '必填未填却提交了');
    assert.equal(layerIsOpen(), true, '校验失败不该关闭浮层');
    const titleField = fieldWrap(form, '标题');
    assert.ok(titleField.classList.contains('invalid'));
    assert.equal(titleField.querySelector('.err').textContent, '标题不能为空');
    assert.equal(fieldWrap(form, '截止日期').classList.contains('invalid'), false, '错误串到了别的字段');
    assert.equal(document.activeElement.id, 'f_title', '要把焦点放到出错的字段上');
    assert.equal(layer.foot.querySelectorAll('button').length, 2);

    const input = titleField.querySelector('input');
    input.value = '交实验报告';
    input.fire('input');
    assert.equal(titleField.querySelector('.err').textContent, '', '修正后错误要清掉');
    assert.equal(titleField.classList.contains('invalid'), false);

    const date = fieldWrap(form, '截止日期').querySelector('input');
    date.value = '2026-9-20';
    date.fire('input');
    form.fire('submit');
    await settle(2);
    assert.equal(submitted, 0);
    assert.match(fieldWrap(form, '截止日期').querySelector('.err').textContent, /格式应为 2026-09-01/);

    const stepper = fieldWrap(form, '预计时长(分钟)');
    assert.ok(stepper.querySelector('.stepper'), '预计时长应渲染成步进器');
    const plus = [...stepper.querySelectorAll('button')].at(-1);
    const minus = stepper.querySelector('button');
    plus.fire('click');
    plus.fire('click');
    assert.equal(stepper.querySelector('.num').textContent, '10');
    assert.equal(layer.draft().duration_min, 10);
    for (let index = 0; index < 5; index += 1) minus.fire('click');
    assert.equal(stepper.querySelector('.num').textContent, '0', '步进器不能减到负数');
    assert.equal(stepper.querySelector('.err').textContent, '', '合法取值不该报错');
    date.value = '2026-09-25';
    date.fire('input');
    form.fire('submit');
    await settle(3);
    assert.equal(submitted, 1);
    assert.equal(layerIsOpen(), false, '提交成功后应关闭浮层');
  });
});

test('S3 浮层控件形态由字段类型决定：数字区间、枚举下拉、色板、开关、长文本', async () => {
  await withDom(async () => {
    const { openLayer, fieldsFor, PALETTE } = await import('../../web/lib/ui.js');
    const layer = openLayer({
      title: '新增课程',
      fields: fieldsFor('courses', {
        only: ['name', 'day_of_week', 'start_time', 'week_type', 'color', 'note'],
        overrides: { note: { type: 'textarea' } },
      }),
      values: { name: '新课', day_of_week: 1, start_time: '08:00', week_type: 'all', color: PALETTE[0], note: '' },
      onSubmit: async () => {},
    });
    const form = layer.body.querySelector('form');
    const day = fieldWrap(form, '星期').querySelector('input');
    assert.equal(day.getAttribute('type'), 'number');
    assert.equal(day.getAttribute('min'), '1');
    assert.equal(day.getAttribute('max'), '7');
    day.value = '9';
    day.fire('input');
    assert.match(fieldWrap(form, '星期').querySelector('.err').textContent, /需在 1–7 之间/);
    day.value = '3';
    day.fire('input');
    assert.equal(fieldWrap(form, '星期').querySelector('.err').textContent, '');

    const weekType = fieldWrap(form, '周型').querySelector('select');
    assert.ok(weekType, '枚举字段要渲染成下拉');
    assert.equal([...weekType.querySelectorAll('option')].map((item) => item.textContent).join('/'), '每周/单周/双周');
    weekType.value = 'even';
    weekType.fire('change');
    assert.equal(layer.draft().week_type, 'even');

    const swatches = fieldWrap(form, '颜色').querySelector('.swatches');
    assert.equal(swatches.querySelectorAll('button').length, PALETTE.length, '色板数量要与 PALETTE 一致');
    const pick = swatches.querySelectorAll('button')[2];
    pick.fire('click');
    assert.equal(layer.draft().color, PALETTE[2]);
    assert.equal(pick.getAttribute('aria-pressed'), 'true');
    assert.equal(swatches.querySelectorAll('button')[0].getAttribute('aria-pressed'), 'false');

    const note = fieldWrap(form, '备注').querySelector('textarea');
    assert.ok(note, '长文本要用多行输入');
    assert.equal(note.getAttribute('maxlength'), '300');
    note.value = 'x'.repeat(301);
    note.fire('input');
    assert.match(fieldWrap(form, '备注').querySelector('.err').textContent, /最长 300 个字符/);

    const time = fieldWrap(form, '开始时间').querySelector('input');
    assert.equal(time.getAttribute('type'), 'time');
    time.value = '25:00';
    time.fire('input');
    assert.match(fieldWrap(form, '开始时间').querySelector('.err').textContent, /格式应为 08:00/);

    const taskLayer = openLayer({
      title: '新增日程',
      fields: fieldsFor('tasks', {
        only: ['done'],
        overrides: { done: { onLabel: '已完成', offLabel: '未完成' } },
      }),
      values: { done: false },
      onSubmit: async () => {},
    });
    const toggle = taskLayer.body.querySelector('button');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.textContent, '未完成', '开关按钮要显示当前状态文字');
    toggle.fire('click');
    assert.equal(taskLayer.draft().done, true);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.textContent, '已完成');
  });
});

test('S3 浮层表单：草稿回填初始值，pending 期间不重复提交', async () => {
  await withDom(async () => {
    const { openLayer, fieldsFor } = await import('../../web/lib/ui.js');
    const drafts = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const layer = openLayer({
      title: '编辑日程',
      fields: fieldsFor('tasks', { only: ['title', 'category'] }),
      values: { title: '原有标题', category: '作业' },
      onSubmit: async (draft) => { drafts.push(draft); await gate; },
    });
    const form = layer.body.querySelector('form');
    assert.equal(fieldWrap(form, '标题').querySelector('input').value, '原有标题', '编辑时没有回填原值');
    const select = fieldWrap(form, '分类').querySelector('select');
    assert.ok(select, '枚举字段要渲染成下拉');
    assert.equal([...select.querySelectorAll('option')].map((item) => item.textContent).join('/'), '未设定/作业/科研/生活/其它');

    form.fire('submit');
    await settle(2);
    assert.equal(drafts.length, 1);
    assert.deepEqual({ ...drafts[0] }, { title: '原有标题', category: '作业' });
    const submit = layer.foot.querySelectorAll('button').at(-1);
    assert.equal(submit.disabled, true, '提交中要禁用按钮');
    assert.equal(submit.textContent, '正在保存…');
    form.fire('submit');
    form.fire('submit');
    await settle(2);
    assert.equal(drafts.length, 1, 'pending 期间的重复点击造成了二次提交');
    release();
    await settle(3);
    assert.equal(document.querySelector('.layer-veil'), null, '完成后浮层没有卸载');
  });
});

test('S3 保存按钮在表单外面：点它必须真的提交（浏览器靠 form 属性关联，不看 DOM 位置）', async () => {
  await withDom(async () => {
    const { openLayer, fieldsFor } = await import('../../web/lib/ui.js');
    const submitted = [];
    const layer = openLayer({
      title: '新建课程',
      fields: fieldsFor('courses', { only: ['name'] }),
      values: { name: '高等数学' },
      onSubmit: async (draft) => { submitted.push(draft); },
    });
    const form = layer.body.querySelector('form');
    const submit = layer.foot.querySelectorAll('button').at(-1);
    assert.ok(form.id, '表单没有 id，放在外面的按钮无法关联');
    assert.equal(submit.getAttribute('form'), form.id, '保存按钮没有用 form 属性指向表单');
    assert.equal(submit.getAttribute('type'), 'submit');
    assert.equal(form.querySelectorAll('button').length, 0, '按钮结构上确实不在 form 里，关联只能靠属性');

    submit.click();
    await settle(3);
    assert.deepEqual(submitted, [{ name: '高等数学' }], '点保存没有真的提交表单');
    assert.equal(document.querySelector('.layer-veil'), null, '提交完成后浮层没有卸载');

    // 两层浮层叠着时 id 不能重复，否则按钮会提交到别人的表单
    const second = openLayer({ title: 'A', fields: [], onSubmit: async () => {} });
    const third = openLayer({ title: 'B', fields: [], onSubmit: async () => {} });
    assert.notEqual(second.body.querySelector('form').id, third.body.querySelector('form').id);
    const firstDraft = [];
    const gated = openLayer({ title: 'C', fields: [], onSubmit: async (draft) => { firstDraft.push(draft); } });
    gated.foot.querySelectorAll('button').at(-1).click();
    await settle(3);
    assert.equal(firstDraft.length, 1, '新浮层的按钮提交到了别的表单');
  });
});

test('S3 浮层表单：字段级错误落在字段上，其他错误走整体提示，浮层都保留', async () => {
  await withDom(async () => {
    const { openLayer, fieldsFor, layerIsOpen } = await import('../../web/lib/ui.js');
    const { ApiError } = await import('../../web/lib/api.js');
    const layer = openLayer({
      title: '新增日程',
      fields: fieldsFor('tasks', { only: ['title', 'category'] }),
      values: { title: '重复的标题' },
      onSubmit: async () => { throw new ApiError('该分类不存在', 'invalid_input', { field: 'category' }); },
    });
    const form = layer.body.querySelector('form');
    form.fire('submit');
    await settle(3);
    assert.equal(layerIsOpen(), true);
    assert.ok(fieldWrap(form, '分类').classList.contains('invalid'));
    assert.equal(fieldWrap(form, '分类').querySelector('.err').textContent, '该分类不存在');
    assert.equal(layer.body.querySelector('.notice').hidden, true, '字段级错误不该同时弹整体提示');
    assert.equal(layer.foot.querySelectorAll('button').at(-1).textContent, '重试保存');
    assert.equal(fieldWrap(form, '标题').querySelector('input').value, '重复的标题', '失败后输入内容要保留');

    const other = openLayer({
      title: '新增日程',
      fields: fieldsFor('tasks', { only: ['title'] }),
      values: { title: '随便' },
      onSubmit: async () => { throw new ApiError('这一类记录已达上限，请先清理后再添加', 'table_full'); },
    });
    other.body.querySelector('form').fire('submit');
    await settle(3);
    const notice = other.body.querySelector('.notice');
    assert.equal(notice.hidden, false);
    assert.equal(notice.textContent, '这一类记录已达上限，请先清理后再添加');
    assert.equal(layerIsOpen(), true);
  });
});

test('S3 浮层：Esc 关最上层，点遮罩关闭、点内部不关，抽屉下拉过阈值关闭', async () => {
  await withDom(async () => {
    const { openLayer, fieldsFor, closeTopLayer, layerIsOpen } = await import('../../web/lib/ui.js');
    const results = [];
    const outer = openLayer({ title: '外层', fields: fieldsFor('tasks', { only: ['title'] }), onSubmit: async () => {} });
    outer.onDismiss = (result) => results.push(`outer:${result.submitted}`);
    const inner = openLayer({ title: '内层', fields: fieldsFor('tasks', { only: ['title'] }), onSubmit: async () => {} });
    inner.onDismiss = (result) => results.push(`inner:${result.submitted}`);
    assert.equal(document.querySelectorAll('.layer-veil').length, 2);
    assert.equal(document.documentElement.getAttribute('data-layers'), '2', '两层浮层时背景滚动要锁住');
    assert.equal(closeTopLayer(), true);
    assert.equal(layerIsOpen(), true, 'Esc 只关最上面一层');
    assert.equal(document.documentElement.getAttribute('data-layers'), '1');
    closeTopLayer();
    assert.deepEqual(results, ['inner:false', 'outer:false']);
    assert.equal(closeTopLayer(), false, '没有浮层时不该吞掉 Esc');
    assert.equal(document.documentElement.hasAttribute('data-layers'), false, '浮层全关后要解锁背景滚动');

    // 移动端底部抽屉：抓住把手向下拖超过阈值即关闭
    const drawer = openLayer({ title: '抽屉', fields: fieldsFor('tasks', { only: ['title'] }), onSubmit: async () => {} });
    const grabber = drawer.element.querySelector('.grabber');
    assert.ok(grabber, '浮层缺少下拉把手');
    grabber.fire('pointerdown', { clientY: 100 });
    emitWindow('pointermove', { clientY: 220 });
    assert.equal(drawer.element.style.transform, 'translateY(120px)', '下拉过程要有跟手的位移反馈');
    emitWindow('pointerup', {});
    assert.equal(layerIsOpen(), false, '下拉超过 90px 应关闭抽屉');
    assert.equal(drawer.element.style.transform, '');
    assert.equal(winHandlers.get('pointermove')?.length, 0, '抽屉关闭后要摘掉 window 上的下拉监听');
    assert.equal(winHandlers.get('pointerup')?.length, 0, '抽屉关闭后要摘掉 window 上的抬起监听');

    const shallow = openLayer({ title: '浅拉', fields: fieldsFor('tasks', { only: ['title'] }), onSubmit: async () => {} });
    shallow.element.querySelector('.grabber').fire('pointerdown', { clientY: 100 });
    emitWindow('pointermove', { clientY: 150 });
    emitWindow('pointerup', {});
    assert.equal(layerIsOpen(), true, '没拉够阈值不该关闭');
    assert.equal(shallow.element.style.transform, '', '回弹要清掉位移');
    closeTopLayer();

    const veilTest = openLayer({ title: '遮罩', fields: fieldsFor('tasks', { only: ['title'] }), onSubmit: async () => {} });
    const veil = document.querySelectorAll('.layer-veil').at(-1);
    veilTest.element.querySelector('h2').fire('pointerdown');
    assert.equal(layerIsOpen(), true, '点浮层内部不该关闭');
    veil.fire('pointerdown');
    assert.equal(layerIsOpen(), false, '点遮罩空白处应关闭');
  });
});

test('S3 确认框：requireText 未输入前确认按钮禁用，取消与确认分别给出结果', async () => {
  await withDom(async () => {
    const { confirmDialog, layerIsOpen } = await import('../../web/lib/ui.js');
    const plain = confirmDialog({ title: '删除日程', message: '确定删除「交作业」？', detail: '其子任务会一并删除' });
    assert.equal(layerIsOpen(), true);
    const layer = document.querySelector('.layer');
    assert.equal(layer.querySelector('.layer-head h2').textContent, '删除日程');
    assert.ok(texts(layer).includes('其子任务会一并删除'));
    assert.ok(layer.querySelector('.grabber'), '确认框在手机上也要能下拉关闭');
    const buttons = layer.querySelectorAll('.layer-foot button');
    assert.equal([...buttons].map((item) => item.textContent).join('/'), '返回/确认删除');
    buttons[0].fire('click');
    assert.equal(await plain, false, '取消应返回 false');

    const gated = confirmDialog({ title: '清空全部数据', message: '此操作不可撤销', requireText: 'DELETE' });
    const dialog = document.querySelector('.layer');
    const confirm = [...dialog.querySelectorAll('.layer-foot button')].at(-1);
    assert.equal(confirm.disabled, true, '未输入确认词时确认按钮必须禁用');
    const input = dialog.querySelector('.field input');
    input.value = 'delete';
    input.fire('input');
    assert.equal(confirm.disabled, true, '确认词区分大小写，小写不算');
    input.value = ' DELETE ';
    input.fire('input');
    assert.equal(confirm.disabled, false, '两侧空白应被忽略');
    confirm.fire('click');
    assert.equal(await gated, true);
    assert.equal(layerIsOpen(), false);
  });
});

test('S3 Toast：撤销按钮回调后收起；错误提示可手动关闭且带 alert 语义', async () => {
  await withDom(async () => {
    const { toast } = await import('../../web/lib/ui.js');
    let undone = 0;
    toast('已删除「写周报」', { action: '撤销', onAction: () => { undone += 1; }, duration: 0 });
    const root = document.getElementById('toast-root');
    const node = root.querySelector('.toast');
    assert.equal(node.getAttribute('role'), 'status');
    assert.equal(node.querySelector('span').textContent, '已删除「写周报」');
    node.querySelector('button').fire('click');
    assert.equal(undone, 1);
    assert.equal(root.querySelector('.toast'), null, '撤销后要立即收起提示');

    toast('保存失败，请重试', { kind: 'error', duration: 0 });
    const error = root.querySelector('.toast');
    assert.equal(error.getAttribute('role'), 'alert');
    assert.ok(error.classList.contains('error'));
    const close = [...error.querySelectorAll('button')].at(-1);
    assert.equal(close.getAttribute('aria-label'), '关闭提示');
    close.fire('click');
    assert.equal(root.querySelector('.toast'), null);

    // duration>0 时到期自动消失，不留下永久遮挡内容的提示
    toast('已同步最新数据', { duration: 1 });
    assert.ok(root.querySelector('.toast'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(root.querySelector('.toast'), null, '提示到期后要自动消失');
  });
});

test('S3 左滑删除只在触屏挂载，滑出后点删除才触发回调', async () => {
  await withDom(async () => {
    const { swipeDelete } = await import('../../web/lib/ui.js');
    const saved = globalThis.matchMedia;
    globalThis.matchMedia = () => ({ matches: true });
    let desktop = 0;
    const deskRow = document.createElement('div');
    deskRow.className = 'list-row';
    swipeDelete(deskRow, { onDelete: () => { desktop += 1; } });
    assert.equal(deskRow.querySelector('.list-delete'), null, '桌面端不该挂出滑动删除按钮');
    deskRow.fire('pointerdown', { clientX: 300 });
    deskRow.fire('pointermove', { clientX: 100 });
    assert.equal(desktop, 0);

    globalThis.matchMedia = saved;
    let deleted = 0;
    const row = document.createElement('div');
    row.className = 'list-row';
    row.appendChild(document.createElement('span'));
    swipeDelete(row, { label: '删除', onDelete: () => { deleted += 1; } });
    assert.ok(row.classList.contains('swipeable'));
    const button = row.querySelector('.list-delete');
    assert.equal(button.textContent, '删除');
    row.fire('pointerdown', { clientX: 300 });
    row.fire('pointermove', { clientX: 230 });
    assert.ok(row.classList.contains('swiping'));
    row.fire('pointerup');
    assert.ok(row.classList.contains('swiping'), '滑出到位后删除按钮保持可见');
    button.fire('click');
    assert.equal(deleted, 1);
    assert.equal(row.classList.contains('swiping'), false, '删除后要收回滑动状态');

    row.fire('pointerdown', { clientX: 300 });
    row.fire('pointermove', { clientX: 290 });
    row.fire('pointerup');
    assert.equal(row.classList.contains('swiping'), false, '没滑过阈值就松手应自动回弹');

    // 起点落在控件上时不抢手势，避免和勾选/编辑按钮冲突
    const nested = document.createElement('button');
    row.appendChild(nested);
    nested.fire('pointerdown', { clientX: 300 });
    row.fire('pointermove', { clientX: 100 });
    assert.equal(row.classList.contains('swiping'), false);
  });
});
