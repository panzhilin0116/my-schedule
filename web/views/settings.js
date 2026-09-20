// 设置页：学期基准与节次表（周次与课表纵轴的唯一来源）+ 数据进出口。
// 节次的合法性以 Function 侧 periods 校验为同一口径（结束晚于开始、彼此不重叠），
// 这里只是提前到字段上提示，服务端仍是最终裁判。
import { h, icon, mount } from '../lib/dom.js';
import * as T from '../lib/time.js';
import { emptyState, openLayer, panelHead, toast, confirmDialog } from '../lib/ui.js';
import { TABLE_NAMES } from '../lib/registry.mjs';
import { snapshotText, snapshotFilename, downloadJson, parseSnapshot, tableLabel } from '../lib/snapshot.js';

/** 国内高校常见节次模板：首次初始化用它，5 秒内可完成（PRD M3）。 */
export const DEFAULT_PERIODS = [
  { label: '第 1 节', start: '08:00', end: '08:45', kind: 'class' },
  { label: '第 2 节', start: '08:55', end: '09:40', kind: 'class' },
  { label: '第 3 节', start: '10:00', end: '10:45', kind: 'class' },
  { label: '第 4 节', start: '10:55', end: '11:40', kind: 'class' },
  { label: '午休', start: '12:00', end: '14:00', kind: 'break' },
  { label: '第 5 节', start: '14:00', end: '14:45', kind: 'class' },
  { label: '第 6 节', start: '14:55', end: '15:40', kind: 'class' },
  { label: '第 7 节', start: '16:00', end: '16:45', kind: 'class' },
  { label: '第 8 节', start: '16:55', end: '17:40', kind: 'class' },
  { label: '晚自习', start: '19:00', end: '20:40', kind: 'class' },
];

const KIND_OPTIONS = [
  { value: 'class', label: '上课' },
  { value: 'break', label: '休息' },
];

const spanText = (period) => `${period.start}–${period.end}${period.kind === 'break' ? '（休息）' : ''}`;

function impactPanel(title) {
  const lines = h('div.impact-lines');
  const box = h('div.impact', h('div.k', { text: title }), lines);
  box.paint = (items, empty) => {
    mount(lines, ...(items.length
      ? items.map((item) => h('div.impact-line', { text: item }))
      : [h('div.impact-line.faint', { text: empty })]));
  };
  return box;
}

async function savePeriods(store, config, next) {
  await store.update('semester_config', config.id, { periods: T.sortPeriods(next) });
}

/** 起始日 / 总周数：草稿一变就重算"今天是第几周"。 */
function semesterForm({ store, state, time }) {
  const config = state.config;
  const readout = impactPanel('按此设置');
  const paint = (draft) => {
    const week = T.weekOf(time.today, { start_date: draft.start_date, total_weeks: draft.total_weeks });
    readout.paint(
      week ? [`今天是第 ${week} 周 / 共 ${draft.total_weeks} 周 · ${T.parityOfWeek(week) === 'odd' ? '单周' : '双周'}`] : [],
      '今天不在该学期范围内（假期或学期外）',
    );
  };
  const handle = openLayer({
    title: config ? '编辑学期基准' : '初始化学期基准',
    eyebrow: 'SEMESTER',
    fields: [
      { name: 'start_date', label: '起始日（第一周周一）', type: 'date', rules: { required: true }, hint: '课表与周次都按这一天起算' },
      { name: 'total_weeks', label: '总周数', type: 'number', rules: { required: true, between: [1, 60] } },
    ],
    values: { start_date: config?.start_date ?? T.mondayOf(time.today), total_weeks: config?.total_weeks ?? 18 },
    submitLabel: config ? '保存学期基准' : '保存并开始',
    extra: [readout],
    onDraft: paint,
    onSubmit: async (draft) => {
      const patch = { start_date: draft.start_date, total_weeks: Number(draft.total_weeks) };
      if (config) await store.update('semester_config', config.id, patch);
      else await store.create('semester_config', { ...patch, periods: DEFAULT_PERIODS });
      toast(config ? '学期基准已更新，周次已重算' : '学期基准已建立，节次表用了常见模板', { kind: 'ok' });
    },
  });
  paint(handle.draft());
}

