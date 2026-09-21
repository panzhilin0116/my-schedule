// S9 的界面部分：HUD 完成环跟着勾选走、下一站倒计时的文字与 data 戳同源、
// 今日课程的当前时间指示线与已结束半透明、四分区数字与明细页逐项一致（完成标准 1）、
// 长按拖拽与上移/下移改卡片顺序（只存本地偏好）、周末空态、外壳的定时重算。
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_NAMES } from '../../functions/registry.mjs';
import { createPreviewServer } from '../preview-server.mjs';
import { createApi } from '../../web/lib/api.js';
import { createStore } from '../../web/lib/store.js';
import * as T from '../../web/lib/time.js';
import { read } from './helpers.mjs';
import {
  withDom, seedState, stateFrom, liveCtx, fakeCtx, texts, assertNoBlankLabels,
  TIME, TODAY, toastTexts, waitUntil, settle, viewArgs, app, intervals, prefs, go, topTitle,
} from './render-harness.mjs';

const HOLD = 380;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const emptyTables = () => Object.fromEntries(TABLE_NAMES.map((name) => [name, []]));
const click = (node) => node.click();
const byAria = (node, label) => node.querySelectorAll('button').find((item) => item.getAttribute('aria-label') === label);
const cardOf = (node, key) => node.querySelectorAll('.home-grid .panel')
  .find((item) => item.dataset.card === key);
const headOf = (node, key) => cardOf(node, key).querySelector('.panel-head');
const rowsOf = (node, key) => cardOf(node, key).querySelectorAll('.list-row');
const titlesOf = (node, key) => rowsOf(node, key).map((row) => row.querySelector('.title').textContent);
const keysOf = (nodes) => nodes.map((item) => item.dataset.card);
const orderOf = (node) => keysOf(node.querySelectorAll('.home-grid .panel'));
const ringText = (node) => node.querySelector('[data-chart="ring"] .ring-label span').textContent;
const ringState = (node) => node.querySelector('[data-chart="ring"]').className;
const countdown = (node) => node.querySelector('[data-countdown]');
const DEFAULT_ORDER = ['courses', 'tasks', 'milestones', 'workouts'];

const CONFIG = { id: 'cfg', start_date: '2026-09-14', total_weeks: 18, periods: [] };

const home = async (run, { state = null, seed = true } = {}) => withDom(async () => {
  const { renderHome } = await import('../../web/views/home.js');
  const appState = state ?? (seed ? seedState(TODAY) : null);
  const helpers = liveCtx(appState);
  const render = () => renderHome(viewArgs.home(appState, helpers.ctx));
  return run({ render, state: appState, ...helpers });
});

/** 只放课程与节次需要的那几张表，其余表留空，方便把首页其余卡片逼成空态。 */
const tablesWith = (tables) => {
  const full = emptyTables();
  for (const [name, rows] of Object.entries(tables)) full[name] = rows;
  full.semester_config = [CONFIG];
  return stateFrom(full, { config: CONFIG });
};

const course = (name, startTime, endTime, extra = {}) => ({
  id: name, name, teacher: '陈致远', location: 'A415', day_of_week: 7,
  start_time: startTime, end_time: endTime, week_type: 'all', start_week: 1, end_week: 18,
  color: '#3DD6F5', note: null, sort: 0, ...extra,
});

// ── HUD 完成环 ────────────────────────────────────────────

