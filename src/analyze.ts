/**
 * 主体识别（纯前端、零模型、零网络）
 *
 * 目标不是「像素级抠图」，而是：给动效提供足够好的空间信息 ——
 *   1. 主体掩膜（用于分层：背景板 + 主体）
 *   2. 结构特征（包围盒 / 质心 / 脚底 pivot / 颈部 y / 注意力点）
 *   3. 置信度（低置信度时上层自动降级，绝不让用户卡在"识别失败"）
 *
 * 两条路径（实测结论见 动态封面-方案-v2.md）：
 *   - 纯色底（白底立绘 / 商品图 / 贴纸）：颜色众数定背景 → 颜色距离 → 距离图 Otsu
 *   - 复杂背景：RC-lite 显著性（多簇颜色对比 + 轻中心先验）→ Otsu → 剔除接近背景色的像素
 * 纯显著性的坑：白底占比大时"背景"自身对比度最高，掩膜会整个翻转，所以必须先判纯色底。
 */

export interface AnalyzeInput {
  data: Uint8ClampedArray | Uint8Array;
  w: number;
  h: number;
}

/** 手动框：归一化 x0,y0,x1,y1（相对画板） */
export type Roi = [number, number, number, number];

export interface Peak { x: number; y: number; v: number; }

export interface SubjectFeatures {
  /** 归一化到 0..1（相对图片矩形） */
  bbox: [number, number, number, number];
  cx: number;
  cy: number;
  feet: [number, number];
  neck: number;
  areaRatio: number;
  peaks: Peak[];
  rowW: number[];
}

export interface AnalyzeStats {
  path: 'uniform' | 'saliency';
  bgFrac: number;
  modeDev: number;
  otsu: number;
  blobs: number;
  kept: number;
  bg: [number, number, number];
  conf: number;
  tier: 'precise' | 'ok' | 'fallback';
  /** 掩膜沿框四边的覆盖率（仅当次分析有 roi 时存在；>0.5 说明框切断了主体） */
  touch?: { l: number; r: number; t: number; b: number } | null;
  /** 掩膜只能当"动效区域"、不能当剪影做景深分层（贴边 / 盖住大半幅） */
  region?: boolean;
}

export interface AnalyzeResult {
  w: number;
  h: number;
  mask: Uint8Array;
  soft: Float32Array;
  sal: Float32Array;
  feats: SubjectFeatures;
  stats: AnalyzeStats;
}

/* ---------------- 基础算子 ---------------- */

/** Otsu 自适应阈值（输入 0..1） */
export function otsu(vals: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < vals.length; i++) {
    hist[Math.max(0, Math.min(255, Math.round(vals[i] * 255)))]++;
  }
  const total = vals.length;
  if (!total) return 0.5;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i / 255; }
  }
  return thr;
}

/** 3×3 闭运算（先膨胀后腐蚀）两轮，填掉细缝 */
export function morphClose(mask: Uint8Array, w: number, h: number, rounds = 2): Uint8Array {
  const dilate = (m: Uint8Array) => {
    const o = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) o[ny * w + nx] = 1;
      }
    }
    return o;
  };
  const erode = (m: Uint8Array) => {
    const o = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      let keep = 1;
      for (let dy = -1; dy <= 1 && keep; dy++) for (let dx = -1; dx <= 1 && keep; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !m[ny * w + nx]) keep = 0;
      }
      o[y * w + x] = keep;
    }
    return o;
  };
  let m = mask;
  for (let i = 0; i < rounds; i++) m = erode(dilate(m));
  return m;
}

/**
 * 保留主连通域。
 * 贴边的「环形 / 细条」一律丢掉：原图外圈常有 1–2px 画布边、阴影、扫描线，
 * 它们在纯色底路径里与背景色差很大，会被误判成前景（实测会把 bbox 撑满整幅）。
 */
