// 科研页（S7）：项目卡片列表 + 详情页的里程碑时间线、子任务勾选与自动/手动进度。
// 进度算式与排序原语只在 lib/time.js 有一份；级联删除与自动进度回写由 Function 兜底。
import { h, icon } from '../lib/dom.js';
import * as T from '../lib/time.js';
import { toast, emptyState, openLayer, fieldsFor, confirmDialog, swipeDelete } from '../lib/ui.js';

const PROJECTS = 'research_projects';
const MILESTONES = 'milestones';
const SUBTASKS = 'subtasks';
const STATUS_BADGE = { not_started: 'grey', active: 'cyan', blocked: 'orange', done: 'green' };
const STATUS_TEXT = { not_started: '未开始', active: '进行中', blocked: '受阻', done: '已完成' };

const narrow = () => globalThis.matchMedia?.('(max-width: 639px)')?.matches === true;
/** 手风琴开合是浏览位置：PRD 7.4 只允许三项 UI 偏好落本地，所以放模块内存，刷新回到按端型展开。 */
const folded = new Map();
const isFoldOpen = (id) => (folded.has(id) ? folded.get(id) : !narrow());

const childrenOf = (subtasks, milestoneId) => T.sortRows(subtasks.filter((item) => item.milestone_id === milestoneId));
const ofProject = (rows, projectId) => T.sortRows(rows.filter((item) => item.project_id === projectId));

function statusBadge(status) {
  return h('span.badge', { class: STATUS_BADGE[status] ?? 'grey', text: STATUS_TEXT[status] ?? status });
}

function dueLabel(milestone, today) {
  const days = T.remainingDays(milestone.target_date, today);
  if (days === null) return '未定目标日';
  if (days < 0) return `逾期 ${-days} 天`;
  if (days === 0) return '今天到期';
  return `剩 ${days} 天`;
}

/** 删除一律给 5 秒撤销；级联子孙一并交给 store，撤销才放回得完整。 */
function removeRow(store, table, row, { label, related }) {
  const { token } = store.remove(table, row.id, related ? { related } : {});
  toast(`已删除「${label}」`, {
    kind: 'ok',
    action: '撤销',
    duration: 6000,
    onAction: () => { if (!store.undoRemove(token)) toast('删除已生效，无法撤销', { kind: 'error' }); },
  });
}

// ── 三个层级的表单 ────────────────────────────────────────

function projectForm({ store, project = null }) {
  return openLayer({
    title: project ? '编辑项目' : '新增科研项目',
    eyebrow: 'PROJECT',
    fields: fieldsFor(PROJECTS, {
      only: ['name', 'description', 'status'],
      overrides: { description: { type: 'textarea', hint: '目标、约束与合作方，可留空' } },
    }),
    values: project ?? { status: 'active' },
    submitLabel: project ? '保存改动' : '建立项目',
    onSubmit: async (draft) => {
      if (project) await store.update(PROJECTS, project.id, draft);
      else await store.create(PROJECTS, draft);
    },
  });
}

async function deleteProject(project, { store, milestones, subtasks, after }) {
  const mine = ofProject(milestones, project.id);
  const ids = new Set(mine.map((item) => item.id));
  const kids = subtasks.filter((item) => ids.has(item.milestone_id));
  const confirmed = await confirmDialog({
    title: `删除「${project.name}」`,
    message: '项目与其累计进度都会移除。',
    detail: mine.length || kids.length
      ? `其下 ${mine.length} 个里程碑、${kids.length} 个子任务会一并删除。`
      : '这个项目还没有里程碑。',
    confirmLabel: '确认删除',
  });
  if (!confirmed) return;
  after?.();
  removeRow(store, PROJECTS, project, {
    label: project.name,
    related: { milestones: mine, subtasks: kids },
  });
}