test('S9 HUD：日期星期、周次奇偶、完成环比例与分项数字全部来自同一批算式', async () => {
  await home(async ({ render, state }) => {
    const node = render();
    const hud = node.querySelector('.hud');
    assert.equal(hud.querySelector('.readout b').textContent, '9月20日 周日');
    assert.equal(hud.querySelector('.week').textContent, '第 5 周 / 共 18 周 · 单周');
    const progress = T.todayProgress(state.tables.tasks, TODAY);
    assert.equal(hud.querySelector('.sub').textContent, `今日待办 ${progress.done}/${progress.total} 已完成`);

    const ring = hud.querySelector('[data-chart="ring"]');
    assert.ok(ring, 'HUD 里没有今日完成进度环');
    assert.equal(ringText(node), `${progress.ratio}%`);
    assert.equal(ring.querySelector('.ring-label small').textContent, `${progress.done}/${progress.total}`);
    assert.equal(ring.querySelector('.ring-svg').getAttribute('aria-hidden'), 'true', '环只是同一批数字的另一副面孔');
    assert.equal(ring.classList.contains('is-warn'), true, '0/6 是警示色，不该看起来像已经完成');
    assert.equal(ring.getAttribute('title'), `今日完成 ${progress.ratio}%`, '环要有自己的名字，读屏才知道它在讲什么');
    assert.equal(hud.children[1], ring.closest('.ring-row'), '环要摆在日期读数与下一站中间（PRD 3 的 A 区）');
  });
});

test('S9 完成环跟着勾选走：勾掉一条前进一格，全勾完变成功配色', async () => {
  await home(async ({ render, state }) => {
    const progress = T.todayProgress(state.tables.tasks, TODAY);
    assert.equal(progress.total, 6);

    // 今日卡片里的每一条都从"当前渲染出来的行"里挑：逾期的勾掉就离开今日列表（PRD 6）
    const tickRow = async (title) => {
      const tick = rowsOf(render(), 'tasks')
        .find((row) => row.querySelector('.title').textContent === title)?.querySelector('.tick');
      assert.ok(tick, `今日卡片里找不到这条待办：${title}`);
      click(tick);
      await settle(3);
    };

    for (const task of state.tables.tasks.filter((item) => item.due_date === TODAY && !item.done)) {
      await tickRow(task.title);
    }
    let node = render();
    assert.equal(ringText(node), '50%', '勾掉 3 条今天到期的待办：分母仍是 6');
    assert.equal(node.querySelector('[data-chart="ring"]').classList.contains('is-warn'), false);
    assert.equal(cardOf(node, 'tasks').querySelectorAll('.list-row.is-done').length, 3, '完成的要在卡片里划线沉住，而不是消失');

    for (let guard = 0; guard < 10; guard += 1) {
      const pending = rowsOf(render(), 'tasks').find((row) => row.querySelector('.tick').getAttribute('aria-checked') === 'false');
      if (!pending) break;
      await tickRow(pending.querySelector('.title').textContent);
    }
    node = render();
    assert.equal(ringText(node), '100%');
    assert.equal(ringState(node).includes('is-ok'), true, '今日清完要用成功配色');
    assert.equal(orderOf(node).join(','), DEFAULT_ORDER.join(','), '勾选待办不该动卡片顺序');
  });
});

// ── 下一站倒计时 ──────────────────────────────────────────

test('S9 下一站：逾期最早的待办优先，退到里程碑，再退到空文案', async () => {
  await home(async ({ render, state }) => {
    const next = T.nextDueItem(state.tables.tasks, state.tables.milestones, TODAY);
    assert.equal(next.kind, 'task');
    assert.equal(next.title, '报销实验器材', '逾期的那条才是下一站');
    let node = render();
    assert.equal(node.querySelector('.next .label').textContent, 'NEXT DEADLINE');
    const stamp = `${next.date}T${next.time ?? '23:59'}:00`;
    assert.equal(countdown(node).dataset.countdown, stamp, '界面上那段文字没有带上它对应的时刻戳');
    assert.equal(countdown(node).textContent, T.countdownText(stamp, TIME.now));
    assert.match(node.querySelector('.next .remain').textContent, /^9月15日 周二 · .+/);

    // 待办清完 → 退到最近未完成的里程碑
    for (const task of state.tables.tasks) if (!task.done) task.done = true;
    node = render();
    assert.equal(node.querySelector('.next .label').textContent, 'NEXT MILESTONE');
    assert.equal(node.querySelector('.next .title').textContent, '数据集整理与标注');
    assert.equal(countdown(node).dataset.countdown, '2026-09-23T23:59:00', '里程碑没有截止日期，该按当天 23:59 算');

    for (const milestone of state.tables.milestones) milestone.status = 'done';
    node = render();
    assert.equal(cardOf(node, 'milestones').querySelector('.empty p').textContent, '暂无进行中的里程碑');
    assert.equal(node.querySelector('.next .title').textContent, '今天没有到期事项');
    assert.equal(countdown(node), null, '没有下一站时不该留一个还在倒计时的读数');
  });
});

