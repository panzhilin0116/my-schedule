// 表结构唯一来源：列白名单 + 逐字段校验。前端表单不得出现这里没有的字段。
// 与 schema/v1.sql 一一对应，由 dev/tests/s1.test.mjs 强制比对。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

const kinds = {
  uuid: { sql: 'uuid' },
  text: { sql: 'text' },
  int: { sql: 'integer' },
  bool: { sql: 'boolean' },
  date: { sql: 'text' },          // YYYY-MM-DD
  hhmm: { sql: 'text' },          // HH:MM
  timestamptz: { sql: 'timestamptz' },
  stringList: { sql: 'jsonb' },   // string[]
  periods: { sql: 'jsonb' },      // {label,start,end,kind}[]
};

const PERIOD_KINDS = ['class', 'break'];

function checkString(value, col, field) {
  if (typeof value !== 'string') return `${field} 必须是文本`;
  const trimmed = value.trim();
  if (!trimmed) return `${field} 不能为空`;
  if (trimmed.length > col.max) return `${field} 最长 ${col.max} 个字符`;
  return null;
}

const VALIDATORS = {
  text(value, col, field) {
    const error = checkString(value, col, field);
    if (error) return error;
    if (col.enum && !col.enum.includes(value.trim())) return `${field} 取值不合法`;
    if (col.pattern && !col.pattern.test(value.trim())) return `${field} 格式不合法`;
    return null;
  },
  uuid(value, _col, field) {
    return typeof value === 'string' && UUID_RE.test(value) ? null : `${field} 必须是合法 ID`;
  },
  int(value, col, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return `${field} 必须是整数`;
    if (value < col.min || value > col.max) return `${field} 需在 ${col.min}–${col.max} 之间`;
    return null;
  },
  bool(value, _col, field) {
    return typeof value === 'boolean' ? null : `${field} 必须是布尔值`;
  },
  date(value, _col, field) {
    if (!DATE_RE.test(String(value))) return `${field} 需为 YYYY-MM-DD`;
    const [y, m, d] = String(value).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
      ? null : `${field} 不是有效日期`;
  },
  hhmm(value, _col, field) {
    return HHMM_RE.test(String(value)) ? null : `${field} 需为 HH:MM`;
  },
  timestamptz(value, _col, field) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `${field} 时间格式不合法`;
  },
  stringList(value, col, field) {
    if (!Array.isArray(value)) return `${field} 必须是列表`;
    if (value.length > col.maxItems) return `${field} 最多 ${col.maxItems} 项`;
    for (const item of value) {
      if (typeof item !== 'string') return `${field} 只能包含文本`;
      if (!item.trim() || item.length > col.maxItemLength) return `${field} 文本项为空或过长`;
    }
    return null;
  },
  periods(value, col, field) {
    if (!Array.isArray(value)) return `${field} 必须是列表`;
    if (value.length > col.maxItems) return `${field} 最多 ${col.maxItems} 项`;
    let prevEnd = null;
    for (const [i, item] of value.entries()) {
      if (!item || typeof item !== 'object') return `第 ${i + 1} 节格式不合法`;
      const kind = item.kind ?? 'class';
      if (!PERIOD_KINDS.includes(kind)) return `第 ${i + 1} 节类型不合法`;
      if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 20) return `第 ${i + 1} 节名称不合法`;
      if (!HHMM_RE.test(String(item.start)) || !HHMM_RE.test(String(item.end))) return `第 ${i + 1} 节时间需为 HH:MM`;
      const start = toMinutes(item.start), end = toMinutes(item.end);
      if (end <= start) return `第 ${i + 1} 节结束时间需晚于开始时间`;
      // 与"到目前为止结束最晚的那一节"比：只比相邻一行会漏掉长节课盖住后面几节的情况
      if (prevEnd !== null && start < prevEnd) return `第 ${i + 1} 节与上一节时间重叠`;
      prevEnd = prevEnd === null ? end : Math.max(prevEnd, end);
    }
    return null;
  },
};

