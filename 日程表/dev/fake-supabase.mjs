// 内存版 Supabase 客户端，仅供本地预览与测试使用（不进入发布包）。
// 目标是复刻 PostgREST 的可观察语义：builder 可 await、无匹配行返回 data:null、
// .single() 在零行时报 PGRST116、重复主键报 23505。

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function compare(a, b) {
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function matches(row, filter) {
  const { column, op, value, negated } = filter;
  const actual = row[column];
  let hit;
  switch (op) {
    case 'eq': hit = actual === value; break;
    case 'neq': hit = actual !== value; break;
    case 'in': hit = Array.isArray(value) && value.includes(actual); break;
    case 'gte': hit = compare(actual, value) >= 0; break;
    case 'lte': hit = compare(actual, value) <= 0; break;
    case 'gt': hit = compare(actual, value) > 0; break;
    case 'lt': hit = compare(actual, value) < 0; break;
    case 'is': hit = actual === value; break;
    default: throw new Error(`fake_supabase_unsupported_op:${op}`);
  }
  return negated ? !hit : hit;
}

class Builder {
  constructor(db, table) {
    Object.assign(this, { db, table });
    this.verb = null;
    this.filters = [];
    this.orders = [];
    this.columns = '*';
    this.limitCount = null;
    this.wantCount = false;
    this.cardinality = 'many';
    this.payload = null;
    this.returning = false;
  }

  // PostgREST 里 insert/update/delete 后接 select 表示"写并返回行"，不改变动作本身。
  select(columns = '*', options = {}) {
    this.verb ??= 'select';
    this.columns = columns;
    if (options.count) this.wantCount = true;
    this.returning = true;
    return this;
  }

  insert(rows) { this.verb = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.verb = 'update'; this.payload = patch; return this; }
  delete() { this.verb = 'delete'; return this; }

  eq(column, value) { this.filters.push({ column, op: 'eq', value }); return this; }
  neq(column, value) { this.filters.push({ column, op: 'neq', value }); return this; }
  in(column, value) { this.filters.push({ column, op: 'in', value }); return this; }
  gte(column, value) { this.filters.push({ column, op: 'gte', value }); return this; }
  lte(column, value) { this.filters.push({ column, op: 'lte', value }); return this; }
  gt(column, value) { this.filters.push({ column, op: 'gt', value }); return this; }
  lt(column, value) { this.filters.push({ column, op: 'lt', value }); return this; }
  is(column, value) { this.filters.push({ column, op: 'is', value }); return this; }
  not(column, op, value) { this.filters.push({ column, op, value, negated: true }); return this; }

  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(n) { this.limitCount = n; return this; }
  single() { this.cardinality = 'single'; return this; }
  maybeSingle() { this.cardinality = 'maybeSingle'; return this; }

  project(row) {
    if (this.columns === '*') return clone(row);
    const keys = this.columns.split(',').map((key) => key.trim()).filter(Boolean);
    const out = {};
    for (const key of keys) out[key] = row[key] ?? null;
    return out;
  }

  async run() {
    if (this.db.failNext) { this.db.failNext = false; return { data: null, error: { message: 'simulated database failure', code: 'fake' } }; }
    if (!this.db.tables[this.table]) {
      return { data: null, error: { message: `relation "app.${this.table}" does not exist`, code: '42P01' } };
    }
    const store = this.db.tables[this.table];
    const where = (row) => this.filters.every((filter) => matches(row, filter));

    if (this.verb === 'select') {
      let rows = store.filter(where);
      for (const { column, ascending } of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => (ascending ? compare(a[column], b[column]) : compare(b[column], a[column])));
      }
      const count = this.wantCount ? rows.length : null;
      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      const data = rows.map((row) => this.project(row));
      if (this.cardinality === 'single' && data.length === 0) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      }
      if (this.cardinality === 'maybeSingle') return { data: data[0] ?? null, count, error: null };
      if (this.cardinality === 'single' && data.length !== 1) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      }
      return { data, count, error: null };
    }

    if (this.verb === 'insert') {
      const seen = new Set();
      for (const incoming of this.payload) {
        if (seen.has(incoming.id) || store.some((row) => row.id === incoming.id)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        }
        seen.add(incoming.id);
      }
      store.push(...this.payload.map(clone));
      const created = this.payload.map((row) => store.find((item) => item.id === row.id));
      if (!this.returning) return { data: null, error: null };
      const data = created.map((row) => this.project(row));
      if (this.cardinality === 'single') return { data: data[0] ?? null, error: data.length ? null : { code: 'PGRST116' } };
      if (this.cardinality === 'maybeSingle') return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }

    if (this.verb === 'update') {
      const before = store.filter(where);
      const updated = [];
      for (const row of before) {
        Object.assign(row, clone(this.payload));
        updated.push(this.project(row));
      }
      if (!this.returning) return { data: null, count: updated.length, error: null };
      if (this.cardinality === 'many') return { data: updated, count: updated.length, error: null };
      return { data: updated[0] ?? null, count: updated.length, error: updated.length || this.cardinality === 'maybeSingle' ? null : { code: 'PGRST116' } };
    }

    if (this.verb === 'delete') {
      const removed = store.filter(where);
      this.db.tables[this.table] = store.filter((row) => !where(row));
      const data = removed.map((row) => this.project(row));
      if (!this.returning) return { data: null, count: removed.length, error: null };
      if (this.cardinality === 'many') return { data, count: removed.length, error: null };
      return { data: data[0] ?? null, count: removed.length, error: null };
    }

    throw new Error(`fake_supabase_unsupported_verb:${this.verb}`);
  }

  then(onFulfilled, onRejected) {
    return this.run().then((result) => ({ status: 200, ...result })).then(onFulfilled, onRejected);
  }
}

export function createFakeSupabase(initial = {}) {
  const db = {
    tables: Object.fromEntries(Object.entries(initial).map(([name, rows]) => [name, clone(rows)])),
    failNext: false,
    rows(name) { return this.tables[name] ?? []; },
    setFailNext(value = true) { this.failNext = value; return this; },
  };
  return {
    __db: db,
    from: (table) => new Builder(db, table),
  };
}
