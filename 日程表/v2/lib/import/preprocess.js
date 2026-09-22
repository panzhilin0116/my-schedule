// §5.7 P4 预处理：纯像素函数放这里（node 可测），Canvas/Image 胶水留在 ocr.js。
// 目标：把手机截图/网页截图压成"灰度 + 对比度拉伸"的单通道友好输入，
// 提升 Tesseract 对彩色底纹教务课表的识别率。全程内存内计算，无网络。

export const MAX_SIDE = 2000;

/** RGBA 单像素亮度（Rec.601）。 */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 超大图等比缩到最长边 ≤ maxSide；小图不放大。返回 { scale, width, height }。 */
export function planResize(width, height, maxSide = MAX_SIDE) {
  const longest = Math.max(width, height);
  const scale = longest > maxSide ? maxSide / longest : 1;
  return {
    scale,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** RGBA 缓冲 → 灰度 Uint8Array（逐像素）。 */
export function toGray(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = Math.round(luma(rgba[p], rgba[p + 1], rgba[p + 2]));
  }
  return out;
}

/**
 * 对比度拉伸：取 1% / 99% 分位做黑白场，线性映射到 0–255。
 * 彩色课表底色（浅黄/浅绿）会被推向白，字色推向黑；无信号时原样返回。
 */
export function stretchGray(gray) {
  const n = gray.length;
  if (!n) return gray;
  const sorted = Uint8Array.from(gray).sort();
  const lo = sorted[Math.floor(n * 0.01)];
  const hi = sorted[Math.min(n - 1, Math.ceil(n * 0.99))];
  if (hi - lo < 24) return gray; // 几乎没有动态范围，不动
  const scale = 255 / (hi - lo);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = (gray[i] - lo) * scale;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

/** 灰度均值低于此值判定"整体是深底"（白字黑底截图），需要反相再识别。 */
export const DARK_MEAN_THRESHOLD = 110;

export function meanGray(gray) {
  if (!gray.length) return 255;
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) sum += gray[i];
  return sum / gray.length;
}

/** 白字黑底 → 反相为黑字白底；否则原样返回。 */
export function invertIfDarkBackground(gray) {
  if (meanGray(gray) >= DARK_MEAN_THRESHOLD) return gray;
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = 255 - gray[i];
  return out;
}

/**
 * 整条预处理链（与顺序有关）：灰度 → 拉伸 → 深底反相 → 再拉伸一次
 * （反相后黑白场对调，第二次拉伸修复深底图的对比度）。
 */
export function preprocessGray(rgba, width, height) {
  let g = toGray(rgba, width, height);
  g = stretchGray(g);
  g = invertIfDarkBackground(g);
  return stretchGray(g);
}

/** 灰度缓冲 → RGBA 缓冲（Tesseract 接受任意等尺寸输入，统一回传格式）。 */
export function grayToRgba(gray, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    out[p] = out[p + 1] = out[p + 2] = gray[i];
    out[p + 3] = 255;
  }
  return out;
}

export function invertGray(gray) {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = 255 - gray[i];
  return out;
}

/** 极性修正：字（墨）永远是少数派——近黑像素比近白像素多 = 深底白字 → 反相成黑字白底；
 *  否则原样。彩底块拉伸后底色推向一极、字推向另一极，用两极的数量对比判断最稳。 */
export function polarityToDarkText(gray) {
  let dark = 0;
  let light = 0;
  for (let i = 0; i < gray.length; i += 1) {
    if (gray[i] < 64) dark += 1;
    else if (gray[i] > 192) light += 1;
  }
  return dark > light ? invertGray(gray) : gray;
}

// 彩底白字课程块检测：整图反相补跑对"浅彩底"救不全（拉伸后白字仍糊），
// 加强档按块裁剪放大逐块识别——这里先把像素里的高饱和色块圈出来。
export const BLOCK_CELL = 8; // 下采样格边长（像素）
export const BLOCK_MIN_SAT = 60; // 组内 max-min 均值超过此值才算"有彩色"
export const BLOCK_MIN_RATIO = 0.25; // 彩色像素占包围盒比例下限，滤噪点
export const BLOCK_MIN_SIDE = 32; // 下限略大于单格噪声盒（24px），图标/噪点不进来，真实课程块远大于此

/** RGBA → 彩色格掩码（每格组内平均 max-min 饱和 > 阈值）。 */
export function colorCellMask(rgba, width, height, cell = BLOCK_CELL, minSat = BLOCK_MIN_SAT) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const mask = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      let sum = 0;
      let n = 0;
      for (let y = gy * cell; y < Math.min((gy + 1) * cell, height); y += 1) {
        for (let x = gx * cell; x < Math.min((gx + 1) * cell, width); x += 1) {
          const p = (y * width + x) * 4;
          const mx = Math.max(rgba[p], rgba[p + 1], rgba[p + 2]);
          const mn = Math.min(rgba[p], rgba[p + 1], rgba[p + 2]);
          sum += mx - mn;
          n += 1;
        }
      }
      if (n && sum / n > minSat) mask[gy * cols + gx] = 1;
    }
  }
  return { mask, cols, rows };
}

/** 彩色块探测：下采样掩码 → 4 邻接连通块 → 原图坐标系矩形（带 1 格外扩捞到边缘字）。 */
export function findColorBlocks(rgba, width, height, opts = {}) {
  const { cell = BLOCK_CELL, minSat = BLOCK_MIN_SAT, minRatio = BLOCK_MIN_RATIO, minSide = BLOCK_MIN_SIDE } = opts;
  const { mask, cols, rows } = colorCellMask(rgba, width, height, cell, minSat);
  const seen = new Uint8Array(mask.length);
  const blocks = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || seen[i]) continue;
    seen[i] = 1;
    const queue = [i];
    let count = 0;
    let minX = cols;
    let maxX = -1;
    let minY = rows;
    let maxY = -1;
    while (queue.length) {
      const cur = queue.pop();
      count += 1;
      const cx = cur % cols;
      const cy = (cur - cx) / cols;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (const nb of [cur - cols, cur + cols, cx > 0 ? cur - 1 : -1, cx < cols - 1 ? cur + 1 : -1]) {
        if (nb >= 0 && nb < mask.length && mask[nb] && !seen[nb]) {
          seen[nb] = 1;
          queue.push(nb);
        }
      }
    }
    const boxCells = (maxX - minX + 1) * (maxY - minY + 1);
    if (count / boxCells < minRatio) continue;
    const x0 = Math.max(0, (minX - 1) * cell);
    const y0 = Math.max(0, (minY - 1) * cell);
    const x1 = Math.min(width, (maxX + 2) * cell);
    const y1 = Math.min(height, (maxY + 2) * cell);
    if (x1 - x0 < minSide || y1 - y0 < minSide) continue;
    blocks.push({ x0, y0, x1, y1 });
  }
  return blocks;
}