function milestoneForm({ store, project, milestone = null, preset = {} }) {
  return openLayer({
    title: milestone ? '编辑里程碑' : '新增里程碑',
    eyebrow: 'MILESTONE',
    fields: fieldsFor(MILESTONES, {
      only: ['title', 'target_date', 'status', 'note'],
      overrides: {
        note: { type: 'textarea' },
        target_date: { hint: '留空即只按进度推进，不进首页"近期里程碑"' },
      },
    }),
    values: milestone ?? { status: 'not_started', ...preset },
    submitLabel: milestone ? '保存改动' : '加入时间线',
    onSubmit: async (draft) => {
      if (milestone) await store.update(MILESTONES, milestone.id, draft);
      // 未填目标日期即"未定目标日"：显式交 ''，由 Function 归一成 null
      else await store.create(MILESTONES, { ...draft, target_date: draft.target_date ?? '', project_id: project.id, progress: 0, manual_progress: false });
    },
  });
}

async function deleteMilestone(milestone, { store, children }) {
  const confirmed = await confirmDialog({
    title: `删除「${milestone.title}」`,
    message: '里程碑会从时间线上移除。',
    detail: children.length
      ? `其下 ${children.length} 个子任务会一并删除。`
      : '这个里程碑还没有子任务。',
    confirmLabel: '确认删除',
  });
  if (!confirmed) return;
  removeRow(store, MILESTONES, milestone, {
    label: milestone.title,
    related: children.length ? { subtasks: children } : undefined,
  });
}

function subtaskForm({ store, subtask }) {
  return openLayer({
    title: '编辑子任务',
    eyebrow: 'SUBTASK',
    fields: fieldsFor(SUBTASKS, { only: ['title'] }),
    values: subtask,
    submitLabel: '保存改动',
    onSubmit: async (draft) => store.update(SUBTASKS, subtask.id, draft),
  });
}

// ── 进度：自动 = 子任务完成比例，解锁后手填不再被覆盖 ──────

function progressControl(milestone, children, { store }) {
  const read = T.milestoneProgress(milestone, children);
  const write = (progress, manual) => store.update(MILESTONES, milestone.id, {
    progress: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))),
    manual_progress: manual,
  }).catch(() => {});
  const input = read.manual ? h('input.pct-input', {
    type: 'number', min: '0', max: '100', step: '5', value: String(read.value),
    'aria-label': `手填进度百分比：${milestone.title}`,
    onchange: (event) => write(event.target.value, true),
  }) : h('b.pct', { text: `${read.value}%` });
  const toggle = h('button.chip.tl-lock', {
    type: 'button', 'aria-pressed': String(read.manual),
    title: read.manual ? '已解锁：手填值不会被子任务覆盖' : '锁定中：进度 = 子任务完成比例',
    'aria-label': `${read.manual ? '恢复自动进度' : '解锁手填进度'}：${milestone.title}`,
    // 两个方向都先落回自动值：解锁时"以当前自动值为起点"，锁回时"立即回到自动值"
    onclick: () => write(read.auto, !read.manual),
  }, icon(read.manual ? 'unlock' : 'lock'), h('span', { text: read.manual ? '已手动' : '自动' }));
  return h('div.tl-progress',
    h('div.progress', { class: milestone.status === 'done' ? 'done' : read.differs ? 'warn' : '' },
      h('i', { style: { width: `${read.value}%` } })),
    input,
    read.manual ? h('span.badge.orange', { text: '手动' }) : null,
    toggle,
    read.differs ? h('span.tiny.orange', { text: `自动算出 ${read.auto}%（${read.done}/${read.total}）` }) : null,
  );
}

// ── 排序：桌面拖拽，移动端上/下按钮，两者写同一份 sort ─────

function sortControl({ index, count, title, move }) {
  return h('div.tl-sort', { role: 'group', 'aria-label': `调整里程碑顺序：${title}` },
    h('button.iconbtn', {
      type: 'button', disabled: index === 0, 'aria-label': `上移：${title}`,
      onclick: () => move(index, index - 1),
    }, icon('arrowUp')),
    h('button.iconbtn', {
      type: 'button', disabled: index >= count - 1, 'aria-label': `下移：${title}`,
      onclick: () => move(index, index + 1),
    }, icon('arrowDown')),
  );
}

async function commitOrder(store, list) {
  const patches = T.sortPatches(list);
  await Promise.all(patches.map((patch) => store.update(MILESTONES, patch.id, { sort: patch.sort })));
}

