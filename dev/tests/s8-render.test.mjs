// S8 的界面部分：记一笔的点击数（C15）、自定义类型进候选、缺练改部分完成让
// 连续天数重新接上（C13）、首页与健身页逐项相等（C14）、区间切换、周分组空档、
// 四张图表的结构，最后用真 store + 真 Function 走一遍往返。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../preview-server.mjs';
import { validateRow } from '../../functions/registry.mjs';
import * as T from '../../web/lib/time.js';
import { createApi } from '../../web/lib/api.js';
import { createStore } from '../../web/lib/store.js';
import {
  withDom, seedState, emptyAppState, liveCtx, texts, assertNoBlankLabels, fieldWrap,
  TIME, TODAY, toastTexts, waitUntil, settle, viewArgs,
} from './render-harness.mjs';

const root = () => globalThis.document.getElementById('modal-root');
const openLayers = () => root().querySelectorAll('.layer');
const layerWith = (title) => openLayers().find((layer) => layer.querySelector('.layer-head h2')?.textContent === title);
const formOf = (layer) => layer.querySelector('form');
const click = (node) => node.click();
const buttonByText = (node, pattern) => node.querySelectorAll('button').find((item) => pattern.test(item.textContent));
const byAria = (node, label) => node.querySelectorAll('button').find((item) => item.getAttribute('aria-label') === label);
const footButtons = (layer) => layer.querySelectorAll('.layer-foot button');
const submitButton = (layer) => footButtons(layer).at(-1);
const cancel = (layer) => click(footButtons(layer)[0]);
const field = (layer, label) => fieldWrap(formOf(layer), label);
// chips 与三态按钮都用 data-value 标自己的取值，中文名字在 textContent 里
const chipIn = (layer, label, value) => field(layer, label)?.querySelectorAll('.chip')
  .find((node) => node.dataset.value === value);
const optionIn = (layer, label, value) => field(layer, label)?.querySelectorAll('button')
  .find((node) => node.dataset.value === value);
const valueOf = (layer, label) => field(layer, label)?.querySelector('input,select,textarea')?.value;
const minutesOf = (layer) => field(layer, '时长(分钟)').querySelector('.stepper .num').textContent;
const readouts = (node) => Object.fromEntries(node.querySelectorAll('.readout-cell')
  .map((cell) => [cell.querySelector('.k').textContent, cell.querySelector('.v').textContent]));
const listRows = (node) => node.querySelectorAll('.card-list .list-row');
const listedDates = (node) => listRows(node).map((row) => row.dataset.date);
// 空档占位行也带日期，只有真记录才该用这个口径
const recordDates = (node) => listRows(node).filter((row) => !row.classList.contains('blank'))
  .map((row) => row.dataset.date);
const groupHeads = (node) => node.querySelectorAll('.group-head h3').map((item) => item.textContent);
const rangeTitle = (node) => node.querySelector('.panel-head h3').textContent;
const segButton = (node, label) => node.querySelectorAll('.seg button').find((item) => item.textContent === label);
const pressed = (node) => node?.getAttribute('aria-pressed') === 'true';

const WINDOW_START = '2026-08-24';
const inRange = (rows, range) => rows.filter((item) => item.workout_date >= range.start && item.workout_date <= range.end);
const weekOf = (state) => T.currentWeekRange(state.config, TODAY);

/** liveCtx 让写操作直接落到 state，于是"点一下 → 重绘 → 读界面上的数字"整条能跑通。 */
const page = async (run, { state = null, seed = true } = {}) => withDom(async () => {
  const { renderWorkout } = await import('../../web/views/workout.js');
  const appState = state ?? (seed ? seedState(TODAY) : emptyAppState());
  const helpers = liveCtx(appState);
  const render = () => renderWorkout(viewArgs.workout(appState, helpers.ctx));
  return run({ render, state: appState, ...helpers });
});

// ── 记一笔（C15）──────────────────────────────────────────

