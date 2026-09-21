// 首页（S9）：HUD 状态条 + 今日完成进度环 + 四分区卡片。
// 首页不存业务数据，唯一能在首页改的数据是待办勾选；卡片顺序属于 UI 偏好，存本地。
import { h, icon, mount } from '../lib/dom.js';
import * as T from '../lib/time.js';
import { emptyState, toast } from '../lib/ui.js';
import { progressRing } from '../lib/charts.js';

const ORDER_PREF = 'ui.homeCardOrder';
const DESKTOP_LIMIT = 6;
const MOBILE_LIMIT = 2;
const HOLD_MS = 380;

const CARD_DEFS = {
  courses: { eyebrow: 'TODAY · COURSES', title: '今日课程', link: '#/timetable' },
  tasks: { eyebrow: 'TODAY · TASKS', title: '今日待办', link: '#/tasks' },
  milestones: { eyebrow: 'RESEARCH', title: '近期里程碑', link: '#/research' },
  workouts: { eyebrow: 'THIS WEEK', title: '本周健身', link: '#/workout' },
};
const DEFAULT_ORDER = ['courses', 'tasks', 'milestones', 'workouts'];

/** 本地偏好可能被手改过或来自旧版本：只认已知卡片，缺的按默认顺序补在末尾。 */
export function normalizeOrder(saved) {
  const kept = (Array.isArray(saved) ? saved : []).filter((key) => key in CARD_DEFS);
  const picked = [...new Set(kept)];
  return [...picked, ...DEFAULT_ORDER.filter((key) => !picked.includes(key))];
}

function hud({ today, week, config, progress, next, now }) {
  const stamp = next ? `${next.date}T${next.time ?? '23:59'}:00` : '';
  const state = progress.total === 0 ? '' : progress.ratio >= 100 ? 'ok' : progress.ratio < 40 ? 'warn' : '';
  return h('section.hud',
    h('div.readout',
      h('b', { text: T.fmtDate(today) }),
      h('div.week', { text: week ? `第 ${week} 周 / 共 ${config.total_weeks} 周 · ${T.parityOfWeek(week) === 'odd' ? '单周' : '双周'}` : '不在学期内' }),
      h('div.sub', { text: `今日待办 ${progress.done}/${progress.total} 已完成` }),
    ),
    h('div.ring-row',
      progressRing(progress.ratio, {
        label: '今日完成',
        caption: `${progress.done}/${progress.total}`,
        state,
      }),
    ),
    next
      ? h('div.next', { class: next.kind === 'task' ? '' : 'safe' },
        h('div.label', { text: next.kind === 'task' ? 'NEXT DEADLINE' : 'NEXT MILESTONE' }),
        h('div.title.truncate', { text: next.title }),
        h('div.remain', {}, `${T.fmtDate(next.date)}${next.time ? ` ${next.time}` : ''} · `,
          h('span', { dataset: { countdown: stamp }, text: T.countdownText(stamp, now) })),
      )
      : h('div.next.safe', h('div.label', { text: 'NEXT' }), h('div.title', { text: '今天没有到期事项' })),
  );
}

function courseLine(course, nowMinutes) {
  const started = T.hm2min(course.start_time) ?? 0;
  const ended = T.hm2min(course.end_time) ?? 0;
  return h('div.list-row', { class: ended < nowMinutes ? 'is-past' : started <= nowMinutes ? 'is-current' : '' },
    h('span.colorbar', { style: { background: course.color ?? 'var(--cyan)' } }),
    h('span.t', { text: course.start_time }),
    h('div.truncate', h('div.title', { text: course.name }), h('div.meta', { text: [course.location, course.teacher].filter(Boolean).join(' · ') })),
    h('div.spacer'),
    course.week_type === 'all' ? null : h('span.badge.grey', { text: course.week_type === 'odd' ? '单周' : '双周' }),
  );
}

/** 指示线插在"上一节已结束"与"下一节还没结束"之间；全天都结束了就落在最后。 */
function nowlineIndex(courses, nowMinutes) {
  const index = courses.findIndex((course) => (T.hm2min(course.end_time) ?? 0) > nowMinutes);
  return index === -1 ? courses.length : index;
}