export function keepMainBlobs(mask: Uint8Array, w: number, h: number) {
  const label = new Int32Array(mask.length).fill(-1);
  const blobs: { id: number; area: number; touch: boolean; w: number; h: number }[] = [];
  const stack: number[] = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || label[p] >= 0) continue;
    const id = blobs.length;
    let area = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    stack.length = 0; stack.push(p);
    label[p] = id;
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % w, qy = (q / w) | 0;
      area++;
      if (qx < minX) minX = qx;
      if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy;
      if (qy > maxY) maxY = qy;
      if (qx > 0 && mask[q - 1] && label[q - 1] < 0) { label[q - 1] = id; stack.push(q - 1); }
      if (qx < w - 1 && mask[q + 1] && label[q + 1] < 0) { label[q + 1] = id; stack.push(q + 1); }
      if (qy > 0 && mask[q - w] && label[q - w] < 0) { label[q - w] = id; stack.push(q - w); }
      if (qy < h - 1 && mask[q + w] && label[q + w] < 0) { label[q + w] = id; stack.push(q + w); }
    }
    // 允许一点容差：闭运算会把贴边伪影往里推。容差按分辨率缩放（192² 时 2px）
    const tol = Math.max(2, Math.round(w / 96));
    const touch = minX <= tol || minY <= tol || maxX >= w - 1 - tol || maxY >= h - 1 - tol;
    blobs.push({ id, area, touch, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  if (!blobs.length) return { mask, blobs, kept: [] as number[] };
  const sorted = [...blobs].sort((a, b) => b.area - a.area);
  const maxA = sorted[0].area;
  const kept = sorted.filter(b => {
    if (b.area < maxA * 0.35) return false;
    const fill = b.area / (b.w * b.h);
    if (b.touch && (fill < 0.35 || b.w < w * 0.08 || b.h < h * 0.08)) return false;
    return true;
  }).map(b => b.id);
  const out = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) if (label[p] >= 0 && kept.includes(label[p])) out[p] = 1;
  return { mask: out, blobs, kept };
}

/** 填孔洞：从边界洪水标记真背景，剩下的背景像素（被前景包围）= 孔 → 补成前景。
 *  白底立绘的衣服高光常与背景同色，不填洞会被抠出麻点。 */
export function fillHoles(bin: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(bin.length);
  const stack: number[] = [];
  const push = (p: number) => { if (!bin[p] && !outside[p]) { outside[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const q = stack.pop()!;
    const qx = q % w, qy = (q / w) | 0;
    if (qx > 0) push(q - 1);
    if (qx < w - 1) push(q + 1);
    if (qy > 0) push(q - w);
    if (qy < h - 1) push(q + w);
  }
  const out = new Uint8Array(bin.length);
  for (let p = 0; p < bin.length; p++) out[p] = (bin[p] || !outside[p]) ? 1 : 0;
  return out;
}

/** 两遍 3×3 盒滤波羽化 */
export function feather(mask: Uint8Array | Float32Array, w: number, h: number, rounds = 2): Float32Array {
  let cur = Float32Array.from(mask as ArrayLike<number>);
  for (let r = 0; r < rounds; r++) {
    const next = new Float32Array(cur.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        s += cur[ny * w + nx]; n++;
      }
      next[y * w + x] = s / n;
    }
    cur = next;
  }
  return cur;
}

/* ---------------- 背景与显著性 ---------------- */

export interface BgEstimate {
  bg: [number, number, number];
  bgFrac: number;
  modeDev: number;
  binOf: Int32Array;
}

/** 背景色 = 全图颜色众数（比"外圈中位数"稳：外圈常混进画布边和阴影）
 *  keep 用来排除手动框内的像素：框内基本是主体，把主体色当背景就全错了。 */
export function estimateBackground(d: ArrayLike<number>, w: number, h: number, bins = 6, keep?: (p: number) => boolean): BgEstimate {
  const step = 256 / bins;
  const n = w * h;
  const hist = new Float64Array(bins ** 3);
  const sr = new Float64Array(bins ** 3), sg = new Float64Array(bins ** 3), sb = new Float64Array(bins ** 3);
  const binOf = new Int32Array(n).fill(-1);
  let total = 0;
  for (let p = 0; p < n; p++) {
    if (keep && !keep(p)) continue;
    total++;
    const i = p * 4;
    const k = (((Math.min(bins - 1, (d[i] / step) | 0) * bins) + Math.min(bins - 1, (d[i + 1] / step) | 0)) * bins)
      + Math.min(bins - 1, (d[i + 2] / step) | 0);
    binOf[p] = k; hist[k]++;
    sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2];
  }
  let modeK = 0;
  for (let k = 1; k < hist.length; k++) if (hist[k] > hist[modeK]) modeK = k;
  const cnt = hist[modeK] || 1;
  const bg: [number, number, number] = [sr[modeK] / cnt, sg[modeK] / cnt, sb[modeK] / cnt];
  let dev = 0;
  for (let p = 0; p < n; p++) {
    if (binOf[p] !== modeK) continue;
    const i = p * 4;
    dev += Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
  }
  return { bg, bgFrac: cnt / Math.max(1, total), modeDev: dev / cnt, binOf };
}

