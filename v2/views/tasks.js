import { h, mount } from '../lib/dom.js';
import { loadTasks, toggleTask, removeTask, upsertTask, StoreError } from '../lib/store.js';
import { parseDate, dayKey, diffDays, fmtDateCN } from '../lib/time.js';
import { openTaskForm } from '../components/taskForm.js';
import { toast } from '../lib/feedback.js';
import { renderEmpty } from '../components/emptyState.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '未完成' },
  { key: 'done', label: '已完成' },
];

let filter = 'all';
let ctx = null;

function groupOf(t, now) {
  const d = diffDays(now, parseDate(t.date));
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  const daysToSunday = 7 - ((now.getDay() + 6) % 7);
  if (d <= daysToSunday) return 'thisWeek';
  return 'future';
}

const GROUP_META = {
  overdue: { label: '逾期', bar: 'bar-orange' },
  today: { label: '今天', bar: 'bar-cyan' },
  tomorrow: { label: '明天', bar: 'bar-cyan' },
  thisWeek: { label: '本周内', bar: '' },
  future: { label: '未来', bar: '' },
};

function timeStr(t) {
  if (t.startTime && t.endTime) return `${t.startTime}-${t.endTime}`;
  if (t.startTime) return t.startTime;
  return '';
}

function sortTasks(list) {
  return list.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const at = a.startTime || '99:99';
    const bt = b.startTime || '99:99';
    if (at !== bt) return at < bt ? -1 : 1;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

function taskRow(t, now, focusId) {
  const g = groupOf(t, now);
  const bar = GROUP_META[g].bar;
  const meta = [timeStr(t), t.location, t.date === dayKey(now) ? '' : t.date].filter(Boolean).join(' · ');
  const row = h(
    'div', {
      class: `tk-row${t.done ? ' done' : ''} ${bar}${focusId === t.id ? ' flash' : ''}`,
      'data-id': t.id,
    },
    h('button', {
      class: 'tk-check', type: 'button', role: 'checkbox', 'aria-checked': t.done ? 'true' : 'false',
      'aria-label': t.done ? '标记未完成' : '标记完成',
      onclick: () => {
        try { toggleTask(t.id); rerender(); }
        catch (err) { if (err instanceof StoreError) toast(err.message); else throw err; }
      },
    }),
    h('div', { class: 'tk-main', onclick: () => openTaskForm({ task: t, onSaved: rerender, onDelete: deleteTask }) },
      h('div', { class: 'tk-title' }, t.title),
      meta ? h('div', { class: 'tk-meta' }, meta) : null,
    ),
  );
  attachRowSwipe(row, t);
  return row;
}

function deleteTask(t) {
  try {
    removeTask(t.id);
    rerender();
    toast(`已删除「${t.title}」`, {
      actionLabel: '撤销',
      onAction: () => { upsertTask(t); rerender(); },
    });
  } catch (err) {
    if (err instanceof StoreError) toast(err.message);
    else throw err;
  }
}

function attachRowSwipe(row, t) {
  let startX = null;
  row.addEventListener('touchstart', (e) => { startX = e.touches?.[0]?.clientX ?? e.clientX ?? null; });
  row.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = (e.changedTouches?.[0]?.clientX ?? e.clientX ?? startX) - startX;
    startX = null;
    if (dx < -60) deleteTask(t);
  });
}

function rerender() {
  if (ctx) render(ctx.el, ctx.params, new Date());
}

export function render(el, params, now = new Date()) {
  ctx = { el, params };
  const focusId = params?.get?.('focus') ?? null;
  let tasks = loadTasks();
  if (filter === 'open') tasks = tasks.filter((t) => !t.done);
  if (filter === 'done') tasks = tasks.filter((t) => t.done);

  const groups = { overdue: [], today: [], tomorrow: [], thisWeek: [], future: [] };
  for (const t of tasks) groups[groupOf(t, now)].push(t);

  const root = h('div', { class: 'tk' });
  root.appendChild(
    h('div', { class: 'seg', role: 'tablist', 'aria-label': '筛选' },
      ...FILTERS.map((f) => h('button', {
        class: `seg-btn${filter === f.key ? ' active' : ''}`, type: 'button', role: 'tab',
        'aria-selected': filter === f.key ? 'true' : 'false',
        onclick: () => { filter = f.key; rerender(); },
      }, f.label)),
    ),
  );

  let shown = 0;
  for (const key of Object.keys(groups)) {
    const list = sortTasks(groups[key]);
    if (!list.length) continue;
    shown += list.length;
    const dateHint = key === 'today' ? ` · ${fmtDateCN(now)}` : '';
    root.appendChild(
      h('section', { class: `tk-group g-${key}` },
        h('h2', { class: 'tk-group-head' }, `${GROUP_META[key].label}${dateHint} (${list.length})`),
        ...list.map((t) => taskRow(t, now, focusId)),
      ),
    );
  }

  if (!shown) {
    root.appendChild(renderEmpty({
      text: filter === 'done' ? '还没有已完成的日程' : '还没有日程，点右下角记一笔',
      actionText: '记一笔',
      onAction: () => openTaskForm({ onSaved: rerender }),
    }));
  }

  root.appendChild(h('button', {
    class: 'fab', type: 'button', 'aria-label': '新建日程',
    onclick: () => openTaskForm({ onSaved: rerender }),
  }, '＋'));

  mount(el, root);
  return root;
}

export function __reset() { ctx = null; filter = 'all'; }