// ── 今日课程：时间序 + 当前时间指示线 ──────────────────────

const dayAt = (hhmm) => ({ today: TODAY, now: new Date(`${TODAY}T${hhmm}:00`) });

const withCourses = async (run, courses) => {
  const { renderHome } = await import('../../web/views/home.js');
  const state = tablesWith({ courses });
  const { ctx } = fakeCtx();
  const render = (time) => renderHome({ state, ctx, time });
  return run({ render, state });
};

test('S9 今日课程：按时间竖排、已结束 45% 透明、当前时间指示线插在两段之间', async () => {
  await withDom(async () => {
    const courses = [
      course('线性代数', '08:00', '09:40'),
      course('创新创业实践', '19:00', '20:40'),
      course('计算机网络', '10:00', '11:40'),
    ];
    await withCourses(async ({ render }) => {
      for (const [hhmm, expected] of [['08:30', 0], ['12:30', 2], ['21:00', 3]]) {
        const node = render(dayAt(hhmm));
        const list = cardOf(node, 'courses').querySelector('.card-list');
        assert.equal(list.children.filter((item) => item.classList.contains('nowline')).length, 1,
          `${hhmm} 时指示线要恰好一条`);
        const at = list.children.findIndex((item) => item.classList.contains('nowline'));
        assert.equal(at, expected, `${hhmm} 时指示线位置不对：${list.children.map((item) => item.className).join('|')}`);
      }

      const node = render(dayAt('12:30'));
      assert.deepEqual(titlesOf(node, 'courses'), ['线性代数', '计算机网络', '创新创业实践'], '课程要按开始时间排，不是按录入顺序');
      const rows = rowsOf(node, 'courses');
      assert.equal(rows[0].classList.contains('is-past'), true, '已经下课的要半透明');
      assert.equal(rows[1].classList.contains('is-past'), true);
      assert.equal(rows[2].classList.contains('is-past'), false, '还没开始的不要半透明');
      assert.equal(cardOf(node, 'courses').querySelector('.nowline .t').textContent, '12:30');
      assert.equal(rows[0].classList.contains('hide-sm'), false, '移动端保留前两条');
      assert.equal(rows[1].classList.contains('hide-sm'), false);
      assert.equal(rows[2].classList.contains('hide-sm'), true, '第 3 条起在手机上收起来（PRD 3）');
      assert.equal(rows.length, 3, '标记 hide-sm 只是收起来，条目本身还在');
    }, courses);
  });
});

test('S9 今日课程：不在校时间内也有指示线，全天空着就是空态', async () => {
  await withDom(async () => {
    await withCourses(async ({ render }) => {
      assert.equal(render(dayAt('07:00')).querySelector('.nowline .t').textContent, '07:00');
      assert.equal(cardOf(render(dayAt('07:00')), 'courses').querySelectorAll('.list-row').length, 2);
    }, [course('早八体育', '08:00', '09:40'), course('晚间研讨', '20:00', '21:30')]);

    await withCourses(async ({ render }) => {
      const node = render(dayAt('12:30'));
      const body = cardOf(node, 'courses');
      assert.ok(body.querySelector('.empty'), '没有课的一天要显示空态');
      assert.equal(body.querySelector('.empty p').textContent, '今天没有课');
      assert.equal(body.querySelectorAll('.nowline').length, 0, '没课就别画指示线，空态里冒出一条横线很奇怪');
    }, []);

    // 双周这一周不上课，指示线也不该跟着出现
    await withCourses(async ({ render }) => {
      const node = render({ today: '2026-09-21', now: new Date('2026-09-21T12:30:00') });
      assert.equal(cardOf(node, 'courses').querySelector('.empty p').textContent, '今天没有课');
    }, [course('单周才有的课', '08:00', '09:40', { day_of_week: 1, week_type: 'odd' })]);
  });
});

