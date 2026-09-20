// 日程页（S5）：今日/本周/全部/已完成分段 + 分类与状态筛选 + 日期分组列表
// + 逾期顺延 + 弱解析快速添加。所有取数口径都在 lib/time.js，这里只管渲染与写入。
import { h, mount, icon } from '../lib/dom.js';
import * as T from '../lib/time.js';
import { toast, emptyState, openLayer, fieldsFor, swipeDelete } from '../lib/ui.js';

const TABLE = 'tasks';
const CATEGORIES = ['作业', '科研', '生活', '其它'];
const IDLE_READOUT = '只认「X月X日」「HH:MM」「N分钟」，其余全部留在标题里；没写日期就记在今天';

// 分段与筛选是"此刻在看哪一叠"，属于浏览位置：PRD 7.4 只允许三项 UI 偏好落本地，
// 所以这里放模块内存，刷新回到默认分段。
const view = { segment: 'today', category: 'all', status: 'all' };

async function toggle(task, { store }) {
  const done = !task.done;
  await store.update(TABLE, task.id, { done, done_at: done ? new Date().toISOString() : null });
}

function removeTask(task, { store }) {
  const { token } = store.remove(TABLE, task.id);
  toast(`已删除「${task.title}」`, {
    kind: 'ok',
    action: '撤销',
    duration: 6000,
    onAction: () => { if (!store.undoRemove(token)) toast('删除已生效，无法撤销', { kind: 'error' }); },
  });
}

function postpone(task, target, helpers) {
  helpers.store.update(TABLE, task.id, { due_date: target.date })
    .then(() => toast(`「${task.title}」已顺延到 ${T.fmtDate(target.date)}`, { kind: 'ok' }))
    .catch(() => {});
}

/** 勾选框与表单里的「已完成」都要同步 done_at，否则统计与沉底排序读到的是旧时间。 */
function withDoneAt(values, previous = null) {
  // 输入框清空交回的是 ''：这里统一成 null，让"收集箱/无时长"在本地状态里也是空值，
  // 不必等服务端回读才矫正。
  const next = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === '' ? null : value]));
  next.done_at = next.done
    ? (previous?.done && previous.done_at ? previous.done_at : new Date().toISOString())
    : null;
  return next;
}

function taskFields() {
  return fieldsFor(TABLE, {
    only: ['title', 'due_date', 'due_time', 'duration_min', 'category', 'note', 'done'],
    overrides: {
      note: { type: 'textarea' },
      duration_min: { hint: '用于今日完成度估算，可留空' },
      due_date: { hint: '留空即进入收集箱' },
      done: { onLabel: '已完成', offLabel: '未完成' },
    },
  });
}

function taskForm({ title, submitLabel, fields, values, write }) {
  return openLayer({
    title,
    eyebrow: 'TASK',
    fields,
    values,
    submitLabel,
    onSubmit: async (draft) => write(withDoneAt(draft, values)),
  });
}

function editTask(task, helpers) {
  return taskForm({
    title: '编辑日程',
    submitLabel: '保存改动',
    fields: taskFields(),
    values: task,
    write: (row) => helpers.store.update(TABLE, task.id, row),
  });
}

function newTaskForm(helpers, preset = {}) {
  return taskForm({
    title: '新增日程',
    submitLabel: '加入日程',
    fields: taskFields(),
    values: { done: false, due_date: T.todayKey(), category: '其它', ...preset },
    write: (row) => helpers.store.create(TABLE, row),
  });
}

function overdueBadge(days) {
  return h('span.badge.orange', { text: `逾期 ${days} 天` });
}

function postponeBar(task, helpers, today) {
  return h('div.postpone', ...T.postponeTargets(today).map((target) => h('button.chip', {
    type: 'button', text: target.label, 'aria-label': `${target.label}：${task.title}`,
    onclick: () => postpone(task, target, helpers),
  })));
}

