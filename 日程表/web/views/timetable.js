// 课表页（S6）：周次切换 + 网格/日/列表三视图 + 冲突检测与橙色警告 + 空白时段预填。
// 时间映射、周次判定与冲突口径全部在 lib/time.js，这里只负责画与写。
import { h, mount, icon } from '../lib/dom.js';
import * as T from '../lib/time.js';
import { toast, emptyState, openLayer, fieldsFor } from '../lib/ui.js';
import { href, routeByKey } from '../routes.js';

const TABLE = 'courses';
const MODES = [
  { key: 'grid', label: '网格' },
  { key: 'day', label: '日' },
  { key: 'list', label: '列表' },
];
const DAY_OPTIONS = T.DAY_NAMES.map((label, index) => ({ value: String(index + 1), label }));
const WEEK_TYPE_LABELS = { all: '每周', odd: '单周', even: '双周' };
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_COLOR = '#3DD6F5';

const pct = (value) => `${Number(value.toFixed(2))}%`;
const courseColor = (color) => (HEX_RE.test(String(color ?? '')) ? color : FALLBACK_COLOR);
const dayLabel = (key) => T.DAY_NAMES[T.dayOfWeek(key) - 1];
const dowName = (value) => DAY_OPTIONS.find((item) => item.value === String(value))?.label ?? '星期';

/** 窄屏（PRD 2.2 的 640px 断点）下七天网格挤成一团，没选过视图时默认日视图。 */
const narrow = () => globalThis.matchMedia?.('(max-width: 639px)')?.matches === true;

function modeOf(store) {
  const saved = store.pref('ui.timetableView', null);
  if (MODES.some((item) => item.key === saved)) return saved;
  return narrow() ? 'day' : 'grid';
}

/** 周次与星期都放在查询串里：刷新与分享后停在同一屏；写了数字就收回学期范围内，没写才回到本周。 */
function readRoute({ query, config, time }) {
  const total = config.total_weeks;
  const current = T.weekOf(time.today, config);
  const asked = query?.get?.('week');
  const raw = asked === null || asked === '' ? NaN : Number(asked);
  const week = Number.isFinite(raw) ? T.clampWeek(raw, total) : (current ?? 1);
  const rawDow = Number(query?.get?.('dow'));
  const dow = Number.isInteger(rawDow) && rawDow >= 1 && rawDow <= 7
    ? rawDow
    : (current === week ? T.dayOfWeek(time.today) : 1);
  const range = T.weekRange(week, config);
  return { week, dow, total, current, range, day: T.addDays(range.start, dow - 1) };
}

/** 冲突描边只看本周真的上的课：本周不上的课只是解释"这周为什么没课"，不构成撞车。 */
function conflictIds(courses, week) {
  const active = courses.filter((course) => T.courseActiveOnWeek(course, week));
  const ids = new Set();
  for (const course of active) {
    if (T.findConflicts(course, active).length) ids.add(course.id);
  }
  return ids;
}

function courseSummary(course) {
  return [
    `${course.start_time}–${course.end_time}`,
    course.location || '未填地点',
    `第 ${course.start_week}–${course.end_week} 周`,
    WEEK_TYPE_LABELS[course.week_type] ?? course.week_type,
  ].join(' · ');
}

function courseBlock(course, periods, { conflict, onOpen }) {
  const box = T.axisBox(periods, course.start_time, course.end_time);
  if (!box) return null;
  const layout = course.layout ?? { total: 1, index: 0 };
  const width = 100 / layout.total;
  const color = courseColor(course.color);
  return h('button.tt-course', {
    type: 'button',
    class: [course.active ? '' : 'is-ghost', conflict ? 'is-conflict' : ''].filter(Boolean).join(' '),
    style: {
      top: pct(box.top),
      height: pct(Math.max(box.height, 2.4)),
      left: `calc(${pct(layout.index * width)} + 2px)`,
      width: `calc(${pct(width)} - 4px)`,
      '--c-bg': `${color}26`,
      '--c-line': `${color}8a`,
    },
    'aria-label': [course.name, `${course.start_time}–${course.end_time}`, course.location || '未填地点',
      course.active ? null : '本周不上', conflict ? '与其他课时间冲突' : null].filter(Boolean).join('，'),
    onclick: (event) => { event.stopPropagation(); onOpen(course); },
  },
    h('b', { text: course.name }),
    h('span.at', { text: `${course.start_time}–${course.end_time}` }),
    course.location ? h('span.at', { text: course.location }) : null,
  );
}

function slotButton(period, periods, { date, onPick }) {
  const box = T.axisBox(periods, period.start, period.end);
  if (!box) return null;
  return h('button.tt-slot', {
    type: 'button',
    class: period.kind === 'break' ? 'is-break' : '',
    style: { top: pct(box.top), height: pct(box.height) },
    'aria-label': `${T.fmtDate(date)} ${period.label} ${period.start}–${period.end}，点击按这一节新增课程`,
    onclick: () => onPick(date, period),
  });
}