// ── 时间线上的一个里程碑 ───────────────────────────────────

function milestoneItem(milestone, { index, count, children, project, store, today, move, drag }) {
  const open = isFoldOpen(milestone.id);
  const detailId = `tl-detail-${milestone.id}`;
  const detail = h('div.tl-detail', { id: detailId, hidden: !open },
    children.length
      ? h('div.card-list', {}, ...children.map((child) => subtaskRow(child, { store, milestone })))
      : h('p.tiny.faint', { text: '还没有子任务，加几条就能自动累计进度' }),
    addSubtaskRow(milestone, { store, project }),
  );
  const fold = h('button.chip.tl-fold', {
    type: 'button', 'aria-expanded': String(open), 'aria-controls': detailId,
    'aria-label': `${open ? '收起' : '展开'}子任务：${milestone.title}`,
    onclick: () => {
      const next = fold.getAttribute('aria-expanded') !== 'true';
      folded.set(milestone.id, next);
      fold.setAttribute('aria-expanded', String(next));
      fold.setAttribute('aria-label', `${next ? '收起' : '展开'}子任务：${milestone.title}`);
      fold.querySelector('.fold-label').textContent = next ? '收起子任务' : '展开子任务';
      body.classList.toggle('is-open', next);
      detail.hidden = !next;
    },
  }, icon('chevDown'), h('span.fold-label', { text: open ? '收起子任务' : '展开子任务' }));

  const body = h('div.tl-body', {
    class: open ? 'is-open' : '',
    draggable: 'true',
    ondragstart: (event) => {
      drag.start(index);
      event.target?.classList?.add?.('dragging');
    },
    ondragover: (event) => { event.preventDefault?.(); event.target?.classList?.add?.('drag-over'); },
    ondragleave: (event) => { event.target?.classList?.remove?.('drag-over'); },
    ondrop: (event) => {
      event.preventDefault?.();
      event.target?.classList?.remove?.('drag-over');
      drag.drop(index);
    },
    ondragend: (event) => {
      event.target?.classList?.remove?.('dragging');
      drag.cancel();
    },
  },
    h('div.tl-head',
      h('h4.truncate', { text: milestone.title }),
      statusBadge(milestone.status),
      h('div.spacer'),
      sortControl({ index, count, title: milestone.title, move }),
      h('button.iconbtn', {
        type: 'button', 'aria-label': `编辑里程碑：${milestone.title}`,
        onclick: () => milestoneForm({ store, project, milestone }),
      }, icon('pencil')),
      h('button.iconbtn.danger', {
        type: 'button', 'aria-label': `删除里程碑：${milestone.title}`,
        onclick: () => deleteMilestone(milestone, { store, children }).catch(() => {}),
      }, icon('trash')),
    ),
    h('div.progress-meta',
      h('span', { text: dueLabel(milestone, today) }),
      milestone.target_date ? h('span', { text: T.fmtDateShort(milestone.target_date) }) : null,
      h('div.spacer'),
      fold,
    ),
    progressControl(milestone, children, { store }),
    milestone.note ? h('p.tiny.dim', { text: milestone.note }) : null,
    detail,
  );

  return h('div.tl-item',
    h('div.tl-node', {
      dataset: { status: milestone.status },
      title: `子任务已完成 ${T.milestoneProgress(milestone, children).done}/${children.length}`,
      text: String(T.milestoneProgress(milestone, children).done),
    }),
    body,
  );
}

function subtaskRow(subtask, { store, milestone }) {
  const toggle = async () => store.update(SUBTASKS, subtask.id, { done: !subtask.done }).catch(() => {});
  const remove = () => removeRow(store, SUBTASKS, subtask, { label: subtask.title });
  const row = h('div.list-row', { class: subtask.done ? 'is-done' : '' },
    h('button.tick', {
      type: 'button', role: 'checkbox', 'aria-checked': subtask.done ? 'true' : 'false',
      'aria-label': subtask.done ? `标记未完成：${subtask.title}` : `标记完成：${subtask.title}`,
      onclick: () => toggle(),
    }, icon('check')),
    h('div.truncate', { style: { minWidth: '0' } }, h('div.title', { text: subtask.title })),
    h('div.spacer'),
    h('button.iconbtn', {
      type: 'button', 'aria-label': `编辑子任务：${subtask.title}`,
      onclick: () => subtaskForm({ store, subtask }),
    }, icon('pencil')),
    h('button.iconbtn.danger', {
      type: 'button', 'aria-label': `删除子任务：${subtask.title}`, onclick: remove,
    }, icon('trash')),
  );
  swipeDelete(row, { onDelete: remove });
  return row;
}