export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export const TABLES = {
  semester_config: {
    singleton: true,
    orderBy: ['updated_at', 'desc'],
    columns: {
      id: { kind: 'uuid', server: true, label: '记录标识' },
      start_date: { kind: 'date', required: true, label: '学期起始日' },
      total_weeks: { kind: 'int', required: true, min: 1, max: 60, label: '总周数' },
      periods: { kind: 'periods', required: true, maxItems: 24, label: '节次时间表' },
      updated_at: { kind: 'timestamptz', server: true, label: '更新时间' },
    },
  },
  courses: {
    orderBy: ['day_of_week', 'asc'],
    columns: {
      id: { kind: 'uuid', server: true, label: '记录标识' },
      name: { kind: 'text', required: true, max: 40, label: '课程名称' },
      teacher: { kind: 'text', max: 30, label: '教师' },
      location: { kind: 'text', max: 40, label: '上课地点' },
      day_of_week: { kind: 'int', required: true, min: 1, max: 7, label: '星期' },
      start_time: { kind: 'hhmm', required: true, label: '开始时间' },
      end_time: { kind: 'hhmm', required: true, label: '结束时间' },
      week_type: { kind: 'text', required: true, enum: ['all', 'odd', 'even'], label: '周型' },
      start_week: { kind: 'int', required: true, min: 1, max: 60, label: '起始周' },
      end_week: { kind: 'int', required: true, min: 1, max: 60, label: '结束周' },
      color: { kind: 'text', pattern: HEX_RE, max: 7, label: '颜色' },
      note: { kind: 'text', max: 300, label: '备注' },
      sort: { kind: 'int', min: 0, max: 9999, label: '排序' },
      created_at: { kind: 'timestamptz', server: true, label: '创建时间' },
      updated_at: { kind: 'timestamptz', server: true, label: '更新时间' },
    },
    // 行级跨字段规则，key 为参与字段
    crossChecks: [{ fields: ['start_time', 'end_time'], message: '结束时间需晚于开始时间',
      test: (row) => toMinutes(row.end_time) > toMinutes(row.start_time) },
      { fields: ['start_week', 'end_week'], message: '结束周需不早于起始周',
        test: (row) => row.end_week >= row.start_week }],
  },
  tasks: {
    orderBy: ['due_date', 'asc'],
    columns: {
      id: { kind: 'uuid', server: true, label: '记录标识' },
      title: { kind: 'text', required: true, max: 80, label: '标题' },
      due_date: { kind: 'date', label: '截止日期' },
      due_time: { kind: 'hhmm', label: '截止时间' },
      duration_min: { kind: 'int', min: 0, max: 1440, label: '预计时长(分钟)' },
      category: { kind: 'text', enum: ['作业', '科研', '生活', '其它'], max: 10, label: '分类' },
      note: { kind: 'text', max: 500, label: '备注' },
      done: { kind: 'bool', required: true, label: '完成状态' },
      done_at: { kind: 'timestamptz', label: '完成时间' },
      created_at: { kind: 'timestamptz', server: true, label: '创建时间' },
      updated_at: { kind: 'timestamptz', server: true, label: '更新时间' },
    },
    maxRows: 5000,
  },
  research_projects: {
    orderBy: ['sort', 'asc'],
    columns: {
      id: { kind: 'uuid', server: true, label: '记录标识' },
      name: { kind: 'text', required: true, max: 60, label: '项目名称' },
      description: { kind: 'text', max: 1000, label: '说明' },
      status: { kind: 'text', required: true, enum: ['not_started', 'active', 'blocked', 'done'], label: '状态' },
      sort: { kind: 'int', min: 0, max: 9999, label: '排序' },
      created_at: { kind: 'timestamptz', server: true, label: '创建时间' },
      updated_at: { kind: 'timestamptz', server: true, label: '更新时间' },
    },
  },
  milestones: {
    orderBy: ['sort', 'asc'],
    columns: {
      id: { kind: 'uuid', server: true, label: '记录标识' },
      project_id: { kind: 'uuid', required: true, label: '所属项目' },
      title: { kind: 'text', required: true, max: 80, label: '里程碑' },
      note: { kind: 'text', max: 1000, label: '备注' },
      target_date: { kind: 'date', label: '目标日期' },
      status: { kind: 'text', required: true, enum: ['not_started', 'active', 'blocked', 'done'], label: '状态' },
      progress: { kind: 'int', required: true, min: 0, max: 100, label: '进度' },
      manual_progress: { kind: 'bool', required: true, label: '进度为手动设定' },
      sort: { kind: 'int', min: 0, max: 9999, label: '排序' },
      created_at: { kind: 'timestamptz', server: true, label: '创建时间' },
      updated_at: { kind: 'timestamptz', server: true, label: '更新时间' },
    },
  },
  subtasks: {
    orderBy: ['sort', 'asc'],
    columns: {
      id: { kind: 'uuid', server: true, label: '记录标识' },
      milestone_id: { kind: 'uuid', required: true, label: '所属里程碑' },
      title: { kind: 'text', required: true, max: 120, label: '子任务' },
      done: { kind: 'bool', required: true, label: '完成状态' },
      sort: { kind: 'int', min: 0, max: 9999, label: '排序' },
      created_at: { kind: 'timestamptz', server: true, label: '创建时间' },
      updated_at: { kind: 'timestamptz', server: true, label: '更新时间' },
    },
  },
  workouts: {
    orderBy: ['workout_date', 'desc'],
    columns: {
      id: { kind: 'uuid', server: true, label: '记录标识' },
      workout_date: { kind: 'date', required: true, label: '日期' },
      type: { kind: 'text', required: true, max: 20, label: '运动类型' },
      duration_min: { kind: 'int', required: true, min: 0, max: 600, label: '时长(分钟)' },
      status: { kind: 'text', required: true, enum: ['done', 'partial', 'missed'], label: '完成度' },
      note: { kind: 'text', max: 300, label: '备注' },
      created_at: { kind: 'timestamptz', server: true, label: '创建时间' },
      updated_at: { kind: 'timestamptz', server: true, label: '更新时间' },
    },
    // 「缺练」是时间线上的占位，不是一笔训练：带着时长入库，总时长和分组时长就会各算各的
    crossChecks: [{ fields: ['status', 'duration_min'], message: '缺练不计时长，请把时长改成 0',
      test: (row) => row.status !== 'missed' || Number(row.duration_min) === 0 }],
    maxRows: 5000,
  },
};

