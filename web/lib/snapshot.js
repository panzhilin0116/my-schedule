// 全量快照的导出格式与导入自检。写云端一律走 Function 的 import 动作，
// 这里只负责"文件里是什么、能不能导入、导入会造成什么"，不碰网络。
import { TABLE_NAMES, TABLES, validateRow, PARENT_REFS } from './registry.mjs';

export const SNAPSHOT_KIND = 'my-schedule-snapshot';
export const SNAPSHOT_VERSION = 1;

export const TABLE_LABELS = {
  semester_config: '学期配置',
  courses: '课程',
  tasks: '日程',
  research_projects: '科研项目',
  milestones: '里程碑',
  subtasks: '子任务',
  workouts: '健身记录',
};

export const tableLabel = (name) => TABLE_LABELS[name] ?? name;

/** 快照就是七张表的完整副本（含 id 与时间戳），这样导入才能原样还原。 */
export function buildSnapshot(tables, { exportedAt = new Date().toISOString() } = {}) {
  return {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    exportedAt,
    counts: Object.fromEntries(TABLE_NAMES.map((name) => [name, (tables[name] ?? []).length])),
    tables: Object.fromEntries(TABLE_NAMES.map((name) => [name, (tables[name] ?? []).map((row) => ({ ...row }))])),
  };
}

export function snapshotText(tables, options) {
  return `${JSON.stringify(buildSnapshot(tables, options), null, 2)}\n`;
}

export const snapshotFilename = (today) => `日程任务舱-备份-${today}.json`;

export function downloadJson(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导入前的自检，与 Function 侧 import 的判据一致：
 * 七表结构、逐字段校验、父子引用必须全部通过，任何一条问题都不写入。
 */
export function parseSnapshot(text) {
  const reject = (message) => ({ ok: false, problems: [message], truncated: false, counts: {}, tables: null, total: 0 });
  let payload;
  try {
    payload = JSON.parse(String(text));
  } catch {
    return reject('文件不是合法的 JSON，请选择本应用导出的 .json 备份');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reject('文件内容格式不符合备份格式');
  const raw = payload.tables && typeof payload.tables === 'object' ? payload.tables : payload;
  const problems = [];
  if (payload.kind && payload.kind !== SNAPSHOT_KIND) problems.push('这个文件的来源与本应用导出的备份不一致');
  const unknown = Object.keys(raw).filter((name) => !TABLE_NAMES.includes(name));
  if (unknown.length) problems.push(`未知的数据表：${unknown.map(tableLabel).join('、')}`);

  const tables = {};
  const counts = {};
  for (const name of TABLE_NAMES) {
    const rows = raw[name] ?? [];
    if (!Array.isArray(rows)) {
      problems.push(`${tableLabel(name)}：内容必须是列表`);
      tables[name] = [];
      counts[name] = 0;
      continue;
    }
    const columns = Object.keys(TABLES[name].columns);
    const accepted = [];
    for (const [index, input] of rows.entries()) {
      const prefix = `${tableLabel(name)} 第 ${index + 1} 条`;
      const missing = columns.filter((column) => !Object.prototype.hasOwnProperty.call(input ?? {}, column));
      if (missing.length) {
        problems.push(`${prefix} 缺少字段 ${missing[0]}`);
        continue;
      }
      const result = validateRow(name, input, { allowServer: true });
      if (!result.ok) {
        problems.push(`${prefix}：${result.error}`);
        continue;
      }
      accepted.push(result.row);
    }
    tables[name] = accepted;
    counts[name] = accepted.length;
  }

  for (const [name, ref] of Object.entries(PARENT_REFS)) {
    const parentIds = new Set(tables[ref.table].map((row) => row.id));
    const dangling = tables[name].filter((row) => !parentIds.has(row[ref.column]));
    if (dangling.length) problems.push(`${tableLabel(name)}：${dangling.length} 条的${ref.label}不在这份备份里`);
  }
  const total = TABLE_NAMES.reduce((sum, name) => sum + counts[name], 0);
  if (!total) problems.push('这份备份里没有任何记录，导入等于清空');

  return {
    ok: problems.length === 0,
    problems: problems.slice(0, 10),
    truncated: problems.length > 10,
    counts,
    tables,
    total,
  };
}
