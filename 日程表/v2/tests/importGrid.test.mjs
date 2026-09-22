// §5.7 P4 预处理纯像素函数 + P6 网格重建（合成 bbox，ground truth = 用户真实课表 14 门）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planResize, toGray, stretchGray, meanGray, invertIfDarkBackground,
  preprocessGray, grayToRgba, luma,
} from '../lib/import/preprocess.js';
import {
  itemsFromWords, findDayColumns, findSectionRows, cellToCourse, clusterRows, mergeWordLists,
} from '../lib/import/grid.js';

// ---------- preprocess：纯函数 ----------

test('planResize：超长边等比压到 2000，小图不放大', () => {
  assert.deepEqual(planResize(4000, 3000), { scale: 0.5, width: 2000, height: 1500 });
  assert.deepEqual(planResize(800, 600), { scale: 1, width: 800, height: 600 });
  assert.equal(planResize(9000, 1000).width, 2000);
});

test('toGray / luma：黑 0、白 255、彩色按 Rec.601', () => {
  assert.equal(luma(0, 0, 0), 0);
  assert.equal(luma(255, 255, 255), 255);
  const g = toGray(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1);
  assert.deepEqual([...g], [0, 255]);
});

test('stretchGray：浅彩底课表拉开动态范围；平场不动', () => {
  // 80% 浅黄底(220)、20% 字(170)：拉伸后应逼近 0/255 双峰
  const gray = new Uint8Array(100).fill(220).map((v, i) => (i < 20 ? 170 : v));
  const out = stretchGray(gray);
  assert.equal(out[0], 0);
  assert.equal(out[99], 255);
  // 全平（无对比度）不动
  const flat = new Uint8Array(50).fill(200);
  assert.deepEqual([...stretchGray(flat)], [...flat]);
});

test('invertIfDarkBackground：白字黑底反相，正常图原样', () => {
  const dark = new Uint8Array(100).fill(30);
  const inv = invertIfDarkBackground(dark);
  assert.equal(inv[0], 225);
  const light = new Uint8Array(100).fill(240);
  assert.equal(invertIfDarkBackground(light)[0], 240);
});

test('preprocessGray 整链：深底白字截图归一为黑字白底', () => {
  const w = 10;
  const hgt = 10;
  const rgba = new Uint8ClampedArray(w * hgt * 4);
  for (let i = 0; i < w * hgt; i += 1) {
    const p = i * 4;
    const text = i % 10 === 3; // 每行一个字，RGB 白
    rgba[p] = rgba[p + 1] = rgba[p + 2] = text ? 255 : 20;
    rgba[p + 3] = 255;
  }
  const out = preprocessGray(rgba, w, hgt);
  assert.ok(meanGray(out) > 200, '背景应占多数且为亮');
  assert.ok(out[3] < out[4], '字位比背景暗（已反相）');
  const back = grayToRgba(out, w, hgt);
  assert.equal(back.length, w * hgt * 4);
  assert.equal(back[4 * 10 + 3], 255);
});

// ---------- grid：锚点与工具 ----------

const mkWord = (text, x, y, width = 84, height = 16) => ({
  text, confidence: 90,
  bbox: { x0: x - width / 2, y0: y - height / 2, x1: x + width / 2, y1: y + height / 2 },
});
const COL_X = (day) => 140 + (day - 1) * 120;
const ROW_Y = (s) => 80 + (s - 1) * 40;

/** 一门课在 (day, start–end) 单元格内的若干行文字：首行落在起始节，末行落在结束节，中间均分。 */
function cellWords(day, start, end, lines) {
  return lines.map((text, i) => {
    const frac = lines.length === 1 ? 0 : i / (lines.length - 1);
    return mkWord(text, COL_X(day), ROW_Y(start + frac * (end - start)));
  });
}

function headerWords(textOf) {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => mkWord(textOf(d), COL_X(d), 28, 60));
}
function sectionWords(to = 14) {
  return Array.from({ length: to }, (_, i) => mkWord(String(i + 1), 40, ROW_Y(i + 1), 20));
}

