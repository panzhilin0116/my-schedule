// 健身页（S8）：区间读数 + 三张图表 + 按周分组的记录 + 记一笔表单。
// 区间统计全部走 lib/time.js（首页要逐项相等，同一份算式不留第二遍），
// 数值→角度/长度全部走 lib/charts.js，这里只管装配与写入。
import { h, mount, icon } from '../lib/dom.js';
import * as T from '../lib/time.js';
import { toast, emptyState, openLayer, fieldsFor, swipeDelete } from '../lib/ui.js';
import { progressRing, donut, barSeries, heatGrid } from '../lib/charts.js';

const TABLE = 'workouts';
// PRD 5.4 的预设类型；云端已有但不在预设里的名字（例如自定义的"拉伸"）会并进候选
const PRESET_TYPES = ['跑步', '力量', '游泳', '球类', '骑行', '瑜伽', '其它'];
const STATUS_TEXT = { done: '完成', partial: '部分', missed: '缺练' };
const STATUS_CLASS = { done: 'green', partial: 'orange', missed: 'red' };
const STATUS_OPTIONS = [
  { value: 'done', label: '完成', glyph: 'check' },
  { value: 'partial', label: '部分', glyph: 'minus' },
  { value: 'missed', label: '缺练', glyph: 'close' },
];
const QUICK_MINUTES = [15, 30, 45, 60, 90];
const RANGES = [{ key: 'week', label: '本周' }, { key: 'month', label: '本月' }, { key: 'custom', label: '自定义' }];
const LIST_WEEKS = 4;
const HEAT_WEEKS = 13;
const TREND_WEEKS = 8;

// 区间选择是"此刻在看哪一段"，属于浏览位置：PRD 7.4 只允许三项 UI 偏好落本地，
// 所以放模块内存，刷新回到本周。
const view = { range: 'week', start: null, end: null };

function typeCandidates(workouts) {
  const seen = new Set(PRESET_TYPES);
  const extra = [];
  for (const item of workouts) {
    const name = typeof item.type === 'string' ? item.type.trim() : '';
    if (name && !seen.has(name)) {
      seen.add(name);
      extra.push(name);
    }
  }
  return [...PRESET_TYPES, ...extra];
}

function workoutFields(candidates) {
  return fieldsFor(TABLE, {
    only: ['workout_date', 'type', 'duration_min', 'status', 'note'],
    overrides: {
      type: { type: 'chips', options: candidates, allowCustom: true, hint: '自定义的名字下次会出现在这里' },
      duration_min: { type: 'quickstep', options: QUICK_MINUTES, unit: ' 分', step: 5 },
      status: { type: 'tri', options: STATUS_OPTIONS },
      note: { type: 'textarea' },
    },
  });
}

/**
 * 记一笔（C15）：日期=今天、时长=45 分、完成度=完成，所以从打开到存下只有
 * 选类型、调时长、按保存这 3 次点击；类型是必填项，留空时提交按钮就是禁用的。
 * 补记走同一个表单，只多带一个日期：把「缺练 + 0 分」预置进去，等于替用户改口，
 * 练过的一天会被悄悄记成没练（缺练只能由用户在完成度里明选）。
 */
function logForm({ store }, candidates, today, preset = {}) {
  return openLayer({
    title: preset.workout_date ? `补记 ${preset.workout_date}` : '记一笔训练',
    eyebrow: 'WORKOUT',
    fields: workoutFields(candidates),
    values: {
      workout_date: today,
      duration_min: 45,
      status: 'done',
      note: null,
      ...preset,
    },
    submitLabel: '记下这笔',
    onSubmit: async (draft) => {
      const row = { ...draft, duration_min: Number(draft.duration_min) || 0 };
      row.type = String(row.type ?? '').trim();
      row.note = String(row.note ?? '').trim() || null;
      await store.create(TABLE, row);
    },
  });
}

function editForm({ store }, candidates, item) {
  return openLayer({
    title: '编辑这笔训练',
    eyebrow: 'WORKOUT',
    fields: workoutFields(candidates),
    values: item,
    submitLabel: '保存改动',
    onSubmit: async (draft) => {
      const row = { ...draft, duration_min: Number(draft.duration_min) || 0 };
      row.type = String(row.type ?? '').trim();
      row.note = String(row.note ?? '').trim() || null;
      await store.update(TABLE, item.id, row);
    },
  });
}

function removeWorkout(store, item) {
  const { token } = store.remove(TABLE, item.id);
  toast(`已删除 ${item.workout_date} 的「${item.type}」`, {
    kind: 'ok',
    action: '撤销',
    duration: 6000,
    onAction: () => { if (!store.undoRemove(token)) toast('删除已生效，无法撤销', { kind: 'error' }); },
  });
}

// ── 区间 ────────────────────────────────────────────────