test('S8 记一笔：类型→时长→保存共 3 次点击就落库（C15）', async () => {
  await page(async ({ render, state, writes }) => {
    const node = render();
    click(buttonByText(node, /^记一笔$/));
    const layer = layerWith('记一笔训练');
    assert.ok(layer, '点「记一笔」没有打开表单');

    // 日期=今天、时长=45、完成度=完成，所以只剩类型必须选
    assert.equal(valueOf(layer, '日期'), TODAY);
    assert.equal(minutesOf(layer), '45 分');
    assert.equal(pressed(optionIn(layer, '完成度', 'done')), true, '完成度默认要选中');
    assert.equal(submitButton(layer).disabled, true, '运动类型还没选就该拦住提交，不用等用户点下去才看到红字');

    let clicks = 0;
    click(chipIn(layer, '运动类型', '游泳')); clicks += 1;
    assert.equal(submitButton(layer).disabled, false);
    click(chipIn(layer, '时长(分钟)', '30')); clicks += 1;
    assert.equal(minutesOf(layer), '30 分');
    click(submitButton(layer)); clicks += 1;
    await settle(4);

    assert.equal(clicks, 3, `从打开表单到保存用了 ${clicks} 次点击，超过 3 次`);
    const created = writes.find((item) => item.op === 'create');
    assert.equal(created.table, 'workouts');
    assert.deepEqual(created.row, {
      workout_date: TODAY, type: '游泳', duration_min: 30, status: 'done', note: null,
    });
    const checked = validateRow('workouts', created.row);
    assert.equal(checked.ok, true, `记下的这笔不符合契约：${checked.error}`);
    assert.equal(state.tables.workouts.some((item) => item.type === '游泳'), true, '新记录没进列表');
    assert.equal(recordDates(render()).includes(TODAY), true, '记完要在列表里看得见');
    assert.equal(openLayers().length, 0, '保存成功后浮层该关掉');
  });
});

test('S8 时长：快捷档位与 ±5 微调共用同一个值', async () => {
  await page(async ({ render }) => {
    click(buttonByText(render(), /^记一笔$/));
    const layer = layerWith('记一笔训练');
    assert.equal(pressed(chipIn(layer, '时长(分钟)', '45')), true, '当前值要让对应档位亮起来');
    click(byAria(layer, '时长(分钟)增加 5'));
    assert.equal(minutesOf(layer), '50 分');
    click(byAria(layer, '时长(分钟)减少 5'));
    assert.equal(minutesOf(layer), '45 分');
    click(byAria(layer, '时长(分钟)减少 5'));
    assert.equal(minutesOf(layer), '40 分');
    assert.equal(pressed(chipIn(layer, '时长(分钟)', '45')), false, '微调出来的值不该还点亮档位');
    click(chipIn(layer, '时长(分钟)', '90'));
    assert.equal(minutesOf(layer), '90 分');
    assert.equal(pressed(chipIn(layer, '时长(分钟)', '90')), true);
    cancel(layer);
    assert.equal(openLayers().length, 0);
  });
});

test('S8 自定义类型：这一次手写，下一次就在候选里（PRD 5.4）', async () => {
  await page(async ({ render, state, writes }) => {
    click(buttonByText(render(), /^记一笔$/));
    const layer = layerWith('记一笔训练');
    const box = field(layer, '运动类型').querySelector('input[type="text"]');
    assert.equal(box.hidden, true, '没点自定义之前输入框不该占位');
    click(byAria(layer, '自定义运动类型'));
    assert.equal(box.hidden, false);
    box.value = '攀岩';
    box.fire('input');
    click(chipIn(layer, '时长(分钟)', '60'));
    click(submitButton(layer));
    await settle(4);
    const created = state.tables.workouts.find((item) => item.type === '攀岩');
    assert.ok(created, '自定义类型没写进去');
    assert.equal(openLayers().length, 0);

    click(buttonByText(render(), /^记一笔$/));
    const again = layerWith('记一笔训练');
    assert.ok(chipIn(again, '运动类型', '攀岩'), '自定义类型没有进下一次的候选');
    cancel(again);

    // 编辑一条自定义类型的记录：它已经进了候选，所以要看到对应那枚 chip 被按下
    click(byAria(render(), `编辑 ${TODAY} 的 攀岩`));
    const edit = layerWith('编辑这笔训练');
    assert.equal(pressed(chipIn(edit, '运动类型', '攀岩')), true, '编辑时自定义类型要回到候选里被选中');
    assert.equal(valueOf(edit, '日期'), TODAY);
    click(chipIn(edit, '运动类型', '力量'));
    click(submitButton(edit));
    await settle(4);
    const update = writes.find((item) => item.op === 'update');
    assert.equal(update.id, created.id, '编辑写到了别的行上');
    assert.equal(update.patch.type, '力量');
    assert.equal(state.tables.workouts.find((item) => item.id === created.id).type, '力量');
  });
});

// ── 三态与连续天数（C13）──────────────────────────────────