// ── 四分区与明细页一致（完成标准 1）────────────────────────

test('S9 四分区数字与明细页逐项一致：课程、待办、里程碑、健身（C14）', async () => {
  await home(async ({ render, state }) => {
    const node = render();
    const week = T.weekOf(TODAY, state.config);

    assert.deepEqual(titlesOf(node, 'courses'),
      T.coursesOnDay(state.tables.courses, week, TODAY).filter((item) => item.active).map((item) => item.name));

    const { renderTasks } = await import('../../web/views/tasks.js');
    const tasksPage = renderTasks(viewArgs.tasks(state, liveCtx(state).ctx));
    assert.deepEqual(titlesOf(node, 'tasks'),
      [...tasksPage.querySelectorAll('.list-row .title')].map((item) => item.textContent).filter((title) =>
        T.tasksForDay(state.tables.tasks, TODAY).some((task) => task.title === title)),
      '首页今日待办的集合与日程页今日段不是同一批');
    assert.equal(titlesOf(node, 'tasks')[0], '报销实验器材', '逾期的要排最前');
    assert.ok(cardOf(node, 'tasks').querySelectorAll('.list-row.is-overdue').length, '逾期项要有橙色左边框');

    const recent = T.openMilestones(state.tables.milestones)
      .sort((a, b) => `${a.target_date ?? '9999-12-31'}`.localeCompare(`${b.target_date ?? '9999-12-31'}`)).slice(0, 3);
    assert.deepEqual(titlesOf(node, 'milestones'), recent.map((item) => item.title));
    assert.deepEqual(cardOf(node, 'milestones').querySelectorAll('.num').map((item) => item.textContent),
      recent.map((item) => `${T.progressOf(item)}%`));

    const { renderWorkout } = await import('../../web/views/workout.js');
    const workoutPage = renderWorkout(viewArgs.workout(state, liveCtx(state).ctx));
    const homeRead = Object.fromEntries(cardOf(node, 'workouts').querySelectorAll('.readout-cell')
      .map((cell) => [cell.querySelector('.k').textContent, cell.querySelector('.v').textContent]));
    const pageRead = Object.fromEntries(workoutPage.querySelectorAll('.readout-cell')
      .map((cell) => [cell.querySelector('.k').textContent, cell.querySelector('.v').textContent]));
    assert.equal(homeRead['次数'], pageRead['次数']);
    assert.equal(homeRead['时长'], pageRead['总时长']);
    assert.equal(homeRead['连续天数'], pageRead['连续天数']);
    const stats = T.workoutStats(state.tables.workouts, T.currentWeekRange(state.config, TODAY));
    assert.equal(texts(cardOf(node, 'workouts').querySelector('.quick-read')),
      `有练 ${stats.activeDays} 天 · 完成 ${stats.done} · 部分 ${stats.partial} · 缺练 ${stats.missed}`);
    assert.ok(texts(workoutPage).includes('缺练不计入时长'), '两处都写着同一句口径说明');
  });
});

// ── 卡片顺序（长按拖拽 + 上移/下移）────────────────────────

