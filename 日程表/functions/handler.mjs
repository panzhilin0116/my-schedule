// 应用后端：动作路由、方法/请求体校验、字段白名单校验、级联规则。
// 数据库原始错误一律不外传，只回固定应用码；中文可读文案来自 registry 的字段标签。
import { TABLES, TABLE_NAMES, validateRow, isUuid } from './registry.mjs';
import {
  readAll, countRows, deleteWithCascade, rowExists,
  syncMilestoneProgress, nextSort, assertParentExists, assertSnapshotRefs, wipeTable,
} from './rules.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_ROWS = 5000;
const HEADERS = { 'cache-control': 'no-store' };

const ok = (data) => Response.json({ ok: true, ...data }, { status: 200, headers: HEADERS });
const fail = (status, payload) => Response.json({ ok: false, ...payload }, { status, headers: HEADERS });

class ApplicationError extends Error {
  constructor(code, { field, message, status = 400 } = {}) {
    super(code);
    Object.assign(this, { code, field, message, status });
  }
}

function requireTable(value) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(TABLES, value)) {
    throw new ApplicationError('invalid_table', { message: '未知的数据表' });
  }
  return value;
}

function requireId(value, field = 'id') {
  if (!isUuid(value)) throw new ApplicationError('invalid_id', { field, message: '记录 ID 不合法' });
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationError('invalid_input', { message: `${label}必须是对象` });
  }
  return value;
}

async function readJson(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) {
    throw new ApplicationError('unsupported_media_type', { status: 415, message: '请求需使用 application/json' });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    throw new ApplicationError('too_large', { status: 413, message: '请求内容过大' });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApplicationError('too_large', { status: 413, message: '请求内容过大' });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApplicationError('invalid_json', { message: '请求内容不是合法 JSON' });
  }
}

function validated(table, input, options) {
  const result = validateRow(table, input, options);
  if (!result.ok) {
    const label = TABLES[table].columns[result.field]?.label ?? result.field;
    throw new ApplicationError('invalid_input', { field: result.field, message: result.error ?? `${label}不合法` });
  }
  return result.row;
}

async function notFoundOnNull(promise, message = '记录不存在或已被删除') {
  const result = await promise;
  if (result.error) throw new ApplicationError('database_request_failed', { status: 503, message: '数据服务暂不可用，请稍后重试' });
  if (result.data === null || result.data === undefined) throw new ApplicationError('not_found', { status: 404, message });
  return result.data;
}

async function ensureCapacity(supabase, table) {
  const max = TABLES[table].maxRows ?? DEFAULT_MAX_ROWS;
  const total = await countRows(supabase, table);
  if (total >= max) {
    throw new ApplicationError('table_full', { status: 409, message: `该列表已达 ${max} 条上限，请先清理` });
  }
}