function courseList(courses, nowMinutes) {
  const visible = courses.slice(0, DESKTOP_LIMIT);
  const rows = visible.map((course, index) => {
    const node = courseLine(course, nowMinutes);
    if (index >= MOBILE_LIMIT) node.classList.add('hide-sm');
    return node;
  });
  const at = nowlineIndex(visible, nowMinutes);
  return [...rows.slice(0, at), h('div.nowline', h('span.t', { text: T.minutesToHhmm(nowMinutes) }), h('span.rule')), ...rows.slice(at)];
}

function taskLine(task, today, onToggle) {
  const overdue = T.overdueDays(task, today);
  return h('div.list-row', { class: [task.done ? 'is-done' : '', overdue ? 'is-overdue' : ''].filter(Boolean).join(' ') },
    h('button.tick', {
      type: 'button', role: 'checkbox', 'aria-checked': task.done ? 'true' : 'false',
      'aria-label': `标记${task.done ? '未完成' : '完成'}：${task.title}`,
      onclick: onToggle,
    }, icon('check')),
    h('div.truncate', h('div.title', { text: task.title }), h('div.meta', { text: overdue ? `逾期 ${overdue} 天` : (task.due_time ?? '今天') })),
  );
}

function milestoneLine(milestone, projects, today) {
  const days = T.remainingDays(milestone.target_date, today);
  const label = days === null ? '未定目标日' : days < 0 ? `已过期 ${-days} 天` : `还剩 ${days} 天`;
  return h('div.list-row',
    h('div.truncate',
      h('div.title', { text: milestone.title }),
      h('div.meta', { text: `${projects.get(milestone.project_id)?.name ?? '项目'} · ${label}` }),
      h('div.progress', { class: days !== null && days < 3 ? 'warn' : '' }, h('i', { style: { width: `${T.progressOf(milestone)}%` } })),
    ),
    h('span.num.dim', { text: `${T.progressOf(milestone)}%` }),
  );
}

/** 首页只有这一个写入动作（PRD 6：不改数据，除了勾选待办）。 */
function toggleTask(store, task) {
  store.update('tasks', task.id, {
    done: !task.done, done_at: !task.done ? new Date().toISOString() : null,
  }).catch(() => {});
}