test('S8 缺练改成部分完成，连续天数立刻重新接上（C13）', async () => {
  await page(async ({ render, state, writes }) => {
    // 种子把 9/17 记成缺练，9/19、9/20 还空着：先补上这两天，连续才可能跨过缺练
    state.tables.workouts.push(
      { id: 's8-a', workout_date: '2026-09-20', type: '跑步', duration_min: 30, status: 'done', note: null },
      { id: 's8-b', workout_date: '2026-09-19', type: '跑步', duration_min: 30, status: 'done', note: null },
    );
    assert.ok(state.tables.workouts.some((item) => item.workout_date === '2026-09-17' && item.status === 'missed'),
      '种子里要有 9/17 的缺练记录，这条用例才有断点可改');

    let node = render();
    assert.equal(readouts(node)['连续天数'], '3', '从 9/18 往上数到 9/17 缺练就该停');
    assert.ok(texts(node).includes('缺练'), '缺练要作为一条记录出现，而不是被藏起来');

    click(byAria(node, '编辑 2026-09-17 的 跑步'));
    const layer = layerWith('编辑这笔训练');
    click(optionIn(layer, '完成度', 'partial'));
    click(submitButton(layer));
    await settle(4);
    assert.deepEqual(writes.at(-1).patch, {
      workout_date: '2026-09-17', type: '跑步', duration_min: 0, status: 'partial', note: '下雨',
    });
    node = render();
    assert.equal(readouts(node)['连续天数'], '7', '缺练改成部分完成后不该继续归零，要一路接回 9/14');
    assert.equal(readouts(node)['完成'], '5', '部分完成不算完成');
    assert.equal(readouts(node)['次数'], '7');
    assert.equal(readouts(node)['总时长'], '200 分钟', '0 分钟的那笔改成部分完成也不该凭空多出时长');

    click(byAria(render(), '编辑 2026-09-19 的 跑步'));
    const back = layerWith('编辑这笔训练');
    click(optionIn(back, '完成度', 'missed'));
    click(submitButton(back));
    await settle(4);
    assert.equal(readouts(render())['连续天数'], '1', '把 9/19 改成缺练，连续只能数到今天自己');
  });
});

test('S8 空档与热力格都能补记这一笔，日期已经填好', async () => {
  await page(async ({ render, state, writes }) => {
    const node = render();
    const blank = listRows(node).find((row) => row.classList.contains('blank'));
    assert.ok(blank, '列表里没有未训练日的占位格');
    const date = blank.dataset.date;
    assert.equal(date, TODAY, '今天还没练，第一条空档就该是今天');
    click(byAria(blank, `补记 ${date}`));
    const layer = layerWith(`补记 ${date}`);
    assert.equal(valueOf(layer, '日期'), date);
    assert.equal(pressed(optionIn(layer, '完成度', 'missed')), true, '空格补出来该默认是缺练');
    assert.equal(minutesOf(layer), '0 分');
    click(chipIn(layer, '运动类型', '骑行'));
    click(submitButton(layer));
    await settle(4);
    assert.deepEqual(writes.at(-1).row, {
      workout_date: date, type: '骑行', duration_min: 0, status: 'missed', note: null,
    });
    assert.equal(state.tables.workouts.filter((item) => item.workout_date === date).length, 1);
    assert.equal(listRows(render()).filter((row) => row.classList.contains('blank'))
      .some((row) => row.dataset.date === date), false, '补上以后这一格不该还是空的');

    // 热力格：点一格没记录的日子，同样开到补记表单
    const cell = render().querySelectorAll('.heat i').find((item) => item.dataset.state === 'none');
    click(cell);
    const heatLayer = layerWith(`补记 ${cell.dataset.date}`);
    assert.ok(heatLayer, '热力格点空档没开出补记表单');
    assert.equal(valueOf(heatLayer, '日期'), cell.dataset.date);
    cancel(heatLayer);
  });
});

// ── 区间与统计（C14）──────────────────────────────────────