/** RC-lite 显著性：簇间颜色对比度加权 + 轻中心先验（0.65~1，避免把贴边立绘压掉） */
export function saliencyMap(d: ArrayLike<number>, w: number, h: number, bins = 5): Float32Array {
  const step = 256 / bins;
  const n = w * h;
  const cnt = new Float64Array(bins ** 3);
  const sr = new Float64Array(bins ** 3), sg = new Float64Array(bins ** 3), sb = new Float64Array(bins ** 3);
  const idx = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const k = (((Math.min(bins - 1, (d[i] / step) | 0) * bins) + Math.min(bins - 1, (d[i + 1] / step) | 0)) * bins)
      + Math.min(bins - 1, (d[i + 2] / step) | 0);
    idx[p] = k; cnt[k]++;
    sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2];
  }
  const clusters: { k: number; n: number; r: number; g: number; b: number }[] = [];
  for (let k = 0; k < cnt.length; k++) {
    if (!cnt[k]) continue;
    clusters.push({ k, n: cnt[k], r: sr[k] / cnt[k], g: sg[k] / cnt[k], b: sb[k] / cnt[k] });
  }
  const sal = new Float64Array(clusters.length);
  let max = 0;
  for (let i = 0; i < clusters.length; i++) {
    let s = 0;
    for (let j = 0; j < clusters.length; j++) {
      if (i === j) continue;
      const a = clusters[i], b = clusters[j];
      s += (b.n / n) * Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
    }
    sal[i] = s;
    if (s > max) max = s;
  }
  const table = new Map<number, number>();
  clusters.forEach((c, i) => table.set(c.k, sal[i] / (max || 1)));
  const out = new Float32Array(n);
  const cx = w / 2, cy = h / 2, sigma = Math.max(w, h) * 0.62, s2 = 2 * sigma * sigma;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    const g = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / s2);
    out[p] = (table.get(idx[p]) ?? 0) * (0.65 + 0.35 * g);
  }
  return out;
}

/* ---------------- 特征 ---------------- */

export function extractFeatures(mask: Uint8Array, w: number, h: number, sal: Float32Array): SubjectFeatures {
  let minX = w, minY = h, maxX = -1, maxY = -1, area = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    area++; sx += x; sy += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!area) {
    return { bbox: [0, 0, 1, 1], cx: 0.5, cy: 0.5, feet: [0.5, 0.98], neck: 0.3, areaRatio: 0, peaks: [], rowW: new Array(h).fill(0) };
  }
  const cx = sx / area, cy = sy / area;

  // 每行左右边界与宽度 → 判头脚、找颈部收缩点
  const rowW = new Array<number>(h).fill(0);
  const rowMid = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) { rowW[y] = r - l + 1; rowMid[y] = (l + r) / 2; }
  }

  // 颈部：bbox 上部 15%~55% 区间里宽度局部最小处（宽度突变点）
  const bh = maxY - minY;
  let neckY = minY + bh * 0.32;
  if (bh > 8) {
    const y0 = Math.round(minY + bh * 0.15), y1 = Math.round(minY + bh * 0.55);
    let bestVal = Infinity;
    for (let y = y0; y <= y1; y++) {
      const v = rowW[y];
      if (v > 0 && v < bestVal) { bestVal = v; neckY = y; }
    }
  }

  // 脚底：底边向上 8% 行的横向中点（比质心更稳，摇摆 pivot 用它）
  const footRows: number[] = [];
  for (let y = Math.max(0, maxY - Math.round(bh * 0.08)); y <= maxY; y++) if (rowW[y] > 0) footRows.push(rowMid[y]);
  const feetX = footRows.length ? footRows.reduce((a, b) => a + b, 0) / footRows.length : cx;

  // 注意力点：显著性局部极大值，NMS 半径 0.16 宽，最多 3 个
  const peaks: Peak[] = [];
  const cand: Peak[] = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    if (!mask[y * w + x]) continue;
    const v = sal[y * w + x];
    let isMax = true;
    for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2 && isMax; dx++) {
      if ((dx || dy) && sal[(y + dy) * w + (x + dx)] > v) isMax = false;
    }
    if (isMax) cand.push({ x, y, v });
  }
  cand.sort((a, b) => b.v - a.v);
  const minD = w * 0.16;
  for (const c of cand) {
    if (peaks.every(p => Math.hypot(p.x - c.x, p.y - c.y) > minD)) peaks.push(c);
    if (peaks.length >= 3) break;
  }

  return {
    bbox: [minX / w, minY / h, maxX / w, maxY / h],
    cx: cx / w, cy: cy / h,
    feet: [feetX / w, maxY / h],
    neck: neckY / h,
    areaRatio: area / (w * h),
    peaks: peaks.map(p => ({ x: p.x / w, y: p.y / h, v: p.v })),
    rowW,
  };
}