function axisColumn(periods) {
  return h('div.tt-axis', { 'aria-hidden': 'true' },
    ...T.sortPeriods(periods).map((period) => {
      const box = T.axisBox(periods, period.start, period.end);
      if (!box) return null;
      return h('div.tt-tick', {
        style: { top: pct(box.top) },
        title: `${period.label} ${period.start}–${period.end}`,
      }, h('span', { text: period.label }), h('small', { text: period.start }));
    }));
}

function dayColumn({ courses, periods, week, date, time, conflicts, onPick, onOpen }) {
  const isToday = date === time.today;
  const span = T.axisSpan(periods);
  const minutes = isToday ? time.now.getHours() * 60 + time.now.getMinutes() : null;
  const insideAxis = minutes !== null && minutes >= span.start && minutes <= span.end;
  return h('div.tt-cell', {
    class: isToday ? 'is-today' : '',
    'aria-label': `${T.fmtDate(date)} 的课程列`,
  },
    ...T.sortPeriods(periods).map((period) => slotButton(period, periods, { date, onPick })),
    ...T.coursesOverlapping(courses, week, date)
      .map((course) => courseBlock(course, periods, { conflict: conflicts.has(course.id), onOpen })),
    insideAxis ? h('div.tt-now', {
      style: { top: pct(((minutes - span.start) / (span.end - span.start)) * 100) },
      'aria-label': `当前时刻 ${T.min2hm(minutes)}`,
    }) : null,
  );
}

function gridTable({ courses, periods, days, week, time, conflicts, onPick, onOpen, single }) {
  return h('div.tt-scroll',
    h('div.tt-grid', { class: single ? 'is-day' : '' },
      h('div.tt-corner', { text: '节次' }),
      ...days.map((date) => h('div.tt-day', {
        class: date === time.today ? 'is-today' : '',
        text: `${dayLabel(date)} ${T.fmtDateShort(date)}`,
      })),
      axisColumn(periods),
      ...days.map((date) => dayColumn({
        courses, periods, week, date, time, conflicts, onPick, onOpen,
      }))));
}

function dayStrip({ days, day, onPick }) {
  return h('div.seg.day-strip', { role: 'group', 'aria-label': '选择星期' },
    ...days.map((date) => h('button', {
      type: 'button', 'aria-pressed': date === day ? 'true' : 'false',
      onclick: () => onPick(T.dayOfWeek(date)),
    }, h('span', { text: dayLabel(date) }), h('small', { text: T.fmtDateShort(date) }))));
}

function listView({ courses, days, week, time, conflicts, onOpen, onAdd }) {
  return h('div.stack',
    ...days.map((date) => {
      const rows = T.coursesOverlapping(courses, week, date);
      const live = rows.filter((item) => item.active);
      return h('section.group',
        h('div.group-head',
          h('h3', { text: `${dayLabel(date)} ${T.fmtDateShort(date)}` }),
          date === time.today ? h('span.badge.cyan', { text: '今天' }) : null,
          h('div.spacer'),
          h('span.count', { text: rows.length ? `${live.length}/${rows.length} 节` : '无课' }),
        ),
        rows.length
          ? h('div.card-list', {}, ...rows.map((course) => h('button.list-row', {
            type: 'button',
            class: [course.active ? '' : 'is-past', conflicts.has(course.id) ? 'is-conflict' : ''].filter(Boolean).join(' '),
            onclick: () => onOpen(course),
          },
            h('span.colorbar', { style: { background: courseColor(course.color) } }),
            h('span.t', { text: course.start_time }),
            h('div.truncate',
              h('div.title', { text: course.name }),
              h('div.meta', { text: courseSummary(course) })),
            conflicts.has(course.id) ? h('span.badge.red', { text: '冲突' }) : null,
            course.active ? null : h('span.badge.grey', { text: '本周不上' }),
          )))
          : h('p.tiny.faint', { text: '这一天没有安排课程' }),
        live.length ? null : h('button.btn.sm', { type: 'button', text: '这一天加一门课', onclick: () => onAdd(date) }),
      );
    }));
}