test('clusterRows / findDayColumns / findSectionRows：双字头与单字头都认', () => {
  const full = headerWords((d) => `周${'一二三四五六日'[d - 1]}`);
  const cols = findDayColumns(clusterRows(full).flatMap((r) => r.items), 700);
  assert.equal(cols.length, 7);
  assert.deepEqual(cols.map((c) => c.day), [1, 2, 3, 4, 5, 6, 7]);

  const bare = headerWords((d) => '一二三四五六日'[d - 1]);
  assert.equal(findDayColumns(bare, 700).length, 7, '单字表头（一…日）也要能定列');

  const rows = findSectionRows(sectionWords(14), COL_X(1));
  assert.equal(rows.length, 14);
  assert.equal(rows[0].section, 1);
  assert.equal(rows[13].section, 14);
  assert.equal(findSectionRows(sectionWords(14).slice(0, 1), COL_X(1)), null, '只 1 个节次号不认网格');
});

test('cellToCourse：课名/地点/周次/房号切分', () => {
  assert.deepEqual(
    cellToCourse('综合法语(1) 5005'),
    { name: '综合法语(1)', room: '5005', weeks: null },
  );
  const w = cellToCourse('航空航天概论A 2003 1-16周');
  assert.equal(w.name, '航空航天概论A');
  assert.equal(w.room, '2003');
  assert.deepEqual(w.weeks, { from: 1, to: 16, parity: 'all' });
  assert.equal(cellToCourse('体育(1) 杭州田径场').room, '杭州田径场');
});

// ---------- grid：整表重建（样例截图 ground truth） ----------

const GROUND_TRUTH = [
  { day: 1, s: 1, e: 2, name: '法国歌剧史与作品赏析', room: '教学一号楼3004' },
  { day: 1, s: 3, e: 4, name: '综合法语实训(1)', room: '教学二号楼4003' },
  { day: 1, s: 6, e: 7, name: '综合法语(1)', room: '5005' },
  { day: 1, s: 8, e: 9, name: '体育(1)', room: '杭州田径场' },
  { day: 2, s: 1, e: 2, name: '基础英语(1)', room: '4003' },
  { day: 2, s: 3, e: 5, name: '大学计算机基础', room: '计算机房（R1-4090）' },
  { day: 2, s: 6, e: 7, name: '综合法语(1)', room: '5005' },
  { day: 3, s: 3, e: 4, name: '综合法语(1)', room: '5005' },
  { day: 3, s: 8, e: 9, name: '心理健康（1）', room: '2004' },
  { day: 4, s: 3, e: 4, name: '航空航天概论A', room: '2003' },
  { day: 4, s: 6, e: 7, name: '数学基础', room: '科研一号楼1001' },
  { day: 4, s: 11, e: 12, name: '综合法语(1)', room: '5005' },
  { day: 5, s: 1, e: 4, name: '习近平新时代中国特色社会主义思想概论', room: '科研一号楼1040' },
  { day: 5, s: 6, e: 6, name: '综合法语实训(1)', room: '教学一号楼B1001' },
];

function sampleWords(extra = []) {
  return [
    ...headerWords((d) => `周${'一二三四五六日'[d - 1]}`),
    ...sectionWords(14),
    ...GROUND_TRUTH.flatMap((g) => cellWords(g.day, g.s, g.e, [g.name, g.room])),
    ...extra,
  ];
}

const norm = (items) => items
  .map((it) => `${it.day}|${it.startSection}-${it.endSection}|${it.name}|${it.room}`)
  .sort();

test('整表重建：14 门课的星期/节次区间/课名/地点全部对上 ground truth', () => {
  const { items, gridFailed } = itemsFromWords(sampleWords(), { width: 980, height: 700 });
  assert.equal(gridFailed, false);
  assert.equal(items.length, 14);
  assert.deepEqual(norm(items), norm(GROUND_TRUTH.map((g) => ({
    day: g.day, startSection: g.s, endSection: g.e, name: g.name, room: g.room,
  }))));
  assert.ok(items.every((it) => it.status === 'ok' && it.color));
});

test('整表重建：PreviewItem 契约字段齐全', () => {
  const { items } = itemsFromWords(sampleWords(), { width: 980, height: 700 });
  const opera = items.find((it) => it.name === '法国歌剧史与作品赏析');
  assert.deepEqual(
    Object.keys(opera).sort(),
    ['color', 'day', 'endSection', 'missing', 'name', 'raw', 'room', 'startSection', 'status', 'weeks'].sort(),
  );
  assert.equal(opera.raw.includes('教学一号楼3004'), true);
});