test('S8 首页与健身页的本周读数逐项相等（C14）', async () => {
  await page(async ({ render, state }) => {
    const { renderHome } = await import('../../web/views/home.js');
    const home = renderHome(viewArgs.home(state, liveCtx(state).ctx));
    click(segButton(render(), '本周'));
    const node = render();
    const h = readouts(home);
    const w = readouts(node);
    for (const [homeKey, workoutKey] of [['次数', '次数'], ['时长', '总时长'], ['连续天数', '连续天数']]) {
      assert.equal(w[workoutKey], h[homeKey], `首页「${homeKey}」=${h[homeKey]}，健身页「${workoutKey}」=${w[workoutKey]}`);
    }
    const range = weekOf(state);
    const rows = inRange(state.tables.workouts, range);
    assert.equal(w['次数'], String(rows.length));
    assert.equal(w['总时长'], `${rows.filter((item) => item.status !== 'missed').reduce((sum, item) => sum + item.duration_min, 0)} 分钟`,
      '缺练时长不该计进累计');
    assert.equal(w['完成'], String(rows.filter((item) => item.status === 'done').length));
    assert.equal(rangeTitle(node), '9/14 – 9/20');
  });
});

test('S8 区间切换：本周/本月/自定义各算各的，标题跟着走', async () => {
  await page(async ({ render, state }) => {
    click(segButton(render(), '本月'));
    let node = render();
    const month = T.monthlyRange(TODAY);
    assert.equal(rangeTitle(node), '9/1 – 9/20');
    assert.equal(readouts(node)['次数'], String(inRange(state.tables.workouts, month).length));
    assert.ok(inRange(state.tables.workouts, month).length > inRange(state.tables.workouts, weekOf(state)).length,
      '本月区间本身就该比本周宽');
    assert.equal(pressed(segButton(node, '本月')), true);

    click(segButton(node, '自定义'));
    node = render();
    assert.equal(rangeTitle(node), '9/14 – 9/20', '自定义默认给最近 7 天，不留空框');
    assert.equal(node.querySelectorAll('.filters input[type="date"]').length, 2);
    const startBox = node.querySelectorAll('.filters input[type="date"]')[0];
    startBox.value = '2026-08-25';
    startBox.fire('change');
    node = render();
    assert.equal(rangeTitle(node), '8/25 – 9/20');
    const span = { start: '2026-08-25', end: TODAY };
    assert.equal(readouts(node)['次数'], String(inRange(state.tables.workouts, span).length));
    assert.equal(readouts(node)['完成'], String(inRange(state.tables.workouts, span).filter((item) => item.status === 'done').length));

    const endBox = render().querySelectorAll('.filters input[type="date"]')[1];
    endBox.value = '2026-08-20';
    endBox.fire('change');
    const flipped = render();
    assert.equal(flipped.querySelector('.chip.warn').textContent, '结束日期早于开始日期，按空区间处理');
    assert.equal(readouts(flipped)['次数'], '0', '颠倒的区间要按空处理，而不是算出负数或整堆数据');
    assert.equal(flipped.querySelectorAll('.donut-legend .name').length, 0);
    assert.ok(texts(flipped).includes('这个区间还没有可统计的时长'));

    click(segButton(render(), '本周'));
    assert.equal(rangeTitle(render()), '9/14 – 9/20', '切回本周要丢掉自定义的起止');
  });
});

// ── 周分组与更早段 ────────────────────────────────────────

test('S8 记录按周分组：四周都出现，空档占位，窗口外的记录进「更早」', async () => {
  await page(async ({ render, state }) => {
    state.tables.workouts.push({
      id: 's8-old', workout_date: '2026-08-20', type: '瑜伽', duration_min: 40, status: 'done', note: null,
    });
    const node = render();
    assert.deepEqual(groupHeads(node), ['本周 · 9/14 – 9/20', '9/7 – 9/13', '8/31 – 9/6', '8/24 – 8/30', '更早 · 1 笔'],
      '周分组不对');

    const dates = listedDates(node);
    assert.equal(dates.some((date, index) => index && date > dates[index - 1]), false, '日期必须从新到旧');
    for (const item of state.tables.workouts) assert.ok(dates.includes(item.workout_date), `${item.workout_date} 的记录被丢掉了`);
    assert.equal(dates.filter((date) => date > TODAY).length, 0, '未来的日子不该出现在列表里');

    const daysInWindow = new Set(inRange(state.tables.workouts, { start: WINDOW_START, end: TODAY }).map((item) => item.workout_date));
    const blank = listRows(node).filter((row) => row.classList.contains('blank'));
    assert.equal(blank.length, 28 - daysInWindow.size, '近 4 周 28 天里没记录的日子都要占位');
    assert.equal(listRows(node).length, state.tables.workouts.length + blank.length, '每笔记录一行，每个空档一行');
    for (const row of blank) assert.ok(byAria(row, `补记 ${row.dataset.date}`), '空档要能一键补记');
    assert.ok(texts(blank[0]).includes('没有记录'));
  });
});

