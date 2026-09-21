// 服务端独有的完整性规则。表之间没有外键（平台受限 DDL 不支持），
// 因此级联删除、父子存在性校验和自动进度计算都在这一层做，且只在这里做一遍。
import { TABLES, PARENT_REFS } from './registry.mjs';

const MAX_ROWS = 5000;

/** 精确计数：有界 GET + SDK count，不用 data.length 代替。 */
export async function countRows(supabase, table) {
  const result = await supabase.from(table).select('id', { count: 'exact' }).limit(1);
  if (result.error || !Number.isSafeInteger(result.count) || result.count < 0) {
    throw new Error('count_unavailable');
  }
  return result.count;
}

export async function readAll(supabase, table) {
  const { orderBy, columns } = TABLES[table];
  const [column, ascending] = orderBy;
  const result = await supabase.from(table)
    .select(Object.keys(columns).join(','))
    .order(column, { ascending })
    .order('id', { ascending: true })
    .limit(MAX_ROWS);
  if (result.error || !Array.isArray(result.data)) throw new Error('database_request_failed');
  return result.data;
}

export async function rowExists(supabase, table, id) {
  const result = await supabase.from(table).select('id').eq('id', id).maybeSingle();
  if (result.error) throw new Error('database_request_failed');
  return result.data !== null;
}

export async function readChildIds(supabase, table, column, value) {
  const result = await supabase.from(table).select('id').eq(column, value).limit(MAX_ROWS);
  if (result.error || !Array.isArray(result.data)) throw new Error('database_request_failed');
  return result.data.map((row) => row.id);
}

/** 删除一行，返回被删的行；无匹配返回 null（调用方据此报 not_found，不能当作成功）。 */
export async function deleteRow(supabase, table, id) {
  const result = await supabase.from(table).delete().eq('id', id).select('id').maybeSingle();
  if (result.error) throw new Error('database_request_failed');
  return result.data;
}

/**
 * 按 PRD 5.3 的级联语义删除：项目 → 其里程碑 → 里程碑的子任务。
 * 返回 { deleted: {table: n} }；SDK 调用不是事务，中途失败时返回已删部分并由调用方提示刷新。
 */
export async function deleteWithCascade(supabase, table, id) {
  const deleted = { [table]: 0 };
  if (table === 'research_projects') {
    const milestoneIds = await readChildIds(supabase, 'milestones', 'project_id', id);
    for (const milestoneId of milestoneIds) {
      const subtaskIds = await readChildIds(supabase, 'subtasks', 'milestone_id', milestoneId);
      for (const subtaskId of subtaskIds) {
        if (await deleteRow(supabase, 'subtasks', subtaskId)) deleted.subtasks = (deleted.subtasks ?? 0) + 1;
      }
      if (await deleteRow(supabase, 'milestones', milestoneId)) deleted.milestones = (deleted.milestones ?? 0) + 1;
    }
  } else if (table === 'milestones') {
    const subtaskIds = await readChildIds(supabase, 'subtasks', 'milestone_id', id);
    for (const subtaskId of subtaskIds) {
      if (await deleteRow(supabase, 'subtasks', subtaskId)) deleted.subtasks = (deleted.subtasks ?? 0) + 1;
    }
  }
  if (await deleteRow(supabase, table, id)) deleted[table] = 1;
  else delete deleted[table];
  return { deleted, empty: Object.keys(deleted).length === 0 };
}

/** 子任务变化后重算里程碑进度；manual_progress 为真时不覆盖用户手填值。 */
export async function syncMilestoneProgress(supabase, milestoneId) {
  const result = await supabase.from('milestones')
    .select('id,project_id,title,note,target_date,status,progress,manual_progress,sort,created_at,updated_at')
    .eq('id', milestoneId).maybeSingle();
  if (result.error) throw new Error('database_request_failed');
  const milestone = result.data;
  if (!milestone || milestone.manual_progress) return milestone;
  const subtasks = await supabase.from('subtasks').select('id,done').eq('milestone_id', milestoneId).limit(MAX_ROWS);
  if (subtasks.error || !Array.isArray(subtasks.data)) throw new Error('database_request_failed');
  const total = subtasks.data.length;
  const doneCount = subtasks.data.filter((row) => row.done).length;
  const progress = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  if (progress === milestone.progress) return milestone;
  const updated = await supabase.from('milestones')
    .update({ progress, updated_at: new Date().toISOString() })
    .eq('id', milestoneId).select('id,project_id,title,note,target_date,status,progress,manual_progress,sort,created_at,updated_at').maybeSingle();
  if (updated.error) throw new Error('database_request_failed');
  return updated.data ?? { ...milestone, progress };
}

/** 排序值：现有最大值 + 1，让新增项落在末尾。 */
export async function nextSort(supabase, table) {
  if (!TABLES[table].columns.sort) return null;
  const rows = await supabase.from(table).select('sort').limit(MAX_ROWS);
  if (rows.error || !Array.isArray(rows.data)) throw new Error('database_request_failed');
  const values = rows.data.map((row) => row.sort).filter((value) => Number.isSafeInteger(value));
  return values.length ? Math.max(...values) + 1 : 0;
}

export async function assertParentExists(supabase, table, row) {
  const ref = PARENT_REFS[table];
  if (!ref) return;
  const parentId = row[ref.column];
  if (!parentId) return;
  if (!(await rowExists(supabase, ref.table, parentId))) {
    const error = new Error(`invalid_parent:${ref.column}`);
    error.application = { error: 'invalid_parent', field: ref.column, message: `${ref.label}不存在或已被删除` };
    throw error;
  }
}

/** 导入时校验快照里的父子引用是否自洽（同批数据内互相引用）。 */
export function assertSnapshotRefs(tables) {
  for (const [table, ref] of Object.entries(PARENT_REFS)) {
    const parentIds = new Set((tables[ref.table] ?? []).map((row) => row.id));
    for (const row of tables[table] ?? []) {
      if (!parentIds.has(row[ref.column])) {
        const error = new Error(`invalid_parent:${ref.column}`);
        error.application = { error: 'invalid_parent', field: ref.column, message: `${ref.label}不存在或已被删除` };
        throw error;
      }
    }
  }
}

export async function wipeTable(supabase, table) {
  const before = await countRows(supabase, table);
  const result = await supabase.from(table).delete().not('id', 'is', null).select('id');
  if (result.error) throw new Error('database_request_failed');
  return before;
}