function taskRow(task, helpers, today) {
  const overdue = T.overdueDays(task, today);
  const row = h('div.list-row', {
    class: [task.done ? 'is-done' : '', overdue ? 'is-overdue' : ''].filter(Boolean).join(' '),
  },
    h('button.tick', {
      type: 'button', role: 'checkbox', 'aria-checked': task.done ? 'true' : 'false',
      'aria-label': task.done ? `标记未完成：${task.title}` : `标记完成：${task.title}`,
      onclick: () => toggle(task, helpers).catch(() => {}),
    }, icon('check')),
    h('div.truncate', { style: { minWidth: '0' } },
      h('div.title', { text: task.title }),
      h('div.meta', {},
        h('span', {
          text: [
            task.due_date
              ? `${task.due_date === today ? '今天' : T.fmtDateShort(task.due_date)}${task.due_time ? ` ${task.due_time}` : ''}`
              : '未定日期',
            task.category ?? '',
            task.duration_min ? `${task.duration_min} 分钟` : '',
          ].filter(Boolean).join(' · '),
        }),
        overdue ? overdueBadge(overdue) : null,
      ),
      overdue ? postponeBar(task, helpers, today) : null,
    ),
    h('div.spacer'),
    h('button.iconbtn', { type: 'button', 'aria-label': `编辑 ${task.title}`, onclick: () => editTask(task, helpers) }, icon('pencil')),
    h('button.iconbtn.danger', { type: 'button', 'aria-label': `删除 ${task.title}`, onclick: () => removeTask(task, helpers) }, icon('trash')),
  );
  swipeDelete(row, { onDelete: () => removeTask(task, helpers) });
  return row;
}

function quickAdd(helpers, today) {
  const input = h('input', {
    type: 'text', maxlength: '80', placeholder: '记一条待办，可带 9月25日 20:00 45分钟',
  });
  const readout = h('div.quick-read', { text: IDLE_READOUT });
  const parse = () => T.parseQuickAdd(input.value, today);
  const paintReadout = () => {
    const parsed = parse();
    if (!input.value.trim()) readout.textContent = IDLE_READOUT;
    else if (!parsed.found.length) readout.textContent = '没有识别出日期或时间，整句作为标题';
    else readout.textContent = `识别到 ${parsed.found.join(' · ')} → 标题「${parsed.title}」`;
    return parsed;
  };
  input.addEventListener('input', paintReadout);
  const submit = async () => {
    const parsed = paintReadout();
    if (!parsed.title) {
      readout.textContent = '先写一句要做什么';
      input.focus?.();
      return;
    }
    input.value = '';
    readout.textContent = IDLE_READOUT;
    await helpers.store.create(TABLE, {
      title: parsed.title,
      done: false,
      due_date: parsed.due_date ?? today,
      due_time: parsed.due_time,
      duration_min: parsed.duration_min,
    }).catch(() => {});
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit().catch(() => {}); }
  });
  return h('div.panel',
    h('div.panel-head',
      h('div', h('span.eyebrow', { text: 'QUICK ADD' }), h('h3', { text: '快速记一条' })),
      h('div.spacer'),
      h('button.btn.sm', {
        type: 'button', text: '完整表单',
        onclick: () => {
          const { title, due_date: date, due_time: time_, duration_min: minutes } = paintReadout();
          newTaskForm(helpers, { title, due_date: date ?? today, due_time: time_, duration_min: minutes });
        },
      }),
    ),
    h('div.row', { style: { gap: '8px' } },
      input,
      h('button.iconbtn', { type: 'button', 'aria-label': '添加', onclick: () => submit().catch(() => {}) }, icon('plus')),
    ),
    readout,
  );
}

function filterColumn(name, label, options, pick) {
  return h('div.filter-col',
    h('h4', { text: label }),
    ...options.map((option) => h('button.filter-item', {
      type: 'button', 'aria-pressed': view[name] === option.key ? 'true' : 'false',
      onclick: () => pick({ [name]: option.key }),
    }, h('span', { text: option.label }))),
  );
}