/** 快捷新增的半截标题要活过整页重绘：任何一次回读都会重建 DOM，让用户重打一遍太容易丢。 */
const addDrafts = new Map();

function addSubtaskRow(milestone, { store }) {
  const input = h('input', {
    type: 'text', maxlength: '120', placeholder: '再加一条可勾选的子任务',
    value: addDrafts.get(milestone.id) ?? '',
    'aria-label': `新增子任务：${milestone.title}`,
    oninput: (event) => {
      if (event.target.value) addDrafts.set(milestone.id, event.target.value);
      else addDrafts.delete(milestone.id);
    },
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      add();
    },
  });
  const add = async () => {
    const title = input.value.trim();
    if (!title) { input.focus?.(); return; }
    try {
      await store.create(SUBTASKS, { milestone_id: milestone.id, title, done: false });
      input.value = '';
      addDrafts.delete(milestone.id);
    } catch { /* 保留输入：失败原因已经由写错误条指出来 */ }
  };
  return h('div.row', { style: { gap: '8px', marginTop: '8px' } },
    input,
    h('button.iconbtn', { type: 'button', 'aria-label': `添加子任务：${milestone.title}`, onclick: () => add() }, icon('plus')),
  );
}

function timeline({ project, milestones, subtasks, store, today }) {
  let dragFrom = null;
  const move = (from, to) => commitOrder(store, T.reorder(milestones, from, to)).catch(() => {});
  const drag = {
    start: (index) => { dragFrom = index; },
    drop: (index) => { if (dragFrom !== null && dragFrom !== index) move(dragFrom, index); dragFrom = null; },
    cancel: () => { dragFrom = null; },
  };
  return h('div.timeline', {}, ...milestones.map((milestone, index) => milestoneItem(milestone, {
    index, count: milestones.length, children: childrenOf(subtasks, milestone.id), project, store, today, move, drag,
  })));
}

// ── 项目卡片与详情抬头 ────────────────────────────────────

function projectCard(project, milestones, today, { onEdit, onDelete }) {
  const list = ofProject(milestones, project.id);
  const progress = T.projectProgress(list) ?? 0;
  const nearest = T.recentMilestones(list, 1)[0] ?? null;
  const days = nearest ? T.remainingDays(nearest.target_date, today) : null;
  const done = list.filter((item) => item.status === 'done').length;
  return h('div.panel.proj-card',
    h('div.row',
      h('a.truncate', { href: `#/research/${project.id}` }, h('h3', { text: project.name })),
      h('div.spacer'),
      statusBadge(project.status),
      h('button.iconbtn', { type: 'button', 'aria-label': `编辑项目：${project.name}`, onclick: onEdit }, icon('pencil')),
      h('button.iconbtn.danger', { type: 'button', 'aria-label': `删除项目：${project.name}`, onclick: onDelete }, icon('trash')),
    ),
    project.description ? h('p.tiny.dim.truncate', { text: project.description }) : null,
    h('div.progress', { class: project.status === 'done' ? 'done' : days !== null && days < 3 ? 'warn' : '' },
      h('i', { style: { width: `${progress}%` } })),
    h('div.progress-meta',
      h('span', { text: `${list.length} 个里程碑` }),
      h('span', { text: `已完成 ${done}` }),
      h('div.spacer'),
      h('span', { text: `${progress}%` }),
      nearest
        ? h('span', {
          class: days !== null && days < 3 ? 'orange' : '',
          text: days === null ? '未定目标日' : days < 0 ? `逾期 ${-days} 天` : `最近目标 ${days} 天后`,
        })
        : h('span', { text: '全部完成' }),
    ),
  );
}