const ACTIONS = {
  bootstrap: {
    methods: ['GET'],
    async handler({ supabase }) {
      const tables = {};
      for (const table of TABLE_NAMES) tables[table] = await readAll(supabase, table);
      return ok({
        data: {
          tables,
          config: tables.semester_config[0] ?? null,
          limits: Object.fromEntries(TABLE_NAMES.map((table) => [table, TABLES[table].maxRows ?? DEFAULT_MAX_ROWS])),
        },
        serverTime: new Date().toISOString(),
      });
    },
  },

  create: {
    methods: ['POST'],
    async handler({ supabase, body }) {
      const table = requireTable(body.table);
      const row = validated(table, requireObject(body.row, '记录内容'));
      await ensureCapacity(supabase, table);
      await assertParentExists(supabase, table, row);
      const now = new Date().toISOString();
      const record = { ...row, id: crypto.randomUUID(), created_at: now, updated_at: now };
      if (TABLES[table].columns.sort && record.sort === undefined) record.sort = await nextSort(supabase, table) ?? 0;
      const created = await notFoundOnNull(
        supabase.from(table).insert(record).select(Object.keys(TABLES[table].columns).join(',')).single(),
        '写入未生效',
      );
      if (table === 'subtasks') await syncMilestoneProgress(supabase, record.milestone_id);
      return ok({ row: created });
    },
  },

  update: {
    methods: ['POST'],
    async handler({ supabase, body }) {
      const table = requireTable(body.table);
      const id = requireId(body.id);
      const input = requireObject(body.patch, '改动内容');
      if (Object.keys(input).length === 0) {
        throw new ApplicationError('invalid_input', { message: '没有需要保存的改动' });
      }
      const columns = Object.keys(TABLES[table].columns).join(',');
      const existing = await notFoundOnNull(supabase.from(table).select(columns).eq('id', id).maybeSingle());
      const patch = validated(table, input, { partial: true, existing });
      const updated = await notFoundOnNull(
        supabase.from(table).update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', id).select(columns).maybeSingle(),
      );
      if (table === 'subtasks') {
        await syncMilestoneProgress(supabase, existing.milestone_id);
      } else if (table === 'milestones') {
        // 手动锁定时内部会跳过覆盖；解除锁定的同一次请求即可回到自动值
        await syncMilestoneProgress(supabase, id);
      }
      return ok({ row: updated });
    },
  },

  remove: {
    methods: ['POST'],
    async handler({ supabase, body }) {
      const table = requireTable(body.table);
      const id = requireId(body.id);
      if (!(await rowExists(supabase, table, id))) {
        throw new ApplicationError('not_found', { status: 404, message: '记录不存在或已被删除' });
      }
      const { deleted } = await deleteWithCascade(supabase, table, id);
      if (!deleted[table]) throw new ApplicationError('not_found', { status: 404, message: '记录不存在或已被删除' });
      return ok({ id, deleted });
    },
  },

  import: {
    methods: ['POST'],
    async handler({ supabase, body }) {
      const snapshot = requireObject(body.tables, '导入内容');
      const unknown = Object.keys(snapshot).filter((table) => !TABLE_NAMES.includes(table));
      if (unknown.length) throw new ApplicationError('invalid_table', { message: `未知的数据表：${unknown[0]}` });
      const prepared = {};
      for (const table of TABLE_NAMES) {
        const rows = snapshot[table] ?? [];
        if (!Array.isArray(rows)) throw new ApplicationError('invalid_input', { message: `${table} 必须是列表` });
        const max = TABLES[table].maxRows ?? DEFAULT_MAX_ROWS;
        if (rows.length > max) throw new ApplicationError('too_large', { message: `${table} 超过 ${max} 条上限` });
        prepared[table] = rows.map((input, index) => {
          requireObject(input, `${table}[${index}]`);
          const columns = Object.keys(TABLES[table].columns);
          const missing = columns.filter((column) => !Object.prototype.hasOwnProperty.call(input, column));
          if (missing.length) {
            throw new ApplicationError('invalid_input', { field: missing[0], message: `${table} 第 ${index + 1} 条缺少字段 ${missing[0]}` });
          }
          const row = validated(table, input, { allowServer: true });
          requireId(row.id);
          return columns.reduce((acc, column) => ({ ...acc, [column]: row[column] ?? null }), {});
        });
      }
      assertSnapshotRefs(prepared);
      for (const table of TABLE_NAMES) await wipeTable(supabase, table);
      const counts = {};
      const failed = [];
      for (const table of TABLE_NAMES) {
        if (prepared[table].length === 0) { counts[table] = 0; continue; }
        const result = await supabase.from(table).insert(prepared[table]).select('id');
        if (result.error) {
          failed.push(table);
          counts[table] = 0;
          continue;
        }
        counts[table] = Array.isArray(result.data) ? result.data.length : prepared[table].length;
      }
      if (failed.length) {
        // 逐表写入不是一个事务：明确告知哪些表未导入，让界面提示重试而不是假装成功
        return fail(503, { error: 'import_partial', message: `部分数据未写入：${failed.join('、')}，请重新导入` , counts });
      }
      return ok({ counts });
    },
  },

  wipe: {
    methods: ['POST'],
    async handler({ supabase, body }) {
      if (body.confirm !== 'DELETE_ALL') {
        throw new ApplicationError('confirm_required', { message: '需要明确确认后才能清空数据' });
      }
      const deleted = {};
      for (const table of TABLE_NAMES) deleted[table] = await wipeTable(supabase, table);
      return ok({ deleted });
    },
  },
};

export async function handleApp({ request, supabase }) {
  let response;
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const route = action ? ACTIONS[action] : undefined;
    if (!route) return fail(404, { error: 'not_found', message: '未知操作' });
    if (!route.methods.includes(request.method)) {
      return fail(405, { error: 'method_not_allowed', message: '该操作不支持此请求方法' });
    }
    const body = route.methods.includes('POST') ? requireObject(await readJson(request), '请求内容') : {};
    response = await route.handler({ supabase, request, body, params: url.searchParams });
  } catch (error) {
    if (error instanceof ApplicationError) {
      response = fail(error.status, {
        error: error.code,
        ...(error.field ? { field: error.field } : {}),
        message: error.message ?? '请求未成功',
      });
    } else if (error?.message === 'database_request_failed' || error?.message === 'count_unavailable') {
      response = fail(503, { error: 'database_request_failed', message: '数据服务暂不可用，请稍后重试' });
    } else if (error?.application) {
      response = fail(400, error.application);
    } else {
      // 不泄漏驱动错误、SQL、请求地址或凭据
      response = fail(503, { error: 'database_request_failed', message: '数据服务暂不可用，请稍后重试' });
    }
  }
  return response;
}

export { ACTIONS, MAX_BODY_BYTES };