export function renderHome({ state, ctx, time }) {
  const today = time.today;
  const week = T.weekOf(today, state.config);
  const progress = T.todayProgress(state.tables.tasks, today);
  const next = T.nextDueItem(state.tables.tasks, state.tables.milestones, today);
  const nowMinutes = time.now.getHours() * 60 + time.now.getMinutes();
  const projects = new Map(state.tables.research_projects.map((item) => [item.id, item]));
  // coursesOnDay 会带上本周不上课的课程（课表页要灰显），首页只列今天真的会发生的课
  const courses = week === null ? [] : T.coursesOnDay(state.tables.courses, week, today).filter((course) => course.active);
  const tasks = T.tasksForDay(state.tables.tasks, today);
  const milestones = T.recentMilestones(state.tables.milestones);
  const stats = T.workoutStats(state.tables.workouts, T.currentWeekRange(state.config, today));

  const grid = h('div.home-grid');
  // 长按拖拽只在拖的这几秒里存在：抬起才写偏好，中途换页就等于放弃
  let order = normalizeOrder(ctx.store.pref(ORDER_PREF, null));
  let sorting = null;
  let hold = null;

  const cancelHold = () => {
    if (hold) globalThis.clearTimeout(hold);
    hold = null;
  };

  function commit(nextOrder) {
    order = nextOrder;
    ctx.store.setPref(ORDER_PREF, order);
  }

  function step(key, delta) {
    const from = order.indexOf(key);
    const to = from + delta;
    if (to < 0 || to >= order.length) return;
    commit(T.reorder(order, from, to));
    paint();
  }

  function hover(key) {
    if (!sorting || key === sorting) return;
    order = T.reorder(order, order.indexOf(sorting), order.indexOf(key));
    paint();
  }

  function drop() {
    if (!sorting) return;
    sorting = null;
    commit(order);
    toast('卡片顺序已保存', { kind: 'ok', duration: 2000 });
    paint();
  }

  function press(event, key) {
    // 卡片头上还有上移/下移和「查看全部」：按在这些控件上不该同时启动拖拽
    if (sorting || event.button || event.target?.closest?.('button,a')) return;
    cancelHold();
    hold = globalThis.setTimeout(() => { sorting = key; paint(); }, HOLD_MS);
  }

  const cards = {
    courses: courses.length
      ? h('div.card-list', {}, ...courseList(courses, nowMinutes))
      : emptyState({ glyph: 'timetable', title: week === null ? '不在学期内' : '今天没有课', hint: week === null ? '到设置里确认学期起始日' : '好好安排这一天' }),
    tasks: tasks.length
      ? h('div.card-list', {}, ...tasks.slice(0, DESKTOP_LIMIT).map((task, index) => {
        const node = taskLine(task, today, () => toggleTask(ctx.store, task));
        if (index >= MOBILE_LIMIT) node.classList.add('hide-sm');
        return node;
      }))
      : emptyState({ glyph: 'tasks', title: '今天没有待办', hint: '去日程页记一条' }),
    milestones: milestones.length
      ? h('div.card-list', {}, ...milestones.map((item, index) => {
        const node = milestoneLine(item, projects, today);
        if (index >= MOBILE_LIMIT) node.classList.add('hide-sm');
        return node;
      }))
      : emptyState({ glyph: 'research', title: '暂无进行中的里程碑', hint: '在科研页建项目和里程碑' }),
    workouts: h('div',
      h('div.readout-grid',
        h('div.readout-cell', h('div.k', { text: '次数' }), h('div.v', { text: String(stats.sessions) })),
        h('div.readout-cell', h('div.k', { text: '时长' }), h('div.v', {}, String(stats.minutes), h('small', { text: ' 分钟' }))),
        h('div.readout-cell', h('div.k', { text: '连续天数' }), h('div.v', { text: String(T.streakOf(state.tables.workouts, today)) })),
      ),
      h('div.quick-read', { text: stats.sessions
        ? `有练 ${stats.activeDays} 天 · 完成 ${stats.done} · 部分 ${stats.partial} · 缺练 ${stats.missed}`
        : '本周还没有训练记录，去健身页记第一笔' }),
    ),
  };

  function card(key, index) {
    const def = CARD_DEFS[key];
    return h('section.panel', {
      class: sorting === key ? 'is-sorting' : '',
      dataset: { card: key },
      onpointerover: () => hover(key),
      onpointerup: drop,
      onpointercancel: drop,
    },
      h('div.panel-head', {
        title: `长按卡片头 ${Math.round(HOLD_MS / 1000 * 10) / 10} 秒可拖动排序`,
        onpointerdown: (event) => press(event, key),
        onpointerup: cancelHold,
        onpointerleave: cancelHold,
      },
        h('div', h('span.eyebrow', { text: def.eyebrow }), h('h3', { text: def.title })),
        h('div.spacer'),
        h('div.card-sort', { role: 'group', 'aria-label': `调整卡片顺序：${def.title}` },
          h('button.iconbtn', {
            type: 'button', disabled: index === 0, 'aria-label': `上移卡片：${def.title}`,
            onclick: () => step(key, -1),
          }, icon('arrowUp')),
          h('button.iconbtn', {
            type: 'button', disabled: index >= order.length - 1, 'aria-label': `下移卡片：${def.title}`,
            onclick: () => step(key, 1),
          }, icon('arrowDown')),
        ),
        h('a.btn.sm.ghost', { href: def.link, 'aria-label': `查看${def.title}` }, '查看全部', icon('chevRight')),
      ),
      cards[key],
    );
  }

  function paint() {
    mount(grid, ...order.map((key, index) => card(key, index)));
  }

  paint();
  return h('div.stack',
    hud({ today, week, config: state.config ?? {}, progress, next, now: time.now }),
    grid,
  );
}