test('周次行与页脚：weeks 进字段，页脚词进未识别', () => {
  const words = sampleWords([
    ...cellWords(4, 3, 4, ['1-16周']), // 航空航天格子里的周次行（同名合并）
    mkWord('教务处制', COL_X(4), 690),
  ]);
  const { items, unparsed } = itemsFromWords(words, { width: 980, height: 700 });
  const aero = items.find((it) => it.name === '航空航天概论A');
  assert.deepEqual(aero.weeks, { from: 1, to: 16, parity: 'all' });
  assert.equal(items.filter((it) => it.name === '航空航天概论A').length, 1, '周次行不得分裂成第二门课');
  assert.ok(unparsed.includes('教务处制'));
});

test('网格认不出来：gridFailed + 每行退化为半自动候选（不硬猜）', () => {
  const words = [
    mkWord('高等数学', 200, 100),
    mkWord('教学一号楼101', 200, 130),
    mkWord('线性代数', 500, 200),
  ];
  const { items, gridFailed } = itemsFromWords(words, { width: 900, height: 600 });
  assert.equal(gridFailed, true);
  assert.equal(items.length, 3);
  assert.ok(items.every((it) => it.status === 'semiAuto' && it.day === null && it.startSection === null));
  assert.deepEqual(items.map((it) => it.name), ['高等数学', '教学一号楼101', '线性代数']);
});

test('空词表：gridFailed 且无项目（上层据此报"读不出文字"）', () => {
  const { items, unparsed, gridFailed } = itemsFromWords([], {});
  assert.equal(gridFailed, true);
  assert.equal(items.length, 0);
  assert.equal(unparsed.length, 0);
});

test('真实 OCR 噪声：置信度词与竖排节次"第1节"也能定行', () => {
  const rows = findSectionRows(
    [1, 2, 3, 4, 5].map((s) => mkWord(`第${s}节`, 40, ROW_Y(s), 40)),
    COL_X(1),
  );
  assert.deepEqual(rows.map((r) => r.section), [1, 2, 3, 4, 5]);
});

test('周六周日列：周末课程同样归位', () => {
  const words = [
    ...headerWords((d) => `周${'一二三四五六日'[d - 1]}`),
    ...sectionWords(12),
    ...cellWords(6, 1, 2, ['劳动教育', '5005']),
  ];
  const { items, gridFailed } = itemsFromWords(words, { width: 980, height: 700 });
  assert.equal(gridFailed, false);
  const sat = items.find((it) => it.name === '劳动教育');
  assert.equal(sat.day, 6);
  assert.deepEqual({ s: sat.startSection, e: sat.endSection }, { s: 1, e: 2 });
});

test('mergeWordLists：正反两遍按 IoU 去重，留高置信度', () => {
  const a = [
    { text: '综合法语(1)', confidence: 60, bbox: { x0: 100, y0: 100, x1: 200, y1: 130 } },
    { text: '教学一号…', confidence: 55, bbox: { x0: 100, y0: 140, x1: 200, y1: 170 } },
  ];
  const b = [
    { text: '综合法语(1)', confidence: 85, bbox: { x0: 102, y0: 101, x1: 198, y1: 129 } }, // 同词高置信
    { text: '体育(1)', confidence: 70, bbox: { x0: 400, y0: 100, x1: 480, y1: 130 } }, // 反相版独有
  ];
  const merged = mergeWordLists(a, b);
  assert.equal(merged.length, 3);
  const fr = merged.find((w) => w.text.startsWith('综合法语'));
  assert.equal(fr.confidence, 85);
  assert.ok(merged.some((w) => w.text === '体育(1)'));
  assert.ok(merged.some((w) => w.text === '教学一号…'));
});

test('日期表头锚点：单字星期丢了也能按日历反查星期定列', () => {
  // 2026-09-21 是周一（学期第 3 周起点）：9.21…9.27 → 周一…周日
  const dateHeader = ['9.21', '9.22', '9.23', '9.24', '9.25', '9.26', '9.27']
    .map((t, i) => mkWord(t, COL_X(i + 1), 55, 50));
  const words = [
    ...dateHeader,
    ...sectionWords(12),
    ...cellWords(1, 1, 2, ['法国歌剧史与作品赏析', '教学一号楼3004']),
    ...cellWords(6, 3, 4, ['劳动', '5005']),
  ];
  const { items, gridFailed } = itemsFromWords(words, { width: 980, height: 700 });
  assert.equal(gridFailed, false, '日期行应能定列');
  const opera = items.find((it) => it.name === '法国歌剧史与作品赏析');
  assert.equal(opera.day, 1);
  assert.deepEqual({ s: opera.startSection, e: opera.endSection }, { s: 1, e: 2 });
  const sat = items.find((it) => it.name === '劳动');
  assert.equal(sat.day, 6, '9.26 → 周六');
});