test('S9 卡片顺序：默认 2×2 顺序，上移/下移按钮立刻写进本地偏好', async () => {
  await home(async ({ render, writes }) => {
    let node = render();
    assert.deepEqual(orderOf(node), DEFAULT_ORDER);
    assert.equal(byAria(cardOf(node, 'courses'), '上移卡片：今日课程').disabled, true, '已经在第一位还让点上移');
    assert.equal(byAria(cardOf(node, 'workouts'), '下移卡片：本周健身').disabled, true);

    click(byAria(cardOf(node, 'workouts'), '上移卡片：本周健身'));
    node = render();
    assert.deepEqual(orderOf(node), ['courses', 'tasks', 'workouts', 'milestones']);
    assert.deepEqual(writes.filter((item) => item.op === 'pref').at(-1),
      { op: 'pref', key: 'ui.homeCardOrder', value: ['courses', 'tasks', 'workouts', 'milestones'] });
    assert.equal(texts(node).includes('卡片顺序已保存'), false, '按钮路径不必弹提示，位置变化就是反馈');

    click(byAria(cardOf(node, 'milestones'), '上移卡片：近期里程碑'));
    assert.deepEqual(orderOf(render()), ['courses', 'tasks', 'milestones', 'workouts']);
    // 顺序是 UI 偏好，绝不碰业务数据
    assert.deepEqual(writes.filter((item) => item.op !== 'pref'), []);
  });
});

test('S9 卡片顺序：长按 380ms 进入拖拽，划过别的卡片就换位，抬手才保存', async () => {
  await home(async ({ render, state, writes, prefs: local }) => {
    // 拖拽态活在这一次渲染的闭包里：中途再 render() 一次等于换个人重画，高亮会丢，
    // 所以整段只盯着这一棵子树（paint() 就地重挂 .home-grid，容器身份不变）。
    const nodes = render();
    const grid = () => nodes.querySelector('.home-grid');
    assert.deepEqual(orderOf(nodes), DEFAULT_ORDER);

    // 普通点击（没按住）不该误进排序模式
    headOf(nodes, 'courses').fire('pointerdown', { button: 0 });
    headOf(nodes, 'courses').fire('pointerup', {});
    await sleep(HOLD + 60);
    assert.equal(grid().querySelector('.is-sorting'), null, '松手比按住还快，这只是一次普通点击');
    assert.equal(writes.some((item) => item.op === 'pref'), false);

    headOf(nodes, 'courses').fire('pointerdown', { button: 0 });
    await sleep(HOLD + 60);
    let first = grid();
    assert.equal(first.children[0].classList.contains('is-sorting'), true, '长按到时间后要看出这一张正在被拖');
    assert.equal(writes.some((item) => item.op === 'pref'), false, '拖的过程中先别写偏好，中途放弃要能当作没发生');

    first.children[2].fire('pointerover', {});
    first = grid();
    assert.deepEqual(keysOf(first.children), ['tasks', 'milestones', 'courses', 'workouts']);
    assert.equal(first.children[2].classList.contains('is-sorting'), true, '拖到哪张，高亮就要跟到哪张');

    // 拖到最后一张再抬手
    first.children[3].fire('pointerover', {});
    grid().children[3].fire('pointerup', {});
    assert.deepEqual(keysOf(grid().children), ['tasks', 'milestones', 'workouts', 'courses']);
    assert.deepEqual(local.get('ui.homeCardOrder'), ['tasks', 'milestones', 'workouts', 'courses']);
    assert.ok(toastTexts().some((text) => text.includes('卡片顺序已保存')), toastTexts().join('|'));
    assert.equal(grid().querySelector('.is-sorting'), null, '抬手之后要退出拖拽态');

    // 顺序只活在这份偏好里，业务表一笔都没动
    assert.deepEqual(writes.filter((item) => item.op !== 'pref'), []);
    assert.equal(state.tables.courses.length, 13);
  });
});