// ── 图表结构 ──────────────────────────────────────────────

test('S8 四张图表：环、分量、柱、热力都按区间数据画，且都带文字替代', async () => {
  await page(async ({ render, state }) => {
    const node = render();
    const range = weekOf(state);
    const rows = inRange(state.tables.workouts, range);
    const done = rows.filter((item) => item.status === 'done').length;
    const partial = rows.filter((item) => item.status === 'partial').length;

    const ring = node.querySelector('[data-chart="ring"]');
    const [dash, gap] = ring.querySelector('.ring-value').getAttribute('stroke-dasharray').split(' ').map(Number);
    const circumference = 2 * Math.PI * 40;
    assert.equal(Math.round(dash + gap), Math.round(circumference), 'dash + gap 要正好一圈');
    assert.equal(Math.round(dash / circumference * 100), Math.round(done / rows.length * 100), '环的比例要对得上完成占比');
    assert.equal(ring.querySelector('.ring-label span').textContent, `${Math.round(done / rows.length * 100)}%`);
    assert.equal(ring.querySelector('.ring-svg').getAttribute('aria-hidden'), 'true', '图形本身不该让读屏重复念一遍');
    assert.ok(texts(node).includes(`完成 ${done} · 部分 ${partial}`), '环旁边要有可读的分项数字');

    const byType = new Map();
    for (const item of rows) byType.set(item.type, (byType.get(item.type) ?? 0) + item.duration_min);
    const slices = [...byType].filter(([, minutes]) => minutes > 0);
    const donutNode = node.querySelector('[data-chart="donut"]');
    assert.equal(donutNode.querySelectorAll('.donut-arc').length, slices.length);
    assert.equal(donutNode.querySelectorAll('.legend-item').length, slices.length, '图例条目要跟扇区一一对应');
    assert.equal(donutNode.querySelector('.donut-center-num span').textContent,
      String(slices.reduce((sum, [, minutes]) => sum + minutes, 0)));
    const percents = donutNode.querySelectorAll('.pct').map((item) => Number(item.textContent.replace('%', '')));
    assert.ok(Math.abs(percents.reduce((a, b) => a + b, 0) - 100) <= slices.length, `占比合计该接近 100：${percents}`);
    assert.equal(donutNode.querySelectorAll('.donut-arc').every((arc) => arc.hasAttribute('stroke-dashoffset')), true);

    const bars = node.querySelector('[data-chart="bars"]');
    assert.equal(bars.querySelectorAll('.bar-col').length, 8, '柱状要画近 8 周');
    const heights = bars.querySelectorAll('.bar-fill').map((item) => Number(item.style.height.replace('px', '')));
    assert.equal(Math.max(...heights), 100, '最高一根要占满绘图高度');
    assert.equal(heights.some(Number.isNaN), false, '高度里不许出现 NaN');
    assert.equal(bars.querySelectorAll('.bar-label').at(-1).textContent, '9/14');
    assert.equal(bars.querySelectorAll('.bar-value').at(-1).textContent,
      String(rows.filter((item) => item.status !== 'missed').reduce((sum, item) => sum + item.duration_min, 0)),
      '最后一根柱要等于本周时长，与区间统计同一口径');

    const heat = node.querySelector('[data-chart="heat"]');
    const cells = heat.querySelectorAll('i');
    assert.equal(cells.length, 13 * 7);
    assert.equal(cells.filter((item) => item.dataset.state === 'missed').length, 1);
    assert.equal(cells.filter((item) => item.dataset.state === 'future').length, 0, '今天是周日，本周没有未来格');
    assert.equal(heat.querySelectorAll('i[data-level="missed"]').length, 1, '缺练格要区别于空格子');
    assert.ok(cells[0].getAttribute('title').includes('2026-'), '每格都要能悬停看出日期');
    assert.ok(texts(node).includes('点空格子补记这笔'));
  });
});