export const TABLE_NAMES = Object.keys(TABLES);

/**
 * 表间父子关系：平台受限 DDL 建不了外键，所以级联与父子存在性都按这份声明来做，
 * 服务端（rules.mjs）与导入前的快照自检共用同一个来源。
 */
export const PARENT_REFS = {
  milestones: { column: 'project_id', table: 'research_projects', label: '所属项目' },
  subtasks: { column: 'milestone_id', table: 'milestones', label: '所属里程碑' },
};
const IDENTIFIER = /^[a-z_]{1,40}$/;

export function editableColumns(table) {
  return Object.entries(TABLES[table].columns)
    .filter(([, col]) => !col.server)
    .map(([name]) => name);
}

export function selectColumns(table) {
  return Object.keys(TABLES[table].columns).join(',');
}

function normalizeValue(value, col) {
  if (col.kind === 'text') return value.trim();
  if (col.kind === 'date' || col.kind === 'hhmm') return String(value);
  return value;
}

/**
 * 校验一行。partial=true 时用于 update：只校验出现的字段，未出现的保持原值。
 * allowServer=true 只供导入恢复使用，让服务端专属列（id/时间戳）参与校验。
 * 返回 { ok, row, error, field }；row 只含白名单内的列。
 */
export function validateRow(table, input, { partial = false, existing = null, allowServer = false } = {}) {
  const spec = TABLES[table];
  if (!spec) return { ok: false, error: 'unknown_table', field: 'table' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '请求内容必须是对象' };
  }
  const unknown = Object.keys(input).filter((key) => !spec.columns[key] || (spec.columns[key].server && !allowServer));
  if (unknown.length) return { ok: false, error: `不支持的字段：${unknown[0]}`, field: unknown[0] };

  const base = partial && existing ? existing : {};
  const row = {};
  for (const [field, col] of Object.entries(spec.columns)) {
    if (col.server && !allowServer) continue;
    const provided = Object.prototype.hasOwnProperty.call(input, field);
    if (!provided) {
      if (partial) continue;
      if (col.required) return { ok: false, error: `${col.label} 必填`, field };
      continue;
    }
    const value = input[field];
    if (value === null || value === '') {
      if (col.required) return { ok: false, error: `${col.label} 必填`, field };
      row[field] = null;
      continue;
    }
    const error = VALIDATORS[col.kind](value, col, col.label);
    if (error) return { ok: false, error, field };
    row[field] = normalizeValue(value, col);
  }

  if (partial && existing) {
    for (const [field, col] of Object.entries(spec.columns)) {
      if (col.server || col.kind === 'timestamptz') continue;
      if (!(field in row) && col.required && !(field in existing)) {
        return { ok: false, error: `${col.label} 必填`, field };
      }
    }
  }

  const merged = { ...base, ...row };
  for (const check of spec.crossChecks ?? []) {
    const values = check.fields.map((field) => merged[field]);
    if (values.some((value) => value === null || value === undefined)) continue;
    if (!check.test(merged)) {
      return { ok: false, error: check.message, field: check.fields[check.fields.length - 1] };
    }
  }
  return { ok: true, row };
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isValidIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export { DATE_RE, HHMM_RE, HEX_RE, PERIOD_KINDS };