/** 置信度与档位：低置信度必须能被上层感知，否则用户会拿到一个「抠歪了」的封面 */
export function judgeQuality(feats: SubjectFeatures, path: 'uniform' | 'saliency', kept: number, blobs: number, touchMax = 0) {
  let conf = path === 'uniform' ? 0.82 : 0.54;
  const a = feats.areaRatio;
  const [x0, y0, x1, y1] = feats.bbox;
  const bw = Math.max(1e-3, x1 - x0), bh = Math.max(1e-3, y1 - y0);
  const fill = a / (bw * bh);
  if (fill < 0.25) conf -= 0.16;            // 包围盒里主体稀疏 → 掩膜碎
  if (kept > 1) conf -= 0.1;                 // 保留了多块 → 可能粘连
  if (blobs > 6) conf -= 0.06;
  if (x0 < 0.02 && x1 > 0.98 && y0 < 0.02 && y1 > 0.98) conf -= 0.24; // 撑满整幅 → 多半判反了
  if (feats.peaks.length === 0) conf -= 0.08;
  // 掩膜贴着框边：框切断了主体（或框内背景被当成主体），不能当作精确结果
  if (touchMax > 0.5) conf *= 0.78;
  else if (touchMax > 0.3) conf *= 0.9;
  if (a < 0.03 || a > 0.92) conf = Math.min(conf, 0.3);               // 太小/太大都不可信
  conf = Math.max(0, Math.min(0.98, conf));
  const tier: 'precise' | 'ok' | 'fallback' = conf >= 0.72 ? 'precise' : conf >= 0.45 ? 'ok' : 'fallback';
  return { conf, tier };
}

/* ---------------- 手动介入：特征重算 / 矩形掩膜 ---------------- */

/** 笔刷改过掩膜之后重算空间特征（只算几何，注意力点由调用方按新掩膜筛） */
export function featuresFromMask(mask: Uint8Array, w: number, h: number): SubjectFeatures {
  return extractFeatures(mask, w, h, new Float32Array(w * h));
}

/**
 * 框内兜底掩膜：羽化矩形。
 * 用在「框了但框内识别仍然不可信」的情况 —— 拿不到剪影，就退一步，
 * 保留包围盒/脚底这些几何信息，至少主体级动效（呼吸/漂浮/摇摆）还能成立。
 * feather 是羽化带宽（占短边比例）。
 */
export function rectSoftMask(w: number, h: number, roi: Roi, feather = 0.016): Float32Array {
  const out = new Float32Array(w * h);
  const [x0, y0, x1, y1] = roi;
  const fw = Math.max(1, feather * w), fh = Math.max(1, feather * h);
  for (let y = 0; y < h; y++) {
    const ny = (y + 0.5) / h;
    const dy = Math.min(ny - y0, y1 - ny) * h / fh;
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w;
      const dx = Math.min(nx - x0, x1 - nx) * w / fw;
      const d = Math.min(dx, dy);
      out[y * w + x] = Math.max(0, Math.min(1, (d + 1) / 2));
    }
  }
  return out;
}

/** 矩形掩膜的几何特征（不用跑连通域，直接由框算） */
export function rectFeatures(roi: Roi, w: number, h: number): SubjectFeatures {
  const [x0, y0, x1, y1] = roi;
  return {
    bbox: [x0, y0, x1, y1],
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    feet: [(x0 + x1) / 2, y1],
    neck: y0 + (y1 - y0) * 0.3,
    areaRatio: (x1 - x0) * (y1 - y0),
    peaks: [],
    rowW: new Array(h).fill(0),
  };
}

/* ---------------- 笔刷涂改（直接改掩膜 alpha） ---------------- */

