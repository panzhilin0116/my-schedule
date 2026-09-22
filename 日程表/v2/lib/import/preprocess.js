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