function controlBar(tasks, segment, matched, today, pick) {
  const counts = T.segmentCounts(tasks, today);
  const dropped = segment.length - matched.length;
  return h('div.controls',
    h('div.seg', { role: 'group', 'aria-label': '分段查看' },
      ...T.TASK_SEGMENTS.map(({ key, label }) => h('button', {
        type: 'button', 'aria-pressed': view.segment === key ? 'true' : 'false',
        onclick: () => pick({ segment: key }),
      }, h('span', { text: label }), h('span.num', { text: String(counts[key] ?? 0) })))),
    h('div.filters',
      filterColumn('category', '分类', [{ key: 'all', label: '全部分类' }, ...CATEGORIES.map((name) => ({ key: name, label: name }))], pick),
      // 已完成分段本身就限定了状态，再挂一个状态筛选只会筛出空列表
      view.segment === 'done' ? null : filterColumn('status', '状态', T.TASK_STATUS_FILTERS, pick),
      dropped > 0 ? h('button.chip', {
        type: 'button', text: `清除筛选（隐去 ${dropped} 条）`,
        onclick: () => pick({ category: 'all', status: 'all' }),
      }) : null,
    ),
  );
}

function groupSections(rows, helpers, today) {
  return T.groupByDate(rows, (task) => task.due_date).map((group) => {
    const isOverdueGroup = group.date !== null && group.date < today && group.rows.some((task) => !task.done);
    const label = group.date === null ? '收集箱 · 未定日期'
      : group.date === today ? '今天'
        : isOverdueGroup ? `${T.fmtDate(group.date)} · 已逾期` : T.fmtDate(group.date);
    return h('section.group', { class: isOverdueGroup ? 'is-overdue' : '' },
      h('div.group-head',
        h('h3', { text: label }),
        h('div.spacer'),
        h('span.count', {
          text: group.date === null ? String(group.rows.length)
            : `${group.rows.filter((task) => task.done).length}/${group.rows.length}`,
        }),
      ),
      h('div.card-list', {}, ...T.orderGroupRows(group.rows).map((task) => taskRow(task, helpers, today))),
    );
  });
}

function noMatches(pick) {
  const filtering = view.category !== 'all' || view.status !== 'all';
  return h('div.panel', emptyState({
    glyph: 'tasks',
    title: filtering ? '这些条件下没有条目' : '这一叠是空的',
    hint: filtering ? '换一个分类或状态，或者直接清除筛选' : '换个分段看看，或者在上方记一条新的',
    cta: filtering ? '清除筛选' : '看看全部',
    onCta: () => pick(filtering ? { category: 'all', status: 'all' } : { segment: 'all' }),
  }));
}

export function renderTasks({ state, ctx, time }) {
  const helpers = { store: ctx.store };
  const today = time.today;
  const tasks = state.tables.tasks;
  const controls = h('div');
  const body = h('div.stack');
  const pick = (patch) => {
    Object.assign(view, patch);
    paint();
  };

  function paint() {
    const segment = T.segmentTasks(tasks, view.segment, today);
    const matched = T.filterTasks(segment, view, today);
    mount(controls, controlBar(tasks, segment, matched, today, pick));
    mount(body, ...(!tasks.length
      ? [h('div.panel', emptyState({
        glyph: 'tasks',
        title: '还没有日程',
        hint: '先把作业、考试和约会记下来，逾期的会自动标橙',
        cta: '新增第一条',
        onCta: () => newTaskForm(helpers, { due_date: today }),
      }))]
      : matched.length ? groupSections(matched, helpers, today) : [noMatches(pick)]));
  }

  paint();
  return h('div.stack', controls, quickAdd(helpers, today), body);
}

renderTasks.onNew = ({ ctx, time }) => newTaskForm({ store: ctx.store }, { due_date: time.today });