function projectHeader(project, list, { store, milestones, subtasks, ctx }) {
  const progress = T.projectProgress(list) ?? 0;
  return h('div.panel',
    h('div.row',
      h('h3.truncate', { text: '整体进度' }),
      h('div.spacer'),
      h('span.num', { text: `${progress}%` }),
    ),
    h('div.progress', { class: project.status === 'done' ? 'done' : '' },
      h('i', { style: { width: `${progress}%` } })),
    h('div.progress-meta',
      h('span', { text: `${list.length} 个里程碑` }),
      h('span', { text: `已完成 ${list.filter((item) => item.status === 'done').length}` }),
      h('div.spacer'),
      h('span', { text: `子任务 ${list.reduce((sum, item) => sum + childrenOf(subtasks, item.id).filter((child) => child.done).length, 0)} 条` }),
    ),
    project.description ? h('p.tiny.dim', { text: project.description }) : null,
    h('div.row', { style: { gap: '6px', marginTop: '6px' } },
      h('button.btn.sm', { type: 'button', text: '编辑项目', onclick: () => projectForm({ store, project }) }),
      h('button.btn.sm.danger', {
        type: 'button', text: '删除项目',
        onclick: () => deleteProject(project, {
          store, milestones, subtasks, after: () => ctx.navigate('#/research'),
        }).catch(() => {}),
      }),
    ),
  );
}

// ── 路由入口 ──────────────────────────────────────────────

export function renderResearch({ state, ctx, time, sub }) {
  const store = ctx.store;
  const projects = T.sortRows(state.tables.research_projects);
  const milestones = state.tables.milestones;
  const subtasks = state.tables.subtasks;
  const today = time.today;

  if (sub) {
    const project = projects.find((item) => item.id === sub);
    if (!project) {
      return h('div.panel', emptyState({
        glyph: 'research', title: '这个项目已不存在', hint: '可能在另一台设备上被删除',
        cta: '返回项目列表', onCta: () => ctx.navigate('#/research'),
      }));
    }
    const list = ofProject(milestones, project.id);
    return h('div.stack',
      h('div.panel.tight',
        h('a.btn.sm.ghost', { href: '#/research' }, icon('chevLeft'), '项目列表'),
        h('div.spacer'),
        h('h3.truncate', { text: project.name }),
        statusBadge(project.status),
      ),
      projectHeader(project, list, { store, milestones, subtasks, ctx }),
      list.length
        ? h('div.panel', timeline({ project, milestones: list, subtasks, store, today }))
        : h('div.panel', emptyState({
          glyph: 'research', title: '还没有里程碑',
          hint: '把项目拆成可验收的阶段，进度会按子任务的完成比例自动累加',
          cta: '建立第一个里程碑', onCta: () => milestoneForm({ store, project }),
        })),
      h('div.row', h('div.spacer'), h('button.btn.primary', {
        type: 'button', text: '新增里程碑', onclick: () => milestoneForm({ store, project }),
      })),
    );
  }

  const toolbar = h('div.row',
    h('span.eyebrow', { text: 'PROJECTS' }),
    h('div.spacer'),
    h('button.btn.primary', { type: 'button', text: '新增项目', onclick: () => projectForm({ store }) }),
  );
  if (!projects.length) {
    return h('div.stack', toolbar, h('div.panel', emptyState({
      glyph: 'research', title: '还没有科研项目', hint: '建项目 → 拆里程碑 → 勾子任务，进度会自动累计',
      cta: '建立第一个项目', onCta: () => projectForm({ store }),
    })));
  }
  return h('div.stack', toolbar,
    h('div.grid.cols-2', {}, ...projects.map((project) => projectCard(
      project, milestones, today,
      {
        onEdit: () => projectForm({ store, project }),
        onDelete: () => deleteProject(project, { store, milestones, subtasks, ctx }).catch(() => {}),
      },
    ))));
}

renderResearch.onNew = ({ ctx }) => projectForm({ store: ctx.store });
