// §5.7 图片通道编排：把浮层的一次〔解析〕点击变成"加载引擎→识别→网格重建"。
// 全部重依赖（OCR 引擎、语言包）都在首次调用时才 dynamic import——
// 初始包与文字通道用户完全无感；vendor 文件由 P7 的 SW 运行时缓存兜底离线。
export async function imageHandler(dataUrl, hooks = {}) {
  const { onProgress = () => {} } = hooks;
  onProgress('加载识别引擎…');
  const { recognizeImage } = await import('./ocr.js');
  const { words, width, height } = await recognizeImage(dataUrl, onProgress);
  onProgress('还原课表网格…');
  const { itemsFromWords } = await import('./grid.js');
  const result = itemsFromWords(words, { width, height });
  // 词几乎没抓到 = 图根本没读出来，与"有词但网格没认出来"区分开，前者直接报错
  if (!result.items.length && !result.unparsed.length && result.gridFailed) {
    throw new Error('没能从图里读出文字，请换清晰、正向的课表截图');
  }
  return result;
}