/**
 * 沿一段轨迹涂改掩膜 alpha。
 * 擦除把 alpha 压低、补回把 alpha 抬高，笔尖带 30% 软边，避免出现锯齿台阶。
 * 直接在软掩膜上涂（而不是二值化后重算羽化），是因为反复涂改时
 * 「二值化 → 羽化」每笔都会再腐蚀一圈边缘，涂十笔主体就瘦没了。
 *
 * @param pts  轨迹点（像素坐标，至少 1 个）
 * @param r    笔刷半径（像素）
 * @returns    实际被改动（|Δα| > 0.02）的像素数
 */
export function paintMaskStroke(
  alpha: Float32Array, w: number, h: number,
  pts: Array<[number, number]>, r: number, erase: boolean,
): number {
  const R = Math.max(0.8, r);
  const fall = Math.max(0.75, R * 0.3);   // 软边宽度
  const step = Math.max(0.8, R * 0.35);   // 轨迹插值间距，防止快速拖动出现断点
  let changed = 0;

  const stamp = (cxIn: number, cyIn: number) => {
    const cx = cxIn, cy = cyIn;
    const x0 = Math.max(0, Math.floor(cx - R - fall)), x1 = Math.min(w - 1, Math.ceil(cx + R + fall));
    const y0 = Math.max(0, Math.floor(cy - R - fall)), y1 = Math.min(h - 1, Math.ceil(cy + R + fall));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d = Math.hypot(dx, dy);
        if (d > R + fall) continue;
        const t = d <= R ? 1 : Math.max(0, 1 - (d - R) / fall);
        const p = y * w + x;
        const before = alpha[p];
        const next = erase ? Math.min(before, 1 - t) : Math.max(before, t);
        if (Math.abs(next - before) > 0.02) changed++;
        alpha[p] = next;
      }
    }
  };

  if (pts.length === 1) {
    stamp(pts[0][0], pts[0][1]);
  } else {
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        stamp(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
  }
  return changed;
}

/* ---------------- 主流程 ---------------- */

