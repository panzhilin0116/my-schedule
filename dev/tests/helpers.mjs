import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');

/** 只编译不执行：用于校验浏览器端模块语法正确，而不需要 DOM。 */
export async function assertModuleParses(absPath) {
  const source = await readFile(pathToFileURL(absPath), 'utf8');
  assert.ok(source.trim().length > 0, `${absPath} 是空文件`);
  let compiled = false;
  try {
    const Module = vm.SourceTextModule ?? (await import('node:vm')).SourceTextModule;
    if (!Module) throw Error('SourceTextModule 不可用');
    new Module(source, { identifier: pathToFileURL(absPath).href });
    compiled = true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      assert.fail(`${absPath} 存在语法错误：${error.message}`);
    }
    if (!compiled) assert.fail(`${absPath} 无法编译：${error.message}`);
  }
}

/** 解析受限 DDL 子集里的 CREATE TABLE / CREATE INDEX。 */
export function parseSql(schemaSql) {
  const tables = new Map();
  const indexes = [];
  const tableRe = /CREATE TABLE app\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const match of schemaSql.matchAll(tableRe)) {
    const [, name, body] = match;
    const columns = new Map();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      const colMatch = /^(\w+)\s+(\w+)(.*)$/.exec(line);
      assert.ok(colMatch, `无法解析的列定义：${line}`);
      const [, column, type, rest] = colMatch;
      columns.set(column, { type, constraints: rest.trim() });
    }
    tables.set(name, columns);
  }
  for (const match of schemaSql.matchAll(/CREATE INDEX (\w+) ON app\.(\w+)\s*\(([^)]*)\);/g)) {
    indexes.push({ name: match[1], table: match[2], columns: match[3].trim() });
  }
  return { tables, indexes };
}