test('S8 空态：没有记录时图表退回文字提示，不画一圈假数据', async () => {
  await page(async ({ render }) => {
    const node = render();
    assert.ok(texts(node).includes('还没有训练记录'));
    assert.ok(byAria(node, '记一笔训练'));
    assert.equal(listRows(node).length, 0);
    assert.equal(node.querySelectorAll('.group-head').length, 0);
    assert.ok(texts(node).includes('这个区间还没有可统计的时长'));
    assert.equal(node.querySelector('[data-chart="ring"] .ring-label span').textContent, '0%');
    assert.equal(node.querySelector('[data-chart="ring"]').classList.contains('is-warn'), true, '零完成要用警示配色');
    assert.equal(node.querySelectorAll('[data-chart="bars"] .bar-fill').every((item) => item.style.height === '0px'), true,
      '全零时柱高都是 0，不许出现 NaN');
    click(buttonByText(node, /^记第一笔$/));
    assert.ok(layerWith('记一笔训练'), '空态的号召按钮没接到同一个表单');
  }, { seed: false });
});

test('S8 删除给 5 秒撤销窗口，删完这一格回到空档', async () => {
  await page(async ({ render, state }) => {
    const target = state.tables.workouts.find((item) => item.workout_date === '2026-09-16');
    click(byAria(render(), `删除 2026-09-16 的 ${target.type}`));
    assert.ok(toastTexts().some((text) => text.includes('已删除 2026-09-16')), toastTexts().join('|'));
    assert.equal(recordDates(render()).includes('2026-09-16'), false, '乐观删除后界面上该立刻消失');
    assert.ok(byAria(render(), '补记 2026-09-16'), '删掉以后这一格该回到空档');
    assert.equal(readouts(render())['次数'], String(inRange(state.tables.workouts, weekOf(state)).length));
  });
});

test('S8 全量渲染没有空标题位，N 快捷键走同一个表单', async () => {
  await page(async ({ render, state }) => {
    const { renderWorkout } = await import('../../web/views/workout.js');
    assertNoBlankLabels(render(), '健身页');
    renderWorkout.onNew({ ctx: liveCtx(state).ctx, state, time: TIME });
    assert.ok(layerWith('记一笔训练'), 'N 快捷键没开出记一笔表单');
    assert.equal(openLayers().length, 1);
    cancel(layerWith('记一笔训练'));
  });
});

// ── 真 store + 真 Function 往返 ───────────────────────────

test('S8 往返：记一笔、改完成度、删除都能写进服务端', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createApi({ baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1/app` });
  const store = createStore({ api });
  await store.load();
  const today = T.todayKey();
  const time = { today, now: new Date(`${today}T12:00:00`) };
  try {
    await withDom(async () => {
      const { renderWorkout } = await import('../../web/views/workout.js');
      const ctx = { store, navigate: () => {} };
      const render = () => renderWorkout({ state: store.state, ctx, time });
      const before = store.state.tables.workouts.length;

      click(buttonByText(render(), /^记一笔$/));
      const layer = layerWith('记一笔训练');
      click(chipIn(layer, '运动类型', '游泳'));
      click(chipIn(layer, '时长(分钟)', '15'));
      click(submitButton(layer));
      assert.equal(await waitUntil(() => !store.state.pending.length && !store.state.inflight, 9000), true, '写入没有落定');
      await store.refresh();
      const created = store.state.tables.workouts.find((item) => item.type === '游泳' && item.workout_date === today);
      assert.ok(created, '新记录没有落到服务端');
      assert.equal(created.duration_min, 15);
      assert.equal(created.status, 'done');
      assert.equal(store.state.tables.workouts.length, before + 1);
      assert.equal(recordDates(render()).includes(today), true);

      click(segButton(render(), '本月'));
      assert.equal(readouts(render())['次数'],
        String(inRange(store.state.tables.workouts, T.monthlyRange(today)).length), '区间切换后读数与统计口径不一致');
      click(segButton(render(), '本周'));

      click(byAria(render(), `编辑 ${today} 的 游泳`));
      const edit = layerWith('编辑这笔训练');
      click(optionIn(edit, '完成度', 'partial'));
      click(chipIn(edit, '时长(分钟)', '45'));
      click(submitButton(edit));
      assert.equal(await waitUntil(() => !store.state.pending.length && !store.state.inflight, 9000), true);
      await store.refresh();
      assert.equal(store.row('workouts', created.id).status, 'partial', '完成度改动没写进服务端');
      assert.equal(store.row('workouts', created.id).duration_min, 45);

      click(byAria(render(), `删除 ${today} 的 游泳`));
      assert.equal(await waitUntil(() => !store.state.pending.length && !store.state.inflight, 9000), true, '撤销窗口结束后删除请求仍未落定');
      await store.refresh();
      assert.equal(store.row('workouts', created.id), null, '删除没写进服务端');
      assert.equal(store.state.tables.workouts.length, before);
    });
  } finally {
    server.close();
  }
});