function weekPicker({ route, onMove, onJump, onParity }) {
  const parity = T.parityOfWeek(route.week);
  return h('div.week-picker',
    h('button.iconbtn', {
      type: 'button', 'aria-label': '上一周', disabled: route.week <= 1, onclick: () => onMove(-1),
    }, icon('chevLeft')),
    h('span.current', { text: `第 ${route.week} / ${route.total} 周` }),
    h('button.iconbtn', {
      type: 'button', 'aria-label': '下一周', disabled: route.week >= route.total, onclick: () => onMove(1),
    }, icon('chevRight')),
    h('button.btn.sm', {
      type: 'button', text: '本周', disabled: route.current === null,
      onclick: () => onJump(route.current ?? 1),
    }),
    h('button.btn.sm', {
      type: 'button', text: '单周', 'aria-pressed': parity === 'odd' ? 'true' : 'false', onclick: () => onParity('odd'),
    }),
    h('button.btn.sm', {
      type: 'button', text: '双周', 'aria-pressed': parity === 'even' ? 'true' : 'false', onclick: () => onParity('even'),
    }),
  );
}

function viewSwitch(mode, onPick) {
  return h('div.seg', { role: 'group', 'aria-label': '课表视图' },
    ...MODES.map((item) => h('button', {
      type: 'button', text: item.label, 'aria-pressed': mode === item.key ? 'true' : 'false',
      onclick: () => onPick(item.key),
    })));
}

/** 星期的下拉交回字符串，Function 侧的整数列要求 number；清空一律归 null。 */
function normalizeCourse(draft) {
  const out = {};
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined) continue;
    out[key] = value === '' ? null : value;
  }
  for (const key of ['day_of_week', 'start_week', 'end_week']) {
    if (out[key] !== null && out[key] !== undefined) out[key] = Number(out[key]);
  }
  return out;
}

function conflictNotice() {
  const node = h('div.notice.warn');
  const paint = (hits) => {
    node.hidden = hits.length === 0;
    mount(node,
      icon('alert', '时间冲突'),
      h('span', { text: hits.length ? `时间与「${hits.map((item) => item.name).join('」「')}」重叠，保存后两课在网格上并排显示` : '' }));
  };
  paint([]);
  return { node, paint };
}

function courseFields(total) {
  return fieldsFor(TABLE, {
    only: ['name', 'day_of_week', 'start_time', 'end_time', 'week_type', 'start_week', 'end_week', 'teacher', 'location', 'color', 'note'],
    overrides: {
      day_of_week: { type: 'select', options: DAY_OPTIONS },
      start_week: { hint: `本学期共 ${total} 周` },
      end_week: { hint: '需不早于起始周' },
      color: { hint: '色块颜色，用来区分课程' },
      note: { type: 'textarea' },
    },
  });
}

function removeCourse(store, course) {
  const { token } = store.remove(TABLE, course.id);
  toast(`已删除「${course.name}」`, {
    kind: 'ok',
    action: '撤销',
    duration: 6000,
    onAction: () => { if (!store.undoRemove(token)) toast('删除已生效，无法撤销', { kind: 'error' }); },
  });
}

function courseForm({ store, config, courses, course = null, preset = {} }) {
  const total = config.total_weeks;
  // 冲突判定读的是渲染时的快照：写完成后 store 回读会重绘整页，浮层里的下一次判定就是新的
  const others = courses.filter((item) => item.id !== course?.id);
  const values = course ?? {
    day_of_week: 1, week_type: 'all', start_week: 1, end_week: total, color: FALLBACK_COLOR, ...preset,
  };
  const warn = conflictNotice();
  const merged = (draft) => normalizeCourse({ ...values, ...draft });
  const show = (draft) => warn.paint(T.findConflicts(merged(draft), others));
  return openLayer({
    title: course ? '编辑课程' : '新增课程',
    eyebrow: 'COURSE',
    fields: courseFields(total),
    values,
    submitLabel: course ? '保存改动' : '加入课表',
    twoColumns: true,
    extra: [warn.node],
    onDraft: show,
    onSubmit: async (draft) => {
      const row = normalizeCourse(draft);
      const hits = T.findConflicts(row, others);
      if (course) await store.update(TABLE, course.id, row);
      else await store.create(TABLE, row);
      if (hits.length) toast(`已强制保存：与 ${hits.map((item) => item.name).join('、')} 时间重叠`, { kind: 'error', duration: 6000 });
    },
  });
}