export function analyzePixels({ data, w, h }: AnalyzeInput, bias = 1, roi: Roi | null = null): AnalyzeResult {
  const n = w * h;

  /* 手动框：把搜索范围锁在框内。框外一律当背景，
     顺带解决「贴边伪影」「画面里有多个主体」这两类误判。 */
  const box = roi ? {
    x0: Math.max(0, Math.floor(roi[0] * w)), y0: Math.max(0, Math.floor(roi[1] * h)),
    x1: Math.min(w - 1, Math.ceil(roi[2] * w)), y1: Math.min(h - 1, Math.ceil(roi[3] * h)),
  } : null;
  const inRoi = box
    ? (p: number) => { const x = p % w, y = (p / w) | 0; return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1; }
    : null;
  /* 背景色定义必须来自整幅图，不能用「框外像素」估。
     反例（实测）：JOJO 那种放射线背景，框外的众数和框内背景差很远，
     于是框内的背景被整片判成主体，掩膜胀成一块矩形 —— 用户看到的就是
     "一张清晰矩形贴在模糊背景上"。框只负责限制作用域，不负责重新定义背景。 */
  const est = estimateBackground(data, w, h);
  const [bgR, bgG, bgB] = est.bg;
  const distToBg = (p: number) => {
    const i = p * 4;
    return Math.hypot(data[i] - bgR, data[i + 1] - bgG, data[i + 2] - bgB);
  };

  const sal = saliencyMap(data, w, h);
  const thr = otsu(sal);
  const uniform = est.bgFrac > 0.28 && est.modeDev < 26;
  const alpha = new Float32Array(n);
  let path: 'uniform' | 'saliency' = uniform ? 'uniform' : 'saliency';

  if (uniform) {
    const dist = new Float32Array(n);
    let maxD = 1;
    for (let p = 0; p < n; p++) { dist[p] = distToBg(p); if (dist[p] > maxD) maxD = dist[p]; }
    const norm = new Float32Array(n);
    for (let p = 0; p < n; p++) norm[p] = dist[p] / maxD;
    const dThr = Math.max(0.08, otsu(norm) * bias);
    for (let p = 0; p < n; p++) alpha[p] = Math.max(0, Math.min(1, (norm[p] - dThr * 0.72) / (dThr * 0.75)));
  } else {
    for (let p = 0; p < n; p++) {
      const keep = sal[p] > thr * bias && distToBg(p) > 26;
      alpha[p] = keep ? Math.min(1, (sal[p] - thr) / (1 - thr) * 2.2) : 0;
    }
  }
  if (inRoi) for (let p = 0; p < n; p++) if (!inRoi(p)) alpha[p] = 0;

  // 显式标成宽松的 Uint8Array：TS 5.7 起 new Uint8Array() 推出 <ArrayBuffer>，
  // 而 morphClose/fillHoles/feather 返回 <ArrayBufferLike>，两者不能互相赋值（运行时无害）
  let bin: Uint8Array = new Uint8Array(n);
  for (let p = 0; p < n; p++) bin[p] = alpha[p] > 0.5 ? 1 : 0;
  /* 形态学按分辨率缩放：闭运算原来固定 2 遍（≈2px 结构元），那是按 192² 定的。
     换成 512² 后 2px 只占 0.39%，等于几乎不做闭运算 —— 掩膜会碎、会缩，
     实测 tier 从 precise 掉到 ok。所以这里按 w/192 放大遍数。 */
  const K = w / 192;
  bin = morphClose(bin, w, h, Math.max(2, Math.round(2 * K)));
  const blobbed = keepMainBlobs(bin, w, h);
  bin = fillHoles(blobbed.mask, w, h);

  const feathered = feather(bin, w, h, 2);
  const soft = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    // 细边靠原始 alpha（它比二值掩膜准），外扩靠 feathered 的 1.6 倍增益收回来
    let v = Math.min(alpha[p], feathered[p] * 1.6);
    /* 但**已经判定为主体的内部区域不能再用 alpha 挖回去**。
       alpha 只看"和背景色差多少"，主体身上颜色接近背景的部分（深色帽子、
       深色短裤、纯黑的眼睛）会被它判成背景，于是 min() 在主体中间开出洞。
       bin 已经过闭运算 + 补洞 + 主连通域，内部是可信的，以它为准。
       洞口留着的话，渲染时那里会透出背景板的补洞色 —— 用户看到的就是
       "主体上（以及主体边上一圈）有一块模糊"。 */
    if (feathered[p] > 0.75) v = Math.max(v, feathered[p]);
    soft[p] = Math.max(0, Math.min(1, v));
  }

  const feats = extractFeatures(bin, w, h, sal);

  /* 贴边检测：框把主体切断时，掩膜会顺着框边垂直切下去，四边覆盖率会很高。
     这种情况要降置信度（并让 UI 提示"框太紧"），否则会给出一个"看起来精确"的假结果。 */
  const touch = box ? edgeCoverage(bin, w, h, box) : null;
  const touchMax = touch ? Math.max(touch.l, touch.r, touch.t, touch.b) : 0;
  const q = judgeQuality(feats, path, blobbed.kept.length, blobbed.blobs.length, touchMax);

  /* 只在掩膜能当"剪影"时才允许做景深分层。
     三条判据（任一命中就只当"动效区域"）：
       1. 沿框边贴住：框把主体切断了
       2. 盖住大半幅：多半判反了
       3. bbox 里几乎实心（fill 高）：人形剪影的 bbox 里必然有空隙，
          一个"实心矩形块"说明主体周围一圈背景被一起算进来了 ——
          拿它分层就会得到"一块清晰矩形贴在背景上"（用户报的 bug）。 */
  const bw = Math.max(1e-3, feats.bbox[2] - feats.bbox[0]);
  const bh = Math.max(1e-3, feats.bbox[3] - feats.bbox[1]);
  const fill = feats.areaRatio / (bw * bh);
  const region = touchMax > 0.32 || feats.areaRatio > 0.62 || (fill > 0.82 && feats.areaRatio > 0.12);

  /* 区域模式下把边缘放软：形变区域与静止背景之间要有个过渡，不然边界是一条硬边。
     但**不能太软** —— 羽化带里叠的是"位移后的主体"和"没动的背景"，带越宽重影越明显、
     看起来就是"主体边上有一圈模糊"。4 遍（约 28px@1080）实测太宽，
     改成 2 遍 + smoothstep 把过渡带再压一半，落在 10px 左右。 */
  if (region) {
    const softer = feather(bin, w, h, 2);
    for (let p = 0; p < n; p++) {
      const t = Math.max(0, Math.min(1, (softer[p] - 0.22) / 0.56));
      soft[p] = Math.max(0, Math.min(1, Math.min(alpha[p], t * t * (3 - 2 * t))));
    }
  }

  return {
    w, h, mask: bin, soft, sal, feats,
    stats: {
      path, bgFrac: est.bgFrac, modeDev: est.modeDev, otsu: thr,
      blobs: blobbed.blobs.length, kept: blobbed.kept.length,
      bg: [Math.round(bgR), Math.round(bgG), Math.round(bgB)],
      conf: q.conf, tier: q.tier, touch, region,
    },
  };
}