/** 单节编辑（新增/修改）：其余各行作为不可动的邻居参与重叠校验。 */
function periodForm({ store, state, time }, index) {
  const config = state.config;
  const periods = config.periods ?? [];
  const editing = index >= 0 ? periods[index] : null;
  const others = periods.filter((_, position) => position !== index);
  const last = periods.at(-1);
  const blank = {
    label: `第 ${periods.filter((period) => period.kind !== 'break').length + 1} 节`,
    start: last ? T.min2hm(Math.min(1439, T.hm2min(last.end) + 10)) : '08:00',
    end: last ? T.min2hm(Math.min(1439, T.hm2min(last.end) + 55)) : '08:45',
    kind: 'class',
  };
  const impact = impactPanel(editing ? '这一改动会影响' : '新增这一节会牵动');
  const candidate = (draft) => [...others, {
    label: String(draft.label ?? '').trim(),
    start: draft.start,
    end: draft.end,
    kind: draft.kind ?? 'class',
  }];
  const errorFor = (field) => (value, draft) => T.periodErrors(candidate(draft))[`${others.length}.${field}`] ?? null;
  const paint = (draft) => {
    const result = T.periodImpact(periods, candidate(draft), state.tables.courses);
    impact.paint(result.lines.map((line) => line.text), '节次表没有实质变化');
  };
  const handle = openLayer({
    title: editing ? `编辑「${editing.label}」` : '新增一节',
    eyebrow: 'PERIOD',
    fields: [
      { name: 'label', label: '名称', type: 'text', rules: { required: true, max: 20 }, validate: errorFor('label') },
      { name: 'start', label: '开始时间', type: 'time', rules: { required: true }, validate: errorFor('start') },
      { name: 'end', label: '结束时间', type: 'time', rules: { required: true }, validate: errorFor('end') },
      {
        name: 'kind', label: '类型', type: 'select', options: KIND_OPTIONS, rules: { required: true },
        hint: '休息段只占坐标轴，不算课',
      },
    ],
    values: editing ?? blank,
    submitLabel: '保存节次表',
    extra: [impact],
    onDraft: paint,
    onSubmit: async (draft) => {
      const next = candidate(draft);
      const result = T.periodImpact(periods, next, state.tables.courses);
      await savePeriods(store, config, next);
      toast(result.changed ? `节次表已保存，课表纵轴同步为 ${next.length} 行` : '节次表已保存', { kind: 'ok' });
    },
  });
  paint(handle.draft());
  return handle;
}

async function removePeriod({ store, state }, index) {
  const config = state.config;
  const periods = config.periods ?? [];
  const target = periods[index];
  const next = periods.filter((_, position) => position !== index);
  const result = T.periodImpact(periods, next, state.tables.courses);
  const confirmed = await confirmDialog({
    title: `删除「${target.label}」`,
    message: `${spanText(target)} 将从节次表移除，课表纵轴少一行。`,
    detail: result.affected.length ? `受影响：${result.affected.join('、')}` : '当前没有课程落在这节时间里。',
    confirmLabel: '删除这一节',
    cancelLabel: '返回',
  });
  if (!confirmed) return;
  await savePeriods(store, config, next);
  toast(`已删除「${target.label}」`, { kind: 'ok' });
}

function periodRow(period, helpers, index) {
  return h('div.list-row',
    h('span.t', { text: `第 ${index + 1} 行` }),
    h('div.truncate', h('div.title', { text: period.label })),
    h('div.spacer'),
    h('span.num.dim', { text: spanText(period) }),
    period.kind === 'break' ? h('span.badge.grey', { text: '休息' }) : null,
    h('button.iconbtn', { type: 'button', 'aria-label': `编辑 ${period.label}`, onclick: () => periodForm(helpers, index) }, icon('pencil')),
    h('button.iconbtn.danger', { type: 'button', 'aria-label': `删除 ${period.label}`, onclick: () => removePeriod(helpers, index).catch(() => {}) }, icon('trash')),
  );
}

