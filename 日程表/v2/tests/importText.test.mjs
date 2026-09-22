import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseImportText } from '../lib/import/parseText.js';
import { findDays, findSections, findWeeks, looksLikeRoom, isNoiseLine } from '../lib/import/tokenize.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample1 = readFileSync(join(here, 'fixtures/sample1-mobile-lossy.txt'), 'utf8');

// ---- token 层 ----

test('findDays：周一~周日 / 星期X / 礼拜X / 周1 全部映射 1..7', () => {
  assert.equal(findDays('周三有课')[0].day, 3);
  assert.equal(findDays('星期天')[0].day, 7);
  assert.equal(findDays('礼拜五')[0].day, 5);
  assert.equal(findDays('周2')[0].day, 2);
  assert.equal(findDays('没有星期几').length, 0);
});

test('findSections：节次区间 / 竖排 / 单节 / 时间段换算', () => {
  assert.deepEqual(findSections('第3-4节'), { start: 3, end: 4 });
  assert.deepEqual(findSections('3~4节'), { start: 3, end: 4 });
  assert.deepEqual(findSections('030405节'), { start: 3, end: 5 });
  assert.deepEqual(findSections('第6节'), { start: 6, end: 6 });
  // 08:00-09:35 → 第1节(08:00)起、第2节(09:35)止
  assert.deepEqual(findSections('08:00-09:35'), { start: 1, end: 2 });
  // 14：00~14：45 全角冒号 → 第6节
  assert.deepEqual(findSections('14：00~14：45'), { start: 6, end: 6 });
  assert.equal(findSections('没有时间信息'), null);
});

test('findWeeks：范围 / 单值 / 单双周', () => {
  assert.deepEqual(findWeeks('第(1)-(16)周'), { from: 1, to: 16, parity: 'all' });
  assert.deepEqual(findWeeks('1-16周'), { from: 1, to: 16, parity: 'all' });
  assert.deepEqual(findWeeks('第3周'), { from: 3, to: 3, parity: 'all' });
  assert.deepEqual(findWeeks('单周'), { from: 1, to: 14, parity: 'odd' });
  assert.equal(findWeeks('没有时间'), null);
});

test('looksLikeRoom / isNoiseLine', () => {
  assert.equal(looksLikeRoom('教学一号楼3004'), true);
  assert.equal(looksLikeRoom('杭州田径场'), true);
  assert.equal(looksLikeRoom('计算机房（R1-4090）'), true);
  assert.equal(looksLikeRoom('高等数学'), false);
  assert.equal(looksLikeRoom('第3-4节'), false);
  assert.equal(isNoiseLine('星期节次'), true);
  assert.equal(isNoiseLine('9.21'), true);
  assert.equal(isNoiseLine('3'), true);
  assert.equal(isNoiseLine('----'), true);
  assert.equal(isNoiseLine('高等数学'), false);
});

// ---- parseImportText：正常结构化文本 ----

test('结构化课表：逐行解析成 ok 条目', () => {
  const text = [
    '高等数学 周一 第1-2节 教学一号楼101',
    '大学英语 周二 08:00-09:35 外语楼202',
    '体育 周三 第3节 西田径场',
  ].join('\n');
  const { items, positionLoss } = parseImportText(text);
  assert.equal(positionLoss, false);
  assert.equal(items.length, 3);
  assert.equal(items[0].name, '高等数学');
  assert.equal(items[0].day, 1);
  assert.deepEqual({ s: items[0].startSection, e: items[0].endSection }, { s: 1, e: 2 });
  assert.equal(items[0].room, '教学一号楼101');
  assert.equal(items[0].status, 'ok');
  assert.deepEqual(items[1].startSection, 1);
  assert.deepEqual(items[1].endSection, 2);
});

test('一行多上课日 → 拆多条预览行', () => {
  const text = '综合法语 教学一号楼5005 周一 周三 第3-4节';
  const { items } = parseImportText(text);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.day), [1, 3]);
  assert.ok(items.every((i) => i.name.includes('综合法语')));
  assert.equal(items[0].startSection, 3);
});

test('缺星期或缺节次 → needsFix 且 missing 指明缺哪项', () => {
  const { items } = parseImportText('线性代数 教学一号楼303 第5-6节');
  assert.equal(items[0].status, 'needsFix');
  assert.ok(items[0].missing.includes('day'));
  const r = parseImportText('复变函数 周四 教学二号楼');
  assert.ok(r.items[0].missing.includes('section'));
});

test('周次与单双周解析进 weeks 字段', () => {
  const { items } = parseImportText('数学实验 周一 第3-4节 实验楼301 单周 第1-8周');
  assert.deepEqual(items[0].weeks, { from: 1, to: 8, parity: 'odd' });
});

test('颜色按调色板轮询分配', () => {
  const { items } = parseImportText([
    'A课 周一 第1节 楼1', 'B课 周二 第2节 楼2', 'C课 周三 第3节 楼3',
  ].join('\n'));
  assert.deepEqual(items.map((i) => i.color), ['blue', 'purple', 'green']);
});

test('表头噪声与空行被忽略，垃圾行进 unparsed 不静默丢弃', () => {
  const text = ['星期', '时间', '高等数学 周一 第1-2节 楼101', '', '！！！？？？'].join('\n');
  const { items, unparsed } = parseImportText(text);
  assert.equal(items.length, 1);
  assert.deepEqual(unparsed, ['！！！？？？']);
});

// ---- 来源探测：样例 1（手机端教务课表页长按复制，丢位网格） ----

test('样例1：判为 positionLoss，产 14 条"课名+地点"半自动候选', () => {
  const { items, positionLoss } = parseImportText(sample1);
  assert.equal(positionLoss, true);
  assert.equal(items.length, 14);
  assert.ok(items.every((i) => i.status === 'semiAuto'));
  // 每条都有课名与地点，但没有星期/节次（文本层面确实丢了）
  assert.ok(items.every((i) => i.name && i.room && i.day === null && i.startSection === null));
  const first = items[0];
  assert.equal(first.name, '法国歌剧史与作品赏析');
  assert.equal(first.room, '教学一号楼3004');
  const last = items[13];
  assert.equal(last.name, '综合法语实训(1)');
  assert.equal(last.room, '教学一号楼B1001');
});

test('样例1：14 条课名与用户截图 ground truth 对齐', () => {
  const { items } = parseImportText(sample1);
  assert.deepEqual(items.map((i) => i.name), [
    '法国歌剧史与作品赏析', '综合法语实训(1)', '综合法语(1)', '体育(1)',
    '基础英语(1)', '大学计算机基础', '综合法语(1)', '综合法语(1)',
    '心理健康（1）', '航空航天概论A', '数学基础', '综合法语(1)',
    '习近平新时代中国特色社会主义思想概论', '综合法语实训(1)',
  ]);
});