test('S9 卡片顺序：换一份 ctx 相当于刷新，顺序从偏好里读回来；偏好脏了也不白屏', async () => {
  let saved = null;
  await home(async ({ render, writes }) => {
    click(byAria(render(), '下移卡片：今日课程'));
    assert.deepEqual(orderOf(render()), ['tasks', 'courses', 'milestones', 'workouts']);
    saved = writes.filter((item) => item.op === 'pref').at(-1).value;
  });
  await withDom(async () => {
    const { renderHome, normalizeOrder } = await import('../../web/views/home.js');
    const state = seedState(TODAY);
    const store = { ...liveCtx(state).ctx.store, pref: (key, fallback) => (key === 'ui.homeCardOrder' ? saved : fallback) };
    assert.deepEqual(orderOf(renderHome(viewArgs.home(state, { store }))), ['tasks', 'courses', 'milestones', 'workouts'],
      '刷新后卡片顺序没有从本地偏好读回来');
    assert.deepEqual(normalizeOrder(['tasks', 'nope']), ['tasks', 'courses', 'milestones', 'workouts']);

    // 移动端每卡只留前 2 条：靠 CSS 收，窗口缩放不必重绘
    const css = await read('../../web/styles.css');
    assert.ok(/\.hide-sm\s*\{\s*display:\s*none/.test(css), '没有 .hide-sm 的收起规则');
    assert.ok(css.includes('@media (max-width: 639px)'), '缺少手机断点');
  });
});

// ── 空态（完成标准 3）─────────────────────────────────────

test('S9 周末空态：四张卡各自给出引导，而不是四块空白', async () => {
  await home(async ({ render }) => {
    const node = render();
    for (const key of DEFAULT_ORDER) {
      const card = cardOf(node, key);
      assert.ok(texts(card).trim().length > 8, `${key} 卡片是空的`);
    }
    assert.equal(cardOf(node, 'courses').querySelector('.empty p').textContent, '今天没有课');
    assert.ok(texts(cardOf(node, 'courses')).includes('好好安排这一天'));
    assert.equal(cardOf(node, 'tasks').querySelector('.empty p').textContent, '今天没有待办');
    assert.equal(cardOf(node, 'milestones').querySelector('.empty p').textContent, '暂无进行中的里程碑');
    assert.deepEqual(cardOf(node, 'workouts').querySelectorAll('.readout-cell .v').map((item) => item.textContent),
      ['0', '0 分钟', '0'], '没有训练记录时读数要归零而不是留空');
    assert.equal(node.querySelector('[data-chart="ring"] .ring-label span').textContent, '0%');
    assert.equal(node.querySelector('[data-chart="ring"]').classList.contains('is-warn'), false,
      '一条待办都没有不是警示，别用橙色吓人');
    assert.equal(node.querySelector('.next .title').textContent, '今天没有到期事项');
    assertNoBlankLabels(node, '首页空态');
  }, { state: tablesWith({}) });
});

test('S9 首页渲染不留空标题位，图标都是合法 SVG', async () => {
  await home(async ({ render }) => {
    const node = render();
    assertNoBlankLabels(node, '首页');
    assert.ok(node.querySelectorAll('.card-sort .icon').length >= 8, '每张卡都要有上移/下移入口');
    for (const item of node.querySelectorAll('svg.icon')) {
      assert.equal(item.namespaceURI, 'http://www.w3.org/2000/svg');
      assert.equal(item.getAttribute('aria-hidden'), 'true', '图标按钮的中文名在 aria-label 上');
    }
  });
});

// ── 外壳：定时重算与切回前台（完成标准 4）─────────────────

test('S9 外壳：每分钟只重写倒计时那一句，切回前台整页重算', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  try {
    await withDom(async (doc) => {
      globalThis.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : `${origin}${input}`, init);
      app.start();
      assert.equal(await waitUntil(() => app.store.state.status === 'ready'), true, '外壳没有回读到数据');
      await go('#/');
      assert.equal(topTitle(), '任务舱');

      const tick = intervals.find((item) => item.ms === 60000);
      assert.ok(tick, '没有注册 60 秒的倒计时重算');
      // 下一站取的是最早那条（含逾期）：已过期的事项倒计时只会停在「就在现在」，
      // 先把它们结掉，让它落到一条还没到的事项上
      const startedAt = Date.now();
      for (const task of app.store.state.tables.tasks) {
        if (task.done || !task.due_date) continue;
        if (Date.parse(`${task.due_date}T${task.due_time ?? '23:59'}:00`) > startedAt) continue;
        await app.store.update('tasks', task.id, { done: true, done_at: new Date().toISOString() });
      }
      app.render();

      const view = document.getElementById('view');
      const before = view.children[0];
      const node = countdown(view);
      assert.ok(node, '清掉过期事项后首页没有倒计时读数');
      assert.ok(Date.parse(node.dataset.countdown) > Date.now(), '下一站要落在还没到的时刻');
      const text = node.textContent;
      mock.timers.enable({ apis: ['Date'], now: Date.now() + 3600000 });
      try {
        tick.handler();
        assert.notEqual(countdown(view).textContent, text, '过了一小时倒计时还停在原文字上');
        assert.equal(countdown(view), node, '倒计时只该改这一小段文字的内容');
        assert.equal(countdown(view).textContent, T.countdownText(node.dataset.countdown, new Date()));
        assert.equal(view.children[0], before, '重算倒计时不该把整页重绘一遍，长按拖拽会被打断');
      } finally {
        mock.reset();
      }

      const first = view.children[0];
      doc.visibilityState = 'visible';
      doc.fire('visibilitychange');
      assert.notEqual(view.children[0], first, '切回前台要按当下时间重绘');

      // store 每次写入后自己回读并通知订阅者（→ render）。不等这一轮落地就退出 withDom，
      // 回读会在还原后的全局上重绘，测试进程退出时拖出一条 document is not defined。
      assert.equal(await waitUntil(() => app.store.state.inflight === 0, 9000), true, '外壳的回读没有落地');
      await settle(4);
    });
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

// ── 真 store 往返（完成标准 2：另一台设备刷新后同步）────────

test('S9 往返：在首页勾掉一条待办，服务端与卡片顺序偏好都落得住', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createApi({ baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1/app` });
  const store = createStore({ api });
  await store.load();
  const today = T.todayKey();
  const time = { today, now: new Date(`${today}T12:00:00`) };
  try {
    await withDom(async () => {
      const { renderHome } = await import('../../web/views/home.js');
      const ctx = { store, navigate: () => {} };
      const render = () => renderHome({ state: store.state, ctx, time });
      // 逾期的那一条勾掉就离开今日列表（PRD 6），所以要挑一条今天到期的来验证"完成"这态
      const target = T.tasksForDay(store.state.tables.tasks, today).find((task) => !task.done && task.due_date === today);
      assert.ok(target, '预览库里要有今天到期且未完成的待办');

      const tick = rowsOf(render(), 'tasks')
        .find((row) => row.querySelector('.title').textContent === target.title)?.querySelector('.tick');
      assert.ok(tick, '首页今日卡片里找不到这条待办');
      click(tick);
      assert.equal(await waitUntil(() => !store.state.pending.length && !store.state.inflight, 9000), true, '勾选没有发出写入');
      await store.refresh();
      const seen = store.row('tasks', target.id);
      assert.equal(seen.done, true, '另一台设备刷新后看不到这条已完成');
      assert.ok(seen.done_at, '完成时间要落库，不能只改布尔值');
      assert.equal(renderHome({ state: store.state, ctx, time }).querySelectorAll('.list-row.is-done').length > 0, true);

      click(byAria(render(), '下移卡片：今日课程'));
      assert.deepEqual(JSON.parse(prefs.get('ui.homeCardOrder')), ['tasks', 'courses', 'milestones', 'workouts'],
        '卡片顺序要按 PRD 7.4 存在 localStorage，而不是发给服务端');
      assert.equal(store.state.pending.length, 0, '偏好不该触发任何写入请求');
    });
  } finally {
    server.close();
  }
});