function rangeOf(config, today) {
  if (view.range === 'month') return { key: 'month', ...T.monthlyRange(today) };
  if (view.range === 'custom') {
    return { key: 'custom', start: view.start ?? T.addDays(today, -6), end: view.end ?? today };
  }
  return { key: 'week', ...T.currentWeekRange(config, today) };
}

function rangeControls(range, today, pick) {
  const dateInput = (name, value, label) => h('input', {
    type: 'date', value, 'aria-label': label,
    // 日期框清空交回 ''：这时区间还没定，先按空处理而不是写进 view 污染下次计算
    onchange: (event) => pick(name === 'start' ? { start: event.target.value || null } : { end: event.target.value || null }),
  });
  return h('div.controls',
    h('div.seg', { role: 'group', 'aria-label': '统计区间' },
      ...RANGES.map(({ key, label }) => h('button', {
        type: 'button', 'aria-pressed': view.range === key ? 'true' : 'false',
        onclick: () => pick({ range: key }),
      }, h('span', { text: label })))),
    view.range === 'custom' ? h('div.filters',
      h('div.filter-col', h('h4', { text: '起' }), dateInput('start', range.start, '自定义区间开始日期')),
      h('div.filter-col', h('h4', { text: '止' }), dateInput('end', range.end, '自定义区间结束日期')),
      range.start > range.end ? h('span.chip.warn', { text: '结束日期早于开始日期，按空区间处理' }) : null,
    ) : null,
  );
}

// ── 读数与图表 ───────────────────────────────────────────

function statsPanel(workouts, range, stats, today, helpers) {
  const ratio = stats.sessions ? Math.round((stats.done / stats.sessions) * 100) : 0;
  const trend = T.weeklyBuckets(workouts, { count: TREND_WEEKS, today });
  const minutesByDate = new Map();
  for (const item of workouts) {
    minutesByDate.set(item.workout_date, (minutesByDate.get(item.workout_date) ?? 0) + (Number(item.duration_min) || 0));
  }
  const heat = T.heatCells(workouts, { weeks: HEAT_WEEKS, today });
  return h('div.panel.stats',
    h('div.panel-head',
      h('div',
        h('span.eyebrow', { text: RANGES.find((item) => item.key === range.key)?.label ?? 'RANGE' }),
        h('h3', { text: `${T.fmtDateShort(range.start)} – ${T.fmtDateShort(range.end)}` }),
      ),
      h('div.spacer'),
      h('button.btn.sm.primary', {
        type: 'button', text: '记一笔', 'aria-label': '记一笔训练',
        onclick: () => logForm(helpers, typeCandidates(workouts), today),
      }),
    ),
    h('div.readout-grid',
      h('div.readout-cell', h('div.k', { text: '次数' }), h('div.v', { text: String(stats.sessions) })),
      h('div.readout-cell', h('div.k', { text: '总时长' }), h('div.v', {}, String(stats.minutes), h('small', { text: ' 分钟' }))),
      h('div.readout-cell', h('div.k', { text: '完成' }), h('div.v', { text: String(stats.done) })),
      h('div.readout-cell', h('div.k', { text: '连续天数' }), h('div.v', { text: String(T.streakOf(workouts, today)) })),
    ),
    h('div.chart-grid',
      h('div.chart-cell',
        h('h4', { text: '完成占比' }),
        progressRing(ratio, {
          label: '完成占比', caption: `${stats.done}/${stats.sessions} 次`,
          state: ratio >= 75 ? 'ok' : ratio < 40 ? 'warn' : '',
        }),
        h('div.chart-caption.tiny.faint', {
          text: `完成 ${stats.done} · 部分 ${stats.partial} · 缺练 ${stats.missed} · 有练天数 ${stats.activeDays}`,
        }),
      ),
      h('div.chart-cell',
        h('h4', { text: '类型分布' }),
        donut(stats.byType, { unit: '分钟', emptyHint: '这个区间还没有可统计的时长' }),
      ),
      h('div.chart-cell.wide',
        h('h4', { text: `近 ${TREND_WEEKS} 周时长` }),
        barSeries(trend, { unit: '分钟', caption: '最高一根为该区间最长的一周' }),
        h('div.chart-caption.tiny.faint', { text: `本周 ${trend.at(-1).minutes} 分钟 · 缺练不计入时长` }),
      ),
      h('div.chart-cell.wide',
        h('h4', { text: `近 ${HEAT_WEEKS} 周热力` }),
        heatGrid(heat, {
          today, minutesByDate,
          onPick: (date) => logForm(helpers, typeCandidates(workouts), today, { workout_date: date }),
        }),
        h('div.chart-caption.tiny.faint', {
          text: `颜色越亮练得越久，点空格子补记这笔；共 ${new Set(workouts.filter((item) => item.status !== 'missed').map((item) => item.workout_date)).size} 天有训练`,
        }),
      ),
    ),
  );
}

// ── 记录列表 ─────────────────────────────────────────────