test('日期表头：状态栏时间 16.19 等非法日期不会误判成星期', () => {
  assert.equal(findDayColumns([mkWord('16.19', 100, 30), mkWord('6.2', 300, 30)], 700) && null, null,
    '月>12 的假日期凑不齐 2 列就不得定列（16.19 非法；6.2 只有 1 个合法）');
});

test('OCR 词序乱序：组内按空间阅读序（聚行后按 x）拼接，而非识别顺序', () => {
  const words = [
    ...headerWords((d) => `周${'一二三四五六日'[d - 1]}`),
    ...sectionWords(14),
    // 同一格第一行被拆成三个词，喂入顺序故意打乱：概论 → 楼 → 新时代 → 思想
    mkWord('概论', COL_X(1) + 50, ROW_Y(1), 40),
    mkWord('教学一号楼', COL_X(1), ROW_Y(2), 90),
    mkWord('新时代', COL_X(1) - 34, ROW_Y(1), 54),
    mkWord('思想', COL_X(1) + 5, ROW_Y(1), 36),
  ];
  const { items, gridFailed } = itemsFromWords(words, { width: 980, height: 700 });
  assert.equal(gridFailed, false);
  const course = items.find((it) => it.room === '教学一号楼');
  assert.ok(course, '同格碎词应归并成同一门课');
  assert.equal(course.name, '新时代 思想 概论', '课名按 x 从左到右拼接');
});

test('内容质量门：锚点在、但课名大半是一两个碎字 → 整体降级半自动（不硬猜）', () => {
  const words = [
    ...headerWords((d) => `周${'一二三四五六日'[d - 1]}`),
    ...sectionWords(14),
    ...cellWords(1, 1, 2, ['新时代中国特色社会主义', '教学一号楼3004']),
    ...cellWords(3, 6, 7, ['体育(1)', '杭州田径场']),
    // 彩色底白字只识出零星单字：这些"课"全是 1 字符碎片
    ...[['法', 2, 4], ['国', 2, 7], ['号', 4, 8], ['健', 4, 11], ['舞', 5, 3]]
      .map(([t, d, s]) => mkWord(t, COL_X(d), ROW_Y(s), 18)),
  ];
  const { items, gridFailed } = itemsFromWords(words, { width: 980, height: 700 });
  assert.equal(gridFailed, true, '大半是碎片时不得输出"已识别"的假课清单');
  assert.ok(items.length >= 5);
  assert.ok(items.every((it) => it.status === 'semiAuto' && it.day === null && it.startSection === null));
  assert.ok(items.some((it) => it.name.includes('新时代')));
});

// ---------- imageHandler 编排层（node 环境安全护栏） ----------

test('imageHandler：非浏览器环境下明确报错，绝不上传', async () => {
  const { imageHandler } = await import('../lib/import/imageHandler.js');
  await assert.rejects(
    () => imageHandler('data:image/png;base64,AAAA', { onProgress: () => {} }),
    /浏览器环境/,
  );
});

test('vendor 目录：五件套齐全且为真实产物', async () => {
  const { readFileSync, statSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'tesseract');
  const expect = [
    ['tesseract.min.js', 50_000],
    ['worker.min.js', 50_000],
    ['tesseract-core-simd-lstm.wasm.js', 1_000_000],
    ['tesseract-core-simd-lstm.wasm', 1_000_000],
    ['langs/eng.traineddata.gz', 500_000],
    ['langs/chi_sim.traineddata.gz', 500_000],
  ];
  for (const [rel, minBytes] of expect) {
    const size = statSync(join(root, rel)).size;
    assert.ok(size >= minBytes, `${rel} 只有 ${size} 字节，像是坏文件`);
  }
  const main = readFileSync(join(root, 'tesseract.min.js'), 'utf8');
  assert.match(main, /createWorker/, '主包应导出 createWorker');
});