/** 掩膜沿框四条内侧 2px 带的覆盖率（1 = 整条边都被掩膜贴住，说明主体被切断） */
function edgeCoverage(
  bin: Uint8Array, w: number, h: number,
  box: { x0: number; y0: number; x1: number; y1: number },
) {
  const band = 2;
  const frac = (x0: number, y0: number, x1: number, y1: number) => {
    let on = 0, all = 0;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
        all++; if (bin[y * w + x]) on++;
      }
    }
    return all ? on / all : 0;
  };
  return {
    l: frac(box.x0, box.y0, box.x0 + band - 1, box.y1),
    r: frac(box.x1 - band + 1, box.y0, box.x1, box.y1),
    t: frac(box.x0, box.y0, box.x1, box.y0 + band - 1),
    b: frac(box.x0, box.y1 - band + 1, box.x1, box.y1),
  };
}

/* ---------------- DOM 适配：图片 → 掩膜 dataURL + SubjectInfo ---------------- */

/* 分割分辨率。所有阈值 / 形态学参数（闭运算遍数、贴边容差、连通域占比）都是按它调过的，
   改动会让识别结果整体漂移 —— 实测 512² 下主体头部会被判成独立连通域丢掉，tier 从 precise 掉到 ok。
   所以这里只管"分割得准不准"，边缘清不清晰交给下面的 MASK_SIZE。 */
export const ANALYZE_SIZE = 192;

/* 掩膜输出分辨率。192² 的掩膜放大到 1080 画板是 5.6 倍，1px 抗锯齿会变成 5.6px 的浅色毛边，
   看起来就是"主体边上有一圈模糊"。这里在**不收窄过渡带的前提下**把掩膜抬到 512²：
   先在 192² 空间把 alpha 沿 0.35~0.65 收紧（过渡带 1.5px → 0.8px），再双线性上采样，
   于是 1080 下边缘过渡从 ~17px 降到 ~4px，且不产生台阶。 */
export const MASK_SIZE = 512;

/**
 * 掩膜精修：192² 软掩膜 → 边缘更窄、更平滑的 512² 掩膜。
 * 收紧必须在**原分辨率**做（在上采样后做只是重映射，宽度不变），再上采样才不会出锯齿。
 */