function recordRow(item, helpers, candidates) {
  const row = h('div.list-row', { class: item.status === 'missed' ? 'is-missed' : '', dataset: { date: item.workout_date, status: item.status } },
    h('span.t', { text: item.workout_date.slice(5) }),
    h('div.truncate', { style: { minWidth: '0' } },
      h('div.title', { text: item.type }),
      item.note ? h('div.meta', { text: item.note }) : null,
    ),
    h('div.spacer'),
    h('span.num.dim', { text: `${item.duration_min} 分` }),
    h('span.badge', { class: STATUS_CLASS[item.status] ?? 'grey', text: STATUS_TEXT[item.status] ?? item.status }),
    h('button.iconbtn', {
      type: 'button', 'aria-label': `编辑 ${item.workout_date} 的 ${item.type}`,
      onclick: () => editForm(helpers, candidates, item),
    }, icon('pencil')),
    h('button.iconbtn.danger', {
      type: 'button', 'aria-label': `删除 ${item.workout_date} 的 ${item.type}`,
      onclick: () => removeWorkout(helpers.store, item),
    }, icon('trash')),
  );
  swipeDelete(row, { onDelete: () => removeWorkout(helpers.store, item) });
  return row;
}

/** 没记录的日子也要占位：看不见空档就想不起来补，这是把"缺练"当数据的前提。 */
function blankDay(date, helpers, candidates, today) {
  return h('div.list-row.blank', { dataset: { date } },
    h('span.t', { text: date.slice(5) }),
    h('div.truncate', h('div.title.faint', { text: '没有记录' }), h('div.meta', { text: '没练也记一笔缺练，连续天数才知道从哪儿断' })),
    h('div.spacer'),
    h('button.chip', {
      type: 'button', text: '补记', 'aria-label': `补记 ${date}`,
      onclick: () => logForm(helpers, candidates, today, { workout_date: date }),
    }),
  );
}

function weekSection(group, helpers, candidates, index, today) {
  const rows = group.days.flatMap((cell) => cell.rows);
  const minutes = rows.reduce((sum, item) => sum + (item.status === 'missed' ? 0 : Number(item.duration_min) || 0), 0);
  const label = index === 0 ? '本周 · ' : '';
  return h('section.group',
    h('div.group-head',
      h('h3', { text: `${label}${T.fmtDateShort(group.start)} – ${T.fmtDateShort(group.end)}` }),
      h('div.spacer'),
      h('span.count', { text: `${rows.length} 次 · ${minutes} 分` }),
    ),
    h('div.card-list', {}, ...group.days.flatMap((cell) => (cell.rows.length
      ? cell.rows.map((item) => recordRow(item, helpers, candidates))
      : [blankDay(cell.date, helpers, candidates, today)]))),
  );
}

function olderSection(rows, helpers, candidates) {
  return h('section.group',
    h('div.group-head', h('h3', { text: `更早 · ${rows.length} 笔` }), h('div.spacer'),
      h('span.count', { text: `${T.fmtDateShort(rows.at(-1).workout_date)} – ${T.fmtDateShort(rows[0].workout_date)}` })),
    h('div.card-list', {}, ...rows.map((item) => recordRow(item, helpers, candidates))),
  );
}

// ── 页面 ─────────────────────────────────────────────────

export function renderWorkout({ state, ctx, time }) {
  const helpers = { store: ctx.store };
  const today = time.today;
  const workouts = state.tables.workouts;
  const candidates = typeCandidates(workouts);
  const controls = h('div');
  const stats = h('div');
  const body = h('div.stack');

  const pick = (patch) => {
    Object.assign(view, patch);
    paint();
  };

  function paint() {
    const range = rangeOf(state.config, today);
    const numbers = T.workoutStats(workouts, range);
    mount(controls, rangeControls(range, today, pick));
    mount(stats, statsPanel(workouts, range, numbers, today, helpers));
    const groups = T.weekGroups(workouts, { today, weeks: LIST_WEEKS });
    const older = T.outsideWeekGroups(workouts, { today, weeks: LIST_WEEKS })
      .sort((a, b) => (b.workout_date > a.workout_date ? 1 : b.workout_date < a.workout_date ? -1 : 0));
    mount(body, ...(!workouts.length
      ? [h('div.panel', emptyState({
        glyph: 'workout',
        title: '还没有训练记录',
        hint: '第一版不预设计划，只如实记录每一次：今天练了什么就记什么',
        cta: '记第一笔',
        onCta: () => logForm(helpers, candidates, today),
      }))]
      : [
        ...groups.map((group, index) => weekSection(group, helpers, candidates, index, today)),
        older.length ? olderSection(older, helpers, candidates) : null,
      ]));
  }

  paint();
  return h('div.stack', controls, stats, body);
}

renderWorkout.onNew = ({ state, ctx, time }) => logForm({ store: ctx.store }, typeCandidates(state.tables.workouts), time.today);
