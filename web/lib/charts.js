// 图表元件：全部手写 SVG/CSS，不引第三方库（DEV_PLAN S8）。
// 每个元件都拆成两层——纯几何函数（数值→角度/长度，可在无浏览器环境里直接断言）
// 与渲染函数（把几何结果包成节点）。视图只调渲染函数，算式不留第二份。
// 图形一律 aria-hidden：读屏拿到的是旁边的数字与图例，图表只是同一批数字的另一副面孔。
import { h, svg } from './dom.js';

/** 热力格的四档取值；"未来"不是完成度，单独用 data-future 表达。 */
export const HEAT_STATES = ['done', 'partial', 'missed', 'none'];

const PALETTE = ['#3DD6F5', '#FF8A3D', '#4ADE80', '#A78BFA', '#F2555A', '#38BDF8', '#FACC15', '#8FA3C0'];

export const chartColor = (index) => PALETTE[Math.abs(Number(index) || 0) % PALETTE.length];

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** 进度环：半径是描边中心线，周长换算成 dash 长度，越界的值先夹住再画。 */
export function ringMetrics(value, radius = 40) {
  const r = num(radius) || 40;
  const circumference = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(100, num(value))) / 100;
  return { radius: r, circumference, dash: circumference * ratio, gap: circumference * (1 - ratio), ratio };
}

/**
 * 进度环。value 为 0–100；state 只影响配色（low/ok/warn），不参与算式。
 */
export function progressRing(value, { label = '', caption = '', unit = '%', radius = 40, stroke = 8, state = '' } = {}) {
  const metrics = ringMetrics(value, radius);
  const size = (metrics.radius + stroke) * 2;
  const center = size / 2;
  const shown = Math.round(num(value));
  const element = h('div.ring', { class: state ? `is-${state}` : '' },
    svg('svg.ring-svg', {
      viewBox: `0 0 ${size} ${size}`, width: '100%', height: '100%', 'aria-hidden': 'true',
    },
      svg('circle.ring-track', { cx: center, cy: center, r: metrics.radius, 'stroke-width': stroke }),
      svg('circle.ring-value', {
        cx: center, cy: center, r: metrics.radius, 'stroke-width': stroke, 'stroke-linecap': 'round',
        'stroke-dasharray': `${metrics.dash} ${metrics.gap}`,
        transform: `rotate(-90 ${center} ${center})`,
      }),
    ),
    h('div.ring-label', {},
      h('span', { text: `${shown}${unit}` }),
      caption ? h('small', { text: caption }) : null,
    ),
  );
  element.dataset.chart = 'ring';
  if (label) element.setAttribute('title', `${label} ${shown}${unit}`);
  return element;
}

/** 环形分量图的分扇：按数值占比切整圈，零值不占角度也不进图例。 */
export function donutArcs(slices, { valueKey = 'minutes' } = {}) {
  const usable = (slices ?? []).filter((item) => num(item?.[valueKey]) > 0);
  const total = usable.reduce((sum, item) => sum + num(item[valueKey]), 0);
  if (!total) return [];
  let acc = 0;
  return usable.map((item, index) => {
    const from = acc;
    acc += (num(item[valueKey]) / total) * 360;
    return {
      ...item, index, color: chartColor(index), from,
      to: index === usable.length - 1 ? 360 : acc,
      percent: Math.round((num(item[valueKey]) / total) * 100),
    };
  });
}

/**
 * 分量环 + 图例。最后一扇硬收到 360°，浮点误差不给它在环上留一条缝。
 */