export function refineMask(soft: Float32Array, w: number, h: number, W2: number, H2: number): Float32Array {
  // 1) 原分辨率收紧过渡带
  const tight = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const t = Math.max(0, Math.min(1, (soft[p] - 0.35) / 0.30));
    tight[p] = t * t * (3 - 2 * t);
  }
  // 2) 双线性上采样
  const out = new Float32Array(W2 * H2);
  const sx = w / W2, sy = h / H2;
  for (let y = 0; y < H2; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W2; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = tight[y0 * w + x0], b = tight[y0 * w + x1];
      const c = tight[y1 * w + x0], d = tight[y1 * w + x1];
      out[y * W2 + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** 把软掩膜画成一张白底带 alpha 的 PNG（体积很小，192² 通常 < 8KB） */
export function maskToDataUrl(soft: Float32Array, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    const a = Math.round(soft[p] * 255);
    img.data[p * 4] = 255;
    img.data[p * 4 + 1] = 255;
    img.data[p * 4 + 2] = 255;
    img.data[p * 4 + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

export interface AnalyzeImageResult {
  maskUrl: string;
  subject: {
    maskUrl: string; mw: number; mh: number;
    bbox: [number, number, number, number];
    cx: number; cy: number; feet: [number, number]; neck: number;
    peaks: Peak[]; conf: number; tier: 'precise' | 'ok' | 'fallback';
    source: 'local' | 'remote';
    path?: 'uniform' | 'saliency';
    roi?: Roi;
    seed: string;
    manual?: boolean;
    /** 掩膜用途：cut=可做景深分层，region=只当动效作用区域（见 SubjectInfo.fit） */
    fit?: 'cut' | 'region';
  };
  stats: AnalyzeStats;
}

/** 掩膜指纹：只用于让渲染层知道"该不该重建缓存"，不需要唯一性 */
function makeSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * 在低分辨率上分析（成本恒定），掩膜再放大使用。
 *
 * 取景必须与渲染端一致（cover 裁切），否则非 1:1 图源的掩膜会和画面错位：
 * 渲染是 max(w/iw, h/ih) 缩放后居中裁切，这里照抄同一套数学。
 *
 * bias > 1 更保守（只留最确定的主体），< 1 更宽松（连浅色细节一起收）
 * roi 给定时只在框内找主体，框内结果仍不可信则由上层退到矩形掩膜
 */
export function analyzeImage(
  img: CanvasImageSource, naturalW: number, naturalH: number,
  size = ANALYZE_SIZE, bias = 1, roi: Roi | null = null,
): AnalyzeImageResult {
  const S = size;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const sc = Math.max(S / Math.max(1, naturalW), S / Math.max(1, naturalH));
  const dw = naturalW * sc, dh = naturalH * sc;
  ctx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
  const data = ctx.getImageData(0, 0, S, S).data;
  const r = analyzePixels({ data, w: S, h: S }, bias, roi);
  /* 掩膜按 MASK_SIZE 出图：分割在 192² 上准了，边缘还得够细，
     否则放大到 1080 就是一圈 5.6px 的浅色毛边。 */
  const softHi = refineMask(r.soft, S, S, MASK_SIZE, MASK_SIZE);
  const maskUrl = maskToDataUrl(softHi, MASK_SIZE, MASK_SIZE);
  return {
    maskUrl,
    subject: {
      maskUrl, mw: MASK_SIZE, mh: MASK_SIZE,
      bbox: r.feats.bbox, cx: r.feats.cx, cy: r.feats.cy,
      feet: r.feats.feet, neck: r.feats.neck,
      peaks: r.feats.peaks, conf: r.stats.conf, tier: r.stats.tier,
      source: 'local', path: r.stats.path,
      roi: roi ?? undefined, seed: makeSeed(),
      fit: r.stats.region ? 'region' : 'cut',
    },
    stats: r.stats,
  };
}

/**
 * 手动框的兜底识别：框内跑识别，结果不够可信就退成羽化矩形。
 * 返回的 tier 至少是 ok（矩形掩膜能支撑主体级动效），并标 manual。
 * 矩形掩膜一律标 `fit:'region'` —— 它绝不能当剪影去做景深分层，
 * 否则整块框会变成"一张清晰的矩形贴片"，框外一片糊。
 */
export function analyzeWithRoi(img: CanvasImageSource, naturalW: number, naturalH: number, roi: Roi, bias = 1) {
  const r = analyzeImage(img, naturalW, naturalH, ANALYZE_SIZE, bias, roi);
  if (r.subject.tier !== 'fallback') {
    return { ...r, subject: { ...r.subject, manual: true }, mode: 'mask' as const };
  }
  const S = ANALYZE_SIZE;
  const soft = rectSoftMask(S, S, roi, 0.07);
  const url = maskToDataUrl(refineMask(soft, S, S, MASK_SIZE, MASK_SIZE), MASK_SIZE, MASK_SIZE);
  const feats = rectFeatures(roi, S, S);
  return {
    maskUrl: url,
    subject: {
      maskUrl: url, mw: MASK_SIZE, mh: MASK_SIZE,
      bbox: feats.bbox, cx: feats.cx, cy: feats.cy,
      feet: feats.feet, neck: feats.neck,
      peaks: [] as Peak[],
      conf: Math.max(0.5, r.subject.conf),
      tier: 'ok' as const,
      source: 'local' as const,
      roi, seed: makeSeed(), manual: true,
      fit: 'region' as const,
    },
    stats: { ...r.stats, region: true },
    mode: 'rect' as const,
  };
}

/** 置信度三档 → 允许的动效能力（渲染与 UI 都按这个门控） */
export const TIER_ABILITY: Record<'precise' | 'ok' | 'fallback', { subject: boolean; local: boolean; rim: boolean }> = {
  precise: { subject: true, local: true, rim: true },
  ok: { subject: true, local: false, rim: false },
  fallback: { subject: false, local: false, rim: false },
};