function courseDetail(course, { store, config, week, courses }) {
  const overlaps = T.findConflicts(course, courses);
  const facts = [
    ['星期', dowName(course.day_of_week)],
    ['时间', `${course.start_time}–${course.end_time}`],
    ['周次', `第 ${course.start_week}–${course.end_week} 周`],
    ['周型', WEEK_TYPE_LABELS[course.week_type] ?? course.week_type],
    ['教师', course.teacher],
    ['地点', course.location],
    ['备注', course.note],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const body = h('div.stack',
    h('p.dim', {
      text: T.courseActiveOnWeek(course, week)
        ? `本周（第 ${week} 周）上这门课`
        : `本周（第 ${week} 周）不上这门课`,
    }),
    h('div.kv', {}, ...facts.map(([key, value]) => h('div.kv-row',
      h('span.k', { text: key }), h('span.v', { text: String(value) })))),
    overlaps.length ? h('div.notice.warn',
      icon('alert', '时间冲突'),
      h('span', { text: `与「${overlaps.map((item) => item.name).join('」「')}」时间重叠` })) : null,
  );
  const handle = openLayer({
    title: course.name,
    eyebrow: 'COURSE',
    fields: [],
    extra: [body],
    submitLabel: '编辑这门课',
    onSubmit: () => { courseForm({ store, config, courses, course }); },
  });
  handle.foot.appendChild(h('button.btn.danger', {
    type: 'button', text: '删除课程',
    onclick: () => { handle.close({ submitted: false }); removeCourse(store, course); },
  }));
  return handle;
}

export function renderTimetable({ state, ctx, time, query }) {
  const config = state.config;
  if (!config) {
    return h('div.panel', emptyState({
      glyph: 'timetable', title: '还没有学期基准', hint: '课表按学期周次与节次表渲染，请先设置起始日与节次',
      cta: '去设置', onCta: () => { globalThis.location.hash = href(routeByKey('settings')); },
    }));
  }
  const store = ctx.store;
  const route = readRoute({ query, config, time });
  const mode = modeOf(store);
  const periods = config.periods ?? [];
  const courses = state.tables.courses;
  const conflicts = conflictIds(courses, route.week);
  const days = Array.from({ length: 7 }, (_, index) => T.addDays(route.range.start, index));
  const go = (patch) => ctx.navigate(`#/timetable?week=${T.clampWeek(patch.week ?? route.week, route.total)}&dow=${patch.dow ?? route.dow}`);
  const open = (course) => courseDetail(course, { store, config, week: route.week, courses });
  const addOnDay = (date) => courseForm({ store, config, courses, preset: { day_of_week: T.dayOfWeek(date) } });
  const pickSlot = (date, period) => courseForm({
    store,
    config,
    courses,
    preset: { day_of_week: T.dayOfWeek(date), start_time: period.start, end_time: period.end },
  });
  const live = courses.filter((course) => T.courseActiveOnWeek(course, route.week));
  const ghosts = courses.length - live.length;

  const toolbar = h('div.panel.tight',
    h('div.tt-toolbar',
      weekPicker({
        route,
        onMove: (delta) => go({ week: route.week + delta }),
        onJump: (week) => go({ week }),
        onParity: (parity) => go({ week: T.nextWeekOfParity(route.week, parity, route.total) }),
      }),
      h('span.badge.cyan', { text: T.parityOfWeek(route.week) === 'odd' ? '单周' : '双周' }),
      conflicts.size ? h('span.badge.orange', { text: `${conflicts.size} 门课时间冲突` }) : null,
      h('div.spacer'),
      viewSwitch(mode, (key) => store.setPref('ui.timetableView', key)),
      h('button.btn.primary', { type: 'button', text: '新增课程', onclick: () => courseForm({ store, config, courses }) }),
    ),
    h('p.tiny.faint', {
      text: `${T.fmtDate(route.range.start)} — ${T.fmtDate(route.range.end)} · 本周 ${live.length} 节${ghosts ? `，另有 ${ghosts} 门本周不上` : ''}`,
    }),
  );

  if (!courses.length) {
    return h('div.stack', toolbar, h('div.panel', emptyState({
      glyph: 'timetable', title: '还没有课程',
      hint: '手动把这学期的课录进来，也可以直接点网格里的空白时段建一条',
      cta: '录入第一门课', onCta: () => courseForm({ store, config, courses }),
    })));
  }

  const body = mode === 'list'
    ? listView({ courses, days, week: route.week, time, conflicts, onOpen: open, onAdd: addOnDay })
    : h('div.stack',
      mode === 'day' ? dayStrip({ days, day: route.day, onPick: (dow) => go({ dow }) }) : null,
      gridTable({
        courses, periods, days: mode === 'day' ? [route.day] : days, week: route.week, time, conflicts,
        onPick: pickSlot, onOpen: open, single: mode === 'day',
      }),
      h('div.tt-legend',
        h('span', { text: '色块 = 本周有课' }),
        h('span', { text: '30% 透明 = 本周不上' }),
        h('span', { text: '红描边 = 时间冲突' }),
        h('span', { text: '点空白时段即按这一节新建' }),
      ));

  return h('div.stack', toolbar, h('div.panel', body));
}

renderTimetable.onNew = ({ ctx, state, time }) => {
  if (!state.config) {
    toast('请先在设置里建立学期与节次', { kind: 'error' });
    return;
  }
  courseForm({ store: ctx.store, config: state.config, courses: state.tables.courses, preset: { day_of_week: T.dayOfWeek(time.today) } });
};