function semesterPanel(helpers) {
  const { state, time } = helpers;
  const config = state.config;
  const week = T.weekOf(time.today, config);
  if (!config) {
    return h('div.panel',
      panelHead({ eyebrow: 'SEMESTER', title: '学期基准' }),
      emptyState({
        glyph: 'settings',
        title: '还没有学期基准',
        hint: '设置起始日与节次表后，周次与课表坐标轴才会生效',
        cta: '初始化学期',
        onCta: () => semesterForm(helpers),
      }),
    );
  }
  return h('div.panel',
    panelHead({
      eyebrow: 'SEMESTER', title: '学期基准',
      actions: [
        h('button.btn.sm', { type: 'button', text: '编辑学期', onclick: () => semesterForm(helpers) }),
        h('button.btn.sm', { type: 'button', text: '新增一节', onclick: () => periodForm(helpers, -1) }),
      ],
    }),
    h('div.readout-grid',
      h('div.readout-cell', h('div.k', { text: '起始日' }), h('div.v', { text: config.start_date })),
      h('div.readout-cell', h('div.k', { text: '总周数' }), h('div.v', { text: String(config.total_weeks) })),
      h('div.readout-cell', h('div.k', { text: '当前周次' }), h('div.v', { text: week ? `第 ${week} 周` : '假期' })),
      h('div.readout-cell', h('div.k', { text: '节次数' }), h('div.v', { text: String((config.periods ?? []).length) })),
    ),
    (config.periods ?? []).length
      ? h('div.card-list', {}, ...(config.periods ?? []).map((period, index) => periodRow(period, helpers, index)))
      : h('p.tiny.faint', { text: '还没有节次表，课表纵轴会空白，先新增一节。' }),
  );
}

async function importFile(helpers, file) {
  if (!file) return;
  const report = parseSnapshot(await file.text());
  const counts = TABLE_NAMES.filter((name) => report.counts?.[name]).map((name) => `${tableLabel(name)} ${report.counts[name]} 条`);
  const summary = impactPanel(report.ok ? '将写入云端' : '这份文件不能导入');
  summary.paint(
    report.ok ? [`共 ${report.total} 条记录：${counts.join('、')}`, '导入会先清空云端现有的 7 类记录，再按备份原样还原']
      : [...report.problems, report.truncated ? '……另有更多问题未列出' : null].filter(Boolean),
    '文件里没有可导入的记录',
  );
  openLayer({
    title: report.ok ? '确认导入备份' : '导入被拦住',
    eyebrow: 'IMPORT',
    fields: [],
    submitLabel: report.ok ? '清空并导入' : '返回',
    extra: [summary],
    onSubmit: async () => {
      if (!report.ok) return;
      await helpers.store.importSnapshot(report.tables);
      toast('备份已导入，数据已还原', { kind: 'ok' });
    },
  });
}

function dataPanel(helpers) {
  const { state, time } = helpers;
  const picker = h('input', {
    type: 'file', accept: '.json,application/json', class: 'file-picker',
    onchange: (event) => importFile(helpers, event.target.files?.[0]).catch(() => toast('读取文件失败，请换一个文件试试', { kind: 'error' })),
  });
  return h('div.panel',
    panelHead({ eyebrow: 'BACKUP', title: '数据进出口' }),
    h('div.row.wrap',
      h('button.btn', {
        type: 'button', text: '导出全量备份',
        onclick: () => {
          downloadJson(snapshotFilename(time.today), snapshotText(state.tables, { exportedAt: new Date().toISOString() }));
          toast('备份文件已开始下载', { kind: 'ok' });
        },
      }),
      h('label.btn', { text: '导入备份' }, picker),
      h('button.btn.danger', {
        type: 'button', text: '清空全部数据',
        onclick: () => wipeAll(helpers).catch(() => {}),
      }),
    ),
    h('p.tiny.faint', { text: '备份是七张表的完整副本（含记录标识）；导入以备份内容整体替换云端数据。' }),
  );
}

async function wipeAll({ store }) {
  const confirmed = await confirmDialog({
    title: '清空全部数据',
    message: '课程、日程、科研、健身与学期基准都会从云端删除，无法恢复。',
    detail: '需要输入 DELETE 才能确认。',
    confirmLabel: '确认清空',
    cancelLabel: '返回',
    requireText: 'DELETE',
  });
  if (!confirmed) return;
  await store.wipeAll();
  toast('已清空全部数据', { kind: 'ok' });
}

function dataOverview({ state }) {
  return h('div.panel',
    panelHead({ eyebrow: 'DATA', title: '云端数据概况' }),
    h('div.readout-grid', {}, ...TABLE_NAMES.map((table) => h('div.readout-cell',
      h('div.k', { text: tableLabel(table) }),
      h('div.v', { text: String(state.tables[table].length) }),
      state.limits[table] ? h('div.k', { text: `上限 ${state.limits[table]}` }) : null,
    ))),
    h('p.tiny.faint', { text: state.loadedAt ? `最近同步 ${state.loadedAt}` : '尚未同步' }),
  );
}

export function renderSettings({ state, ctx, time }) {
  const helpers = { state, ctx, time, store: ctx?.store, tables: state.tables };
  return h('div.stack',
    semesterPanel(helpers),
    dataPanel(helpers),
    dataOverview({ state }),
  );
}