export function donut(slices, { unit = '分钟', emptyHint = '这个区间还没有可统计的时长', caption = '' } = {}) {
  const arcs = donutArcs(slices, { valueKey: 'minutes' });
  if (!arcs.length) return h('div.chart-empty', { text: emptyHint });
  const radius = 40;
  const stroke = 16;
  const size = (radius + stroke) * 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const total = arcs.reduce((sum, arc) => sum + arc.minutes, 0);
  const element = h('div.donut', { style: { '--donut-color': arcs[0].color } },
    svg('svg.donut-svg', { viewBox: `0 0 ${size} ${size}`, width: '100%', height: '100%', 'aria-hidden': 'true' },
      svg('circle.ring-track', { cx: center, cy: center, r: radius, 'stroke-width': stroke }),
      ...arcs.map((arc) => {
        const length = (arc.to - arc.from) / 360 * circumference;
        return svg('circle.donut-arc', {
          cx: center, cy: center, r: radius, 'stroke-width': stroke, stroke: arc.color,
          'stroke-dasharray': `${length} ${circumference - length}`,
          'stroke-dashoffset': String(-arc.from / 360 * circumference),
          transform: `rotate(-90 ${center} ${center})`,
        });
      }),
    ),
    h('div.donut-center-num', {},
      h('span', { text: String(total) }),
      h('small', { text: unit }),
    ),
    h('ul.donut-legend',
      ...arcs.map((arc) => h('li.legend-item', { style: { '--dot-color': arc.color } },
        h('i.dot'),
        h('span.name', { text: arc.type }),
        h('span.val', { text: `${arc.minutes} ${unit}` }),
        h('span.pct', { text: `${arc.percent}%` }),
      )),
    ),
  );
  element.dataset.chart = 'donut';
  if (caption) element.appendChild(h('div.chart-caption.tiny.faint', { text: caption }));
  return element;
}

/** 柱状几何：最高一根占满绘图高度，全零（或没有数据）时高度一律 0 而不是除零得到的 NaN。 */
export function barGeometry(rows, { valueKey = 'value', height = 100 } = {}) {
  const list = rows ?? [];
  const values = list.map((row) => Math.max(0, num(row?.[valueKey])));
  const max = values.length ? Math.max(...values) : 0;
  return list.map((row, index) => ({
    label: String(row?.label ?? ''),
    value: values[index],
    height: max ? Math.round((values[index] / max) * num(height)) : 0,
    index,
  }));
}

/** 柱状系列：高度按最高一根归一化，数值与标签都是真文字，不糊在图里。 */
export function barSeries(rows, { valueKey = 'minutes', height = 100, unit = ' 分', caption = '' } = {}) {
  const bars = barGeometry(rows, { valueKey, height });
  if (!bars.length) return h('div.chart-empty', { text: '还没有可比较的区间' });
  const element = h('div.bar-series', { 'aria-hidden': 'true' },
    ...bars.map((bar) => h('div.bar-col',
      h('span.bar-value.tiny', { text: bar.value ? `${bar.value}` : '·' }),
      h('div.bar-slot', { style: { height: `${height}px` } },
        h('i.bar-fill', { style: { height: `${bar.height}px` }, dataset: { value: bar.value } }),
      ),
      h('span.bar-label.tiny.faint', { text: bar.label }),
    )),
  );
  element.dataset.chart = 'bars';
  element.setAttribute('title', `${unit ? `单位：${unit.trim()}` : ''}${caption ? ` · ${caption}` : ''}`);
  return element;
}

const HEAT_LEVEL = (minutes) => (num(minutes) >= 60 ? '3' : num(minutes) >= 30 ? '2' : '1');

/**
 * 热力格：一列一周、周一在上。缺练用红色档而不是留空——"没练"本身就是数据。
 * onPick(date) 传了就给每格加一个"去记这笔"的入口。
 */
export function heatGrid(columns, { today, minutesByDate, onPick } = {}) {
  const cells = [];
  for (const column of columns ?? []) {
    for (const cell of column.days) {
      const state = cell.future ? 'future' : HEAT_STATES.includes(cell.status) ? cell.status : 'none';
      const minutes = num(minutesByDate?.get?.(cell.date) ?? 0);
      const level = cell.status === 'missed' ? 'missed' : cell.status ? HEAT_LEVEL(minutes) : 'none';
      const label = `${cell.date} · ${state === 'none' ? '无记录' : state === 'future' ? '还没到' : state === 'missed' ? '缺练' : state === 'partial' ? '部分完成' : '完成'}${minutes ? ` ${minutes} 分钟` : ''}`;
      const node = h('i', {
        dataset: { date: cell.date, state, level, future: cell.future ? '1' : '' },
        title: label,
      });
      if (onPick && !cell.future) {
        node.classList.add('pickable');
        node.addEventListener('click', () => onPick(cell.date));
      }
      cells.push(node);
    }
  }
  const element = h('div.heat', { 'aria-hidden': 'true' }, ...cells);
  element.dataset.chart = 'heat';
  if (today) element.setAttribute('title', `近 ${(columns ?? []).length} 周训练热力，截至 ${today}`);
  return element;
}

/** 图表配套的文字读数：图形 aria-hidden，这些数字就是它的替代文本。 */
export function chartCaption(text) {
  return h('div.chart-caption.tiny.faint', { text });
}
