import type { Doc, TextLayer, BgLayer, ImageLayer, Layer, CoverFx } from './doc';
import { FONT_STACKS, isText, isBg, isImage, isCover, coverLayer, defaultCoverFx } from './doc';
import { layerProps, charAlpha, charOffset, visibleChars, caretAlpha } from './anim';
import { fxAt, sweepPhase, glowPulse, vinylAngle } from './imagefx';
import { subjectXform, plateXform, headXform, rimState, peakPulse, coverTime,
  sceneXform, sweepBand, dustCount, dustParticle, beatEnv, frameXform,
  flashPulse, glitchState, glitchSlices, flashRectOf, flashFeatherPx } from './coverfx';
import { TIER_ABILITY } from './analyze';

interface CharPos {
  ch: string;
  cx: number;
  cy: number;
  w: number;
  line: number;
}

export interface Layout {
  chars: CharPos[];
  lineCount: number;
  lineH: number;
  blockW: number;
  blockH: number;
}

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF5E\u3000-\u303F\u2018-\u201D]/;
const NO_LINE_START = '，。！？；：、）》」』%…·,.;:!?)]}»›';

function tokenize(text: string): string[] {
  const units: string[] = [];
  let buf = '';
  const flush = () => { if (buf) { units.push(buf); buf = ''; } };
  for (const ch of text) {
    if (CJK_RE.test(ch)) { flush(); units.push(ch); }
    else if (/\s/.test(ch)) { flush(); units.push(' '); }
    else if (/[A-Za-z0-9'’\-%$#@&+=/_]/.test(ch)) { buf += ch; }
    else { flush(); units.push(ch); }
  }
  flush();
  return units;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function canvas2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
}

/** 背景板外扩量（画板像素）。
 *
 *  背景板需要能"纯平移"而不露出画板边，否则就只能靠放大来遮边 ——
 *  而放大等于把烘在背景板里的擦除区一起放大，主体四周就会甩出一圈补洞色。
 *  外扩 36px ≈ 3.3% 画板，覆盖最大视差位移（≈6px）绰绰有余；
 *  外扩带用边缘 1px 拉伸生成，只在平移把画板推到边上时才可能被看到。 */
const PLATE_MARGIN = 36;

export class Renderer {
  doc: Doc;
  private ctx: CanvasRenderingContext2D;
  private mctx: CanvasRenderingContext2D;
  private cache = new Map<string, { key: string; layout: Layout }>();

  /** 图片解码缓存 / 预处理缓存 / 背景虚化缓存（都按图层 id 索引，key 变化即重建） */
  private imgs = new Map<string, { img: HTMLImageElement; sig: string }>();
  private preps = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private bgs = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  /** 图片解码完成后通知外部重绘（异步加载，不阻塞首帧） */
  onNeedsRender: (() => void) | null = null;

  constructor(private canvasEl: HTMLCanvasElement) {
    this.ctx = canvasEl.getContext('2d')!;
    const mc = document.createElement('canvas');
    this.mctx = mc.getContext('2d')!;
    this.doc = { version: 1, canvas: { w: 1080, h: 1920, bg: '#101418' }, duration: 4200, layers: [] };
  }

  setDoc(doc: Doc) {
    this.doc = doc;
    this.applySize();
    // 画布尺寸变化后布局缓存失效
    this.cache.clear();
  }

  get canvas(): HTMLCanvasElement { return this.canvasEl; }

  /* ---------- 渲染分辨率（预览用低分辨率，导出用 doc 原分辨率） ---------- */

  /**
   * 预览缩放：0.2~1。1 = 按 doc 原分辨率渲染（导出必须是 1）。
   *
   * 为什么要有它：1080 的画板在 732px 的舞台里显示时，按 1080 渲染等于每帧多画
   * 2.2 倍像素再让浏览器缩下去 —— 纯浪费。低功耗设备上这是实打实的耗电与发热。
   *
   * 代价：**所有绘制必须用 doc 坐标**，靠 ctx 变换缩放。任何"读 canvas.width 反推
   * 文档尺寸"或"drawImage 不写尺寸"的写法都会失真 —— 目前只有切片错位那处整幅复制
   * 需要显式给目标尺寸（已改）。
   */
  private renderScale = 1;
  private sx = 1;
  private sy = 1;
  private lastT = 0;

  get renderScaleValue(): number { return this.renderScale; }

  /** 重设 canvas 后备尺寸 = doc 尺寸 × renderScale，并记下实际两轴比例（取整会略差） */
  private applySize(): void {
    const c = this.doc.canvas;
    const cw = Math.max(1, Math.round(c.w * this.renderScale));
    const ch = Math.max(1, Math.round(c.h * this.renderScale));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.sx = cw / c.w;
    this.sy = ch / c.h;
  }

  /** 设置预览缩放；返回是否真的变了（调用方据此决定要不要补一帧） */
  setRenderScale(s: number): boolean {
    const v = Math.max(0.2, Math.min(1, Number.isFinite(s) ? s : 1));
    if (Math.abs(v - this.renderScale) < 0.005) return false;
    this.renderScale = v;
    this.applySize();
    return true;
  }

  private measure(ch: string, size: number, font: string, ls: number): number {
    this.mctx.font = `400 ${size}px ${font}`;
    return this.mctx.measureText(ch).width + (ch === ' ' ? 0 : ls);
  }

  getLayout(layer: TextLayer): Layout {
    const s = layer.style;
    const key = JSON.stringify([layer.text, s]);
    const hit = this.cache.get(layer.id);
    if (hit && hit.key === key) return hit.layout;

    const font = FONT_STACKS[s.font];
    const lineH = s.size * s.lineHeight;
    const lines: { ch: string; w: number }[][] = [];

    for (const para of layer.text.split('\n')) {
      let line: { ch: string; w: number }[] = [];
      let lineW = 0;
      const flush = () => { lines.push(line); line = []; lineW = 0; };
      for (const u of tokenize(para)) {
        const chars = [...u].map(ch => ({ ch, w: this.measure(ch, s.size, font, s.letterSpacing) }));
        const uw = chars.reduce((a, c) => a + c.w, 0);
        if (uw > s.boxWidth && line.length === 0 && chars.length > 1) {
          // 超长不可断单元（如无空格长英文串）：按字符硬断，防止溢出画布
          for (const c of chars) {
            if (lineW + c.w > s.boxWidth && line.length > 0) flush();
            line.push(c);
            lineW += c.w;
          }
          continue;
        }
        if (lineW + uw > s.boxWidth && line.length > 0 && !NO_LINE_START.includes(u[0])) flush();
        for (const c of chars) { line.push(c); lineW += c.w; }
      }
      flush();
    }

    const chars: CharPos[] = [];
    lines.forEach((lc, i) => {
      const lineW = lc.reduce((a, c) => a + c.w, 0);
      let startX = s.align === 'center' ? (s.boxWidth - lineW) / 2 : s.align === 'right' ? s.boxWidth - lineW : 0;
      let cx = startX;
      for (const c of lc) {
        chars.push({
          ch: c.ch,
          cx: s.x - s.boxWidth / 2 + cx + c.w / 2,
          cy: s.y - lines.length * lineH / 2 + (i + 0.5) * lineH,
          w: c.w,
          line: i,
        });
        cx += c.w;
      }
    });

    const layout: Layout = { chars, lineCount: lines.length, lineH, blockW: s.boxWidth, blockH: lines.length * lineH };
    this.cache.set(layer.id, { key, layout });
    return layout;
  }

  renderAt(t: number) {
    const { ctx, doc } = this;
    const w = doc.canvas.w, h = doc.canvas.h;
    this.lastT = t;
    // 清整块后备缓冲（不能按 doc 尺寸清：缩放后两者不等）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 之后一律用 doc 坐标绘制，缩放交给变换
    ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0);
    if (isCover(doc)) { this.drawCover(ctx, doc, t, w, h); return; }
    const firstImageId = (doc.layers.find(isImage) as ImageLayer | undefined)?.id ?? null;
    for (const layer of doc.layers) {
      if (isBg(layer)) this.drawBg(ctx, layer, t, w, h);
      else if (isText(layer)) this.drawText(ctx, layer, t, w, h);
      else if (isImage(layer)) this.drawImageLayer(ctx, layer, t, w, h, layer.id === firstImageId);
    }
  }

  /* ---------- 封面模式（v0.7）：背景板 + 主体分层 ---------- */

  /** 封面用的三张预烘焙画布：锐利原图 / 背景板 / 抠出的主体；外加轮廓精灵 */
  private coverSharp = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private coverPlate = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private plateBase = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private coverSubj = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private maskCores = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private maskErases = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private maskImgs = new Map<string, { img: HTMLImageElement; sig: string }>();
  private maskEdges = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  /** 取一块指定尺寸的离屏画布并重置状态（复用，不每次 new） */
  private bufFor(which: 'glitch' | 'scratch', w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    let c = which === 'glitch' ? this.glitchBuf : this.scratch;
    if (!c) c = document.createElement('canvas');
    if (which === 'glitch') this.glitchBuf = c; else this.scratch = c;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext('2d')!;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = 'source-over';
    x.globalAlpha = 1;
    return { canvas: c, ctx: x };
  }

  /** 频闪「框选矩形」的取框：有手动框用框，否则用主体包围盒（规则见 flashRectOf） */
  private flashRect(layer: ImageLayer | null): [number, number, number, number] {
    const s = layer?.subject;
    return flashRectOf(s?.roi, s?.bbox);
  }

  /**
   * 按作用范围裁掉一层（destination-in），带羽化。
   *
   * 羽化用 `ctx.filter = blur()` 在**裁切这一步**施加：因为这一层颜色是纯色，
   * 模糊它的 alpha 等价于模糊整层，所以一次 fillRect/drawImage 就够了。
   * 必须包在 save/restore 里 —— filter 会泄漏到同一 ctx 的后续绘制（这个坑踩过）。
   */
  private clipToScope(ctx: CanvasRenderingContext2D, scope: number, layer: ImageLayer | null,
    mask: HTMLImageElement | null, feather: number, w: number, h: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    if (feather > 0.5) ctx.filter = `blur(${feather.toFixed(1)}px)`;
    if (scope === 2 && mask) {
      ctx.drawImage(mask, 0, 0, w, h);            // 软掩膜 → 边缘本来就渐变
    } else {
      const r = this.flashRect(layer);
      ctx.fillRect(r[0] * w, r[1] * h, (r[2] - r[0]) * w, (r[3] - r[1]) * h);
    }
    ctx.restore();
  }

  /* ============================ 滤镜（v0.8.10） ============================
     五个都是屏幕空间后处理，全部用画布运算实现，**没有逐像素 JS 循环** ——
     逐像素那类（真半调、像素排序、ASCII、浮雕）在 1080 下每帧要 30ms+，这个预算扛不住。
     顺序：结构（像素化）→ 颜色（色差、双色调）→ 纹理（扫描线、网点）。 */

  /** 像素化：缩到 1/block 再放大回来（关掉平滑），两趟绘制 */
  private applyPixelate(ctx: CanvasRenderingContext2D, fx: CoverFx, w: number, h: number): void {
    const block = (Math.min(100, fx.fxPixel) / 100) * 0.06 * w;   // 最大 6% 画板宽
    if (block < 1.5) return;
    const tw = Math.max(2, Math.round(w / block));
    const th = Math.max(2, Math.round(h / block));
    const tiny = this.bufFor('scratch', tw, th);
    tiny.ctx.imageSmoothingEnabled = false;
    tiny.ctx.clearRect(0, 0, tw, th);
    tiny.ctx.drawImage(ctx.canvas, 0, 0, tw, th);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny.canvas, 0, 0, w, h);
    ctx.restore();
  }

  /**
   * 色差：把画面拆成「红通道」和「青通道」两份，各自反向位移后叠加。
   * 红 + 青 = 原图（三通道互补），所以亮度不变，只有边缘出现彩色描边。
   * 必须**先清空主画布**再叠加，否则原图还在，等于叠了三层、整体过曝。
   */
  private applyChroma(ctx: CanvasRenderingContext2D, fx: CoverFx, w: number, h: number): void {
    const d = (Math.min(100, fx.fxRgb) / 100) * 0.025 * w;
    if (d < 0.6) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const src = this.bufFor('glitch', cw, ch);
    src.ctx.clearRect(0, 0, cw, ch);
    src.ctx.drawImage(ctx.canvas, 0, 0);
    const layer = this.bufFor('scratch', cw, ch);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0);

    const pass = (color: string, dx: number) => {
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.clearRect(0, 0, cw, ch);
      layer.ctx.drawImage(src.canvas, 0, 0);
      layer.ctx.globalCompositeOperation = 'multiply';       // 乘纯色 = 只留该通道
      layer.ctx.fillStyle = color;
      layer.ctx.fillRect(0, 0, cw, ch);
      layer.ctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(layer.canvas, dx, 0, w, h);
      ctx.restore();
    };
    pass('#ff0000', d);
    pass('#00ffff', -d);
  }

  /** 双色调：去色 → 暗部乘色 → 亮部滤色。三步都用 intensity 控制强度 */
  private applyDuotone(ctx: CanvasRenderingContext2D, fx: CoverFx, w: number, h: number): void {
    const a = Math.min(1, Math.min(100, fx.fxDuotone) / 100);
    if (a <= 0.01) return;
    const hue = ((Math.round(fx.fxDuoHue) % 360) + 360) % 360;
    ctx.save();
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = a;
    ctx.fillStyle = '#808080';            // 纯灰 → 取它的饱和度(0)
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = a * 0.85;
    ctx.fillStyle = `hsl(${hue}, 72%, 46%)`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = a * 0.5;
    ctx.fillStyle = `hsl(${(hue + 180) % 360}, 62%, 64%)`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** 取一块图案砖（按 key 缓存；画板尺寸变了 key 里的行距会跟着变，不会用错旧图） */
  private tileFor(key: string, tw: number, th: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    const hit = this.tiles.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = Math.max(1, tw);
    c.height = Math.max(1, th);
    paint(c.getContext('2d')!);
    if (this.tiles.size > 24) this.tiles.clear();      // 参数来回拖时不至于无限涨
    this.tiles.set(key, c);
    return c;
  }

  /** 扫描线：1×gap 的砖，顶部一条暗线，用 multiply 铺满 */
  private applyScanlines(ctx: CanvasRenderingContext2D, fx: CoverFx, w: number, h: number): void {
    const s = Math.min(100, fx.fxScan) / 100;
    if (s <= 0.01) return;
    const gap = Math.max(3, Math.round(fx.fxScanGap * (w / 1080)));
    /* 用 source-over 叠暗线而不是 multiply：
       对这一类"纯黑半透明"的覆盖，两者观感等价，但混合模式的全幅合成更贵。 */
    const tile = this.tileFor(`scan:${gap}`, 1, gap, c => {
      c.fillStyle = 'rgba(0,0,0,0.62)';
      c.fillRect(0, 0, 1, Math.max(1, Math.round(gap * 0.42)));
    });
    const pat = ctx.createPattern(tile, 'repeat');
    if (!pat) return;
    ctx.save();
    ctx.globalAlpha = s * 0.85;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** 网点：cell×cell 的砖，中心一个圆点（45° 印刷角的近似由格内偏移体现） */
  private applyDots(ctx: CanvasRenderingContext2D, fx: CoverFx, w: number, h: number): void {
    const s = Math.min(100, fx.fxDot) / 100;
    if (s <= 0.01) return;
    const cell = Math.max(2, Math.round(fx.fxDotScale * (w / 1080)));
    const R = Math.max(0.6, cell * 0.3);
    const tile = this.tileFor(`dot:${cell}`, cell, cell, c => {
      c.fillStyle = 'rgba(0,0,0,0.72)';
      c.beginPath();
      c.arc(cell / 2, cell / 2, R, 0, Math.PI * 2);
      c.fill();
    });
    const pat = ctx.createPattern(tile, 'repeat');
    if (!pat) return;
    ctx.save();
    ctx.globalAlpha = s * 0.8;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /**
   * 频闪填充的统一出口：四个通道各自只在「混合模式 + 颜色 + 强度」上不同，
   * 作用范围（全幅 / 框选矩形 / 主体剪影）在这里统一处理。
   *
   * 范围内的做法：先在离屏画布上铺满颜色，再用 destination-in 按范围裁掉，
   * 最后把这一层整体贴回主画布 —— 混合模式是与主画布之间发生的，所以裁切必须先做完。
   */
  private paintFlash(ctx: CanvasRenderingContext2D, cfg: {
    mode: GlobalCompositeOperation; color: string; alpha: number;
    scope: number; feather: number; layer: ImageLayer | null; mask: HTMLImageElement | null; w: number; h: number;
  }): void {
    const { mode, color, alpha, scope, feather, layer, mask, w, h } = cfg;
    const a = Math.min(1, alpha);
    if (a <= 0.001) return;

    // 全幅，或选了剪影但压根没有掩膜 → 直接铺
    if (scope === 0 || (scope === 2 && !mask)) {
      ctx.save();
      ctx.globalCompositeOperation = mode;
      ctx.globalAlpha = a;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      return;
    }

    const buf = this.bufFor('scratch', w, h);
    buf.ctx.clearRect(0, 0, w, h);
    buf.ctx.fillStyle = color;
    buf.ctx.fillRect(0, 0, w, h);
    this.clipToScope(buf.ctx, scope, layer, mask, feather, w, h);

    ctx.save();
    ctx.globalCompositeOperation = mode;
    ctx.globalAlpha = a;
    ctx.drawImage(buf.canvas, 0, 0);
    ctx.restore();
  }

  private rimBuf: HTMLCanvasElement | null = null;
  private dustSprite: HTMLCanvasElement | null = null;
  private glitchBuf: HTMLCanvasElement | null = null;
  /** 频闪 / 错位共用的临时画布（两者不会同时用，省一块 1080² 内存） */
  private scratch: HTMLCanvasElement | null = null;
  /** 扫描线 / 网点的图案砖：按行距缓存，参数不变就一直复用 */
  private tiles = new Map<string, HTMLCanvasElement>();

  /** 星尘用的"一滴光"预烘焙精灵：每帧只做 drawImage，不要每颗都建一次径向渐变 */
  private dustSpriteFor(): HTMLCanvasElement {
    if (this.dustSprite) return this.dustSprite;
    const S = 32;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d')!;
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,252,240,1)');
    g.addColorStop(0.30, 'rgba(255,240,214,0.62)');
    g.addColorStop(0.62, 'rgba(255,226,180,0.16)');
    g.addColorStop(1, 'rgba(255,220,170,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
    this.dustSprite = c;
    return c;
  }

  private maskSig(layer: ImageLayer): string {
    const u = layer.subject?.maskUrl ?? '';
    return u.length + ':' + u.slice(0, 32) + ':' + u.slice(-20);
  }

  private ensureMask(layer: ImageLayer): HTMLImageElement | null {
    const s = layer.subject;
    if (!s) return null;
    const sig = this.maskSig(layer);
    const hit = this.maskImgs.get(layer.id);
    if (hit && hit.sig === sig) return hit.img.complete && hit.img.naturalWidth > 0 ? hit.img : null;
    const img = new Image();
    img.onload = () => { this.onNeedsRender?.(); };
    img.src = s.maskUrl;
    this.maskImgs.set(layer.id, { img, sig });
    return null;
  }

  /**
   * 掩膜"硬芯"：把 alpha 沿 0.5 做一次对比拉伸。
   *
   * 分析得到的掩膜边缘是软的（羽化 + 低分辨率），直接用会有两个毛病：
   *   1. 主体精灵边缘半透明 → 看起来像糊了一层光晕
   *   2. 从背景板里擦主体时擦不干净 → 主体背后留一圈原色
   * 拉伸后两处都干净，而且仍是平滑过渡（不会出锯齿）。
   */
  private maskCore(layer: ImageLayer, mask: HTMLImageElement): HTMLCanvasElement {
    const s = layer.subject!;
    const mw = Math.max(32, Math.round(s.mw)), mh = Math.max(32, Math.round(s.mh));
    const key = this.maskSig(layer) + '|' + mw + 'x' + mh;
    const hit = this.maskCores.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = mw; c.height = mh;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.clearRect(0, 0, mw, mh);
    x.drawImage(mask, 0, 0, mw, mh);
    const img = x.getImageData(0, 0, mw, mh);
    const d = img.data;
    for (let p = 0; p < mw * mh; p++) {
      const a = d[p * 4 + 3] / 255;
      const v = Math.max(0, Math.min(1, (a - 0.5) * 4 + 0.5));
      d[p * 4] = 255; d[p * 4 + 1] = 255; d[p * 4 + 2] = 255;
      d[p * 4 + 3] = Math.round(v * 255);
    }
    x.putImageData(img, 0, 0);
    this.maskCores.set(layer.id, { key, canvas: c });
    return c;
  }

  /**
   * 擦除用掩膜：硬芯 + 膨胀 1 个掩膜像素（≈2 个画板像素）。
   *
   * 直接拿 maskCore 当橡皮擦会留下一圈"鬼影"：掩膜边界处 alpha≈0.5，
   * `destination-out` 只擦掉一半，于是主体自己那条描边有一半留在背景板里。
   * 背景板随后要平移/放大，这半条描边就被甩到主体外侧 ——
   * 用户看到的就是"主体外面还挂着一圈淡淡的轮廓"（放大看是一串点）。
   * 这里把擦除边界推到轮廓外 1 个掩膜像素，保证擦得干净。
   */
  private maskErase(layer: ImageLayer, mask: HTMLImageElement): HTMLCanvasElement {
    const s = layer.subject!;
    const mw = Math.max(32, Math.round(s.mw)), mh = Math.max(32, Math.round(s.mh));
    const key = 'e|' + this.maskSig(layer) + '|' + mw + 'x' + mh;
    const hit = this.maskErases.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = mw; c.height = mh;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.clearRect(0, 0, mw, mh);
    x.imageSmoothingQuality = 'high';
    x.drawImage(mask, 0, 0, mw, mh);
    const img = x.getImageData(0, 0, mw, mh);
    const d = img.data;
    const n = mw * mh;
    const a0 = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const a = d[p * 4 + 3] / 255;
      a0[p] = Math.max(0, Math.min(1, (a - 0.5) * 4 + 0.5));   // 与 maskCore 同一套对比拉伸
    }
    const a1 = new Float32Array(n);
    for (let y = 0; y < mh; y++) for (let x0 = 0; x0 < mw; x0++) {
      const p = y * mw + x0;
      let m = a0[p];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= mh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x0 + dx; if (xx < 0 || xx >= mw) continue;
          const v = a0[yy * mw + xx];
          if (v > m) m = v;
        }
      }
      a1[p] = m;
    }
    for (let p = 0; p < n; p++) {
      d[p * 4] = 255; d[p * 4 + 1] = 255; d[p * 4 + 2] = 255;
      d[p * 4 + 3] = Math.round(a1[p] * 255);
    }
    x.putImageData(img, 0, 0);
    this.maskErases.set(layer.id, { key, canvas: c });
    return c;
  }

  /** 原图按 cover 铺满画板（饱和度一次烘好） */
  private sharpKey(layer: ImageLayer, fx: CoverFx, w: number, h: number): string {
    return this.srcSig(layer) + '|' + fx.sat + '|' + w + 'x' + h;
  }

  private sharpFor(layer: ImageLayer, img: HTMLImageElement, w: number, h: number, fx: CoverFx): HTMLCanvasElement {
    const key = this.sharpKey(layer, fx, w, h);
    const hit = this.coverSharp.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, w, h);
    x.save();
    x.filter = 'saturate(' + (fx.sat / 100).toFixed(2) + ')';
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    x.restore();
    this.coverSharp.set(layer.id, { key, canvas: c });
    return c;
  }

  /**
   * 背景板底图：高清原图铺底 → 精确擦掉主体 → 沿边界"延伸"补洞。
   *
   * 为什么要擦：直接拿原图当背景，主体在背景板里还有一份，主体一动就露出重影。
   * 为什么要"延伸"补洞：早先是在 128² 上做 Laplacian 扩散，那等于把洞抹成一片平滑色。
   *   洞本身被主体盖着看不见，但主体一呼吸/漂浮，洞的边就会从主体边上露出一条几像素的带子 ——
   *   在那条带子里，高频背景（放射线、砖墙、纹理）被抹平了，看起来就是"主体边缘一圈虚化"。
   *   改成从最近的边界像素沿法线长进去（BFS 取最近边界色），纹理方向能延续下去，
   *   露出来的那条带子才和真背景接得上。
   */
  private plateBaseFor(layer: ImageLayer, sharp: HTMLCanvasElement, mask: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
    // 背景板只关心「主体大致在哪」，笔刷改掩膜不该让这张（贵的）图重烘 —— 所以用 seed 而不是掩膜指纹
    const maskKey = layer.subject?.seed || this.maskSig(layer);
    const key = 'b|' + this.srcSig(layer) + '|' + maskKey + '|' + w + 'x' + h;
    const hit = this.plateBase.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;

    const M = PLATE_MARGIN;
    const W = w + M * 2, H = h + M * 2;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true })!;

    /* 1) 高清原图铺满 (W,H)：画板本体对齐在 (M,M)，四周按 1px 拉伸生成外扩带。
          注意不能改成"把放大的图裁一块"—— 那样外扩带和画板本体内容会错位。 */
    const hi = canvas2d(W, H);
    hi.ctx.imageSmoothingQuality = 'high';
    hi.ctx.drawImage(sharp, 0, 0, w, h, M, M, w, h);
    hi.ctx.drawImage(sharp, 0, 0, w, 1, M, 0, w, M);            // 上
    hi.ctx.drawImage(sharp, 0, h - 1, w, 1, M, M + h, w, M);    // 下
    hi.ctx.drawImage(sharp, 0, 0, 1, h, 0, M, M, h);            // 左
    hi.ctx.drawImage(sharp, w - 1, 0, 1, h, M + w, M, M, h);    // 右
    hi.ctx.drawImage(sharp, 0, 0, 1, 1, 0, 0, M, M);
    hi.ctx.drawImage(sharp, w - 1, 0, 1, 1, M + w, 0, M, M);
    hi.ctx.drawImage(sharp, 0, h - 1, 1, 1, 0, M + h, M, M);
    hi.ctx.drawImage(sharp, w - 1, h - 1, 1, 1, M + w, M + h, M, M);

    // 2) 擦主体：用"加宽版"掩膜（见 maskErase），边界不留半透明残影
    const erase = this.maskErase(layer, mask);
    hi.ctx.globalCompositeOperation = 'destination-out';
    hi.ctx.drawImage(erase, M, M, w, h);
    hi.ctx.globalCompositeOperation = 'source-over';

    // 3) 补洞
    this.extendIntoHole(hi, erase, M, w, h, W, H);

    /* 4) 落盘。
       这里**不要给整张底图加 blur**：canvas 的 filter 会泄漏到后续 drawImage，
       一旦泄漏到高清层，整幅背景都会被糊掉（实测就是"背景整体发虚"）。
       需要虚化时由 plateFor 统一处理，而且只处理洞那一块。 */
    x.clearRect(0, 0, W, H);
    x.drawImage(hi.canvas, 0, 0);

    this.plateBase.set(layer.id, { key, canvas: c });
    return c;
  }

  /**
   * 把洞用"最近的边界色"长满（BFS 边缘延伸），再只对洞区做一点点柔化。
   *
   * 直接按最近邻铺满会沿掩膜的锯齿长出很多细楔子，所以最后只把洞区柔化 2px；
   * 洞外一个像素都不动 —— 背景的锐度全靠这一点保住。
   */
  private extendIntoHole(hi: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D },
    erase: HTMLCanvasElement, M: number, w: number, h: number, W: number, H: number): void {
    const N = W * H;
    // 洞 = 擦除掩膜覆盖到的区域（放到 (M,M) 与画板对齐）
    const mc = canvas2d(W, H);
    mc.ctx.imageSmoothingQuality = 'high';
    mc.ctx.drawImage(erase, M, M, w, h);
    const mA = mc.ctx.getImageData(0, 0, W, H);
    const hole = new Uint8Array(N);
    let holeCount = 0;
    for (let p = 0; p < N; p++) {
      if (mA.data[p * 4 + 3] > 6) { hole[p] = 1; holeCount++; }
    }
    if (!holeCount) return;

    const img = hi.ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const seen = new Uint8Array(N);
    const q = new Int32Array(N);
    let qt = 0;
    // 种子：紧贴洞的"完全没被擦过"的像素（它们的颜色是可信的）
    for (let y = 1; y < H - 1; y++) for (let x0 = 1; x0 < W - 1; x0++) {
      const p = y * W + x0;
      if (!hole[p]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = (y + dy) * W + (x0 + dx);
        if (hole[n] || seen[n] || d[n * 4 + 3] < 250) continue;
        seen[n] = 1; q[qt++] = n;
      }
    }
    let qh = 0;
    while (qh < qt) {
      const p = q[qh++];
      const px = p % W, py = (p - px) / W;
      const r = d[p * 4], g = d[p * 4 + 1], b = d[p * 4 + 2];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx; if (xx < 0 || xx >= W) continue;
          const n = yy * W + xx;
          if (!hole[n] || seen[n]) continue;
          d[n * 4] = r; d[n * 4 + 1] = g; d[n * 4 + 2] = b; d[n * 4 + 3] = 255;
          seen[n] = 1; q[qt++] = n;
        }
      }
    }
    hi.ctx.putImageData(img, 0, 0);

    // 洞区柔化：延伸出来的是细楔子，2px 足够把接缝磨掉，又不会把纹理糊成一片
    const FILL_SOFTEN = 2;
    const bl = canvas2d(W, H);
    bl.ctx.filter = `blur(${FILL_SOFTEN}px)`;
    bl.ctx.drawImage(hi.canvas, 0, 0);
    bl.ctx.filter = 'none';
    bl.ctx.globalCompositeOperation = 'destination-in';
    bl.ctx.drawImage(mc.canvas, 0, 0);      // 只留洞区
    bl.ctx.globalCompositeOperation = 'source-over';
    hi.ctx.drawImage(bl.canvas, 0, 0);
  }


  /** 背景板：底图 + 虚化 + 压暗（参数变才重烘）。尺寸是画板 + 四周外扩。 */
  private plateFor(layer: ImageLayer, sharp: HTMLCanvasElement, mask: HTMLImageElement, fx: CoverFx, w: number, h: number): HTMLCanvasElement {
    const base = this.plateBaseFor(layer, sharp, mask, w, h);
    const blur = Math.round(fx.bgBlur);
    const dark = Math.round(fx.bgDark);
    const key = 'p|' + (layer.subject?.seed || this.maskSig(layer)) + '|' + this.srcSig(layer) + '|' + blur + '|' + dark;
    const hit = this.coverPlate.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = base.width; c.height = base.height;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, c.width, c.height);
    x.save();
    const bright = (1 - (dark / 100) * 0.55).toFixed(3);
    x.filter = blur > 0 ? `blur(${blur}px) brightness(${bright})` : `brightness(${bright})`;
    x.imageSmoothingQuality = 'high';
    x.drawImage(base, 0, 0, c.width, c.height);
    x.restore();
    this.coverPlate.set(layer.id, { key, canvas: c });
    return c;
  }

  /** 主体：原图 × 掩膜 alpha
   *  soft=true 时不走"硬芯"（区域动效模式要的是化开的过渡，不是剪影硬边） */
  private subjectFor(layer: ImageLayer, sharp: HTMLCanvasElement, mask: HTMLImageElement, fx: CoverFx, w: number, h: number, soft = false): HTMLCanvasElement {
    const key = (soft ? 'r|' : 's|') + this.maskSig(layer) + '|' + this.sharpKey(layer, fx, w, h);
    const hit = this.coverSubj.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, w, h);
    x.drawImage(sharp, 0, 0);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(soft ? mask : this.maskCore(layer, mask), 0, 0, w, h);
    x.globalCompositeOperation = 'source-over';
    this.coverSubj.set(layer.id, { key, canvas: c });
    return c;
  }

  /** 轮廓精灵：从掩膜出一圈边缘，分辨率与掩膜一致（很小，够用）
   *  用硬芯掩膜取边，光带宽度才贴近剪影；直接用软掩膜会得到一条很宽的模糊带。 */
  private edgeFor(layer: ImageLayer, mask: HTMLImageElement): HTMLCanvasElement {
    const key = this.maskSig(layer);
    const hit = this.maskEdges.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const s = layer.subject!;
    const mw = Math.max(32, Math.round(s.mw)), mh = Math.max(32, Math.round(s.mh));
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = mw; c.height = mh;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.clearRect(0, 0, mw, mh);
    x.drawImage(this.maskCore(layer, mask), 0, 0, mw, mh);
    const src = x.getImageData(0, 0, mw, mh);
    const a = new Float32Array(mw * mh);
    for (let p = 0; p < mw * mh; p++) a[p] = src.data[p * 4 + 3] / 255;
    const out = x.createImageData(mw, mh);
    for (let y = 1; y < mh - 1; y++) for (let x0 = 1; x0 < mw - 1; x0++) {
      const p = y * mw + x0;
      if (a[p] < 0.35) continue;
      let isEdge = false;
      for (let dy = -1; dy <= 1 && !isEdge; dy++) for (let dx = -1; dx <= 1 && !isEdge; dx++) {
        if ((dx || dy) && a[(y + dy) * mw + (x0 + dx)] < 0.35) isEdge = true;
      }
      if (!isEdge) continue;
      out.data[p * 4] = 255; out.data[p * 4 + 1] = 236; out.data[p * 4 + 2] = 200;
      out.data[p * 4 + 3] = 235;
    }
    x.putImageData(out, 0, 0);
    this.maskEdges.set(layer.id, { key, canvas: c });
    return c;
  }

  private drawCover(ctx: CanvasRenderingContext2D, doc: Doc, t: number, w: number, h: number) {
    ctx.fillStyle = doc.canvas.bg;
    ctx.fillRect(0, 0, w, h);
    const layer = coverLayer(doc);
    if (!layer) return;
    const img = this.ensureImage(layer);
    if (!img) return;                          // 解码中，onload 会再触发重绘

    const fx = layer.cover ?? defaultCoverFx();
    const tier = layer.subject?.tier ?? 'fallback';
    const ability = TIER_ABILITY[tier];
    const sharp = this.sharpFor(layer, img, w, h, fx);
    const s = subjectXform(fx, t, ability);
    const mask = ability.subject ? this.ensureMask(layer) : null;

    /* ---- 镜头层：背景板与主体必须套同一个变换 ----
       只给背景板加缩放/旋转会让烘在板子里的擦除区跟着动，主体四周重新露出补洞色 ——
       那就是 v0.7.3 刚修掉的 bug。套同一变换时两者相对几何完全不变，
       只有画框边界需要覆盖，而背景板本来就外扩了 PLATE_MARGIN，3.8° 以内都够。 */
    const dur = doc.duration > 0 ? doc.duration : 4200;
    const sc = sceneXform(fx, t, dur);
    const fr = frameXform(fx);              // 构图：整幅缩放 + 平移（静态，与镜头运动叠加）
    ctx.save();
    if (sc.scale !== 1 || sc.rot !== 0 || fr.scale !== 1 || fr.dx !== 0 || fr.dy !== 0) {
      // 平移放在最外层：用户拖的是"画面在画框里移动"，所以位移量不该再被缩放放大
      ctx.translate(w / 2 + fr.dx * w, h / 2 + fr.dy * h);
      const k = sc.scale * fr.scale;
      ctx.scale(k, k);
      if (sc.rot !== 0) ctx.rotate(sc.rot);
      ctx.translate(-w / 2, -h / 2);
    }

    if (!mask) {
      /* 降级：没有可信主体 → 整图动效（呼吸/推进仍可出现），绝不空屏。
         这里直接用 fx 的原始值，不走 subjectXform 的档位门控：
         fallback 档位下 subjectXform 会把 breathe/float 全部归零，
         那样这张图就彻底不动了。 */
      const T = coverTime(fx, t);
      const zoom = 1.02 + (fx.breathe / 100) * 0.05 * (0.5 + 0.5 * Math.sin((T / 2.6) * Math.PI * 2));
      const drift = (fx.float / 100) * 0.012;
      const dx = (s.dx + drift * Math.sin((T / 3.4) * Math.PI * 2)) * w;
      const dy = (s.dy + drift * Math.sin((T / 5.1) * Math.PI * 2)) * h;
      ctx.save();
      ctx.translate(w / 2 + dx, h / 2 + dy);
      ctx.scale(zoom, zoom);
      ctx.drawImage(sharp, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      /* 区域动效模式（mask 只是"动效作用区域"，不是剪影）：
         绝不能在这里做背景板虚化 / 压暗 / 视差 —— 那会得到
         "一块清晰矩形贴在模糊背景上"（用户报的 bug 就是这个）。
         改成：整幅原图原样铺底（静止），只让区域内形变，边界靠软掩膜化开。 */
      const region = layer.subject?.fit === 'region';
      if (region) {
        ctx.drawImage(sharp, 0, 0, w, h);
      } else {
        const p = plateXform(fx, t);
        const plate = this.plateFor(layer, sharp, mask, fx, w, h);
        ctx.save();
        ctx.translate(w / 2 + p.dx * w, h / 2 + p.dy * h);
        ctx.scale(p.scale, p.scale);
        // 外扩版：以画板中心为原点画，四周多出来的 PLATE_MARGIN 就是平移的余量
        ctx.drawImage(plate, -w / 2 - PLATE_MARGIN, -h / 2 - PLATE_MARGIN, w + PLATE_MARGIN * 2, h + PLATE_MARGIN * 2);
        ctx.restore();
      }

      const subj = this.subjectFor(layer, sharp, mask, fx, w, h, region);
      const feetX = layer.subject!.feet[0] * w;
      const feetY = layer.subject!.feet[1] * h;
      const applySubject = (extraRot: number, neckY: number | null) => {
        ctx.save();
        ctx.translate(feetX + s.dx * w, feetY + s.dy * h);
        ctx.rotate(s.rot + extraRot);
        ctx.scale(s.scale, s.scale);
        ctx.translate(-feetX, -feetY);
        if (neckY != null) ctx.translate(0, neckY);
        ctx.drawImage(subj, 0, 0, w, h);
        ctx.restore();
      };
      // 需要点头时把脑袋单独切出来绕颈部转；否则整体一次画完
      const hd = headXform(fx, t, ability);
      if (hd.active) {
        const neckY = layer.subject!.neck * h;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, neckY - 1, w, h - neckY + 1); ctx.clip();
        applySubject(0, null);
        ctx.restore();
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, w, neckY + 1); ctx.clip();
        // 绕颈部旋转要用颈部在画板上的绝对位置
        ctx.save();
        ctx.translate(feetX + s.dx * w, feetY + s.dy * h);
        ctx.rotate(s.rot);
        ctx.scale(s.scale, s.scale);
        ctx.translate(-feetX, -feetY);
        const nx = layer.subject!.cx * w, ny = neckY;
        ctx.translate(nx, ny); ctx.rotate(hd.rot); ctx.translate(-nx, -ny);
        ctx.drawImage(subj, 0, 0, w, h);
        ctx.restore();
        ctx.restore();
      } else {
        applySubject(0, null);
      }

      // 轮廓流光
      const rim = rimState(fx, t, ability);
      if (rim.alpha > 0.01) {
        const edge = this.edgeFor(layer, mask);
        const mw = edge.width, mh = edge.height;
        if (!this.rimBuf) {
          this.rimBuf = document.createElement('canvas');
        }
        const buf = this.rimBuf;
        if (buf.width !== mw || buf.height !== mh) { buf.width = mw; buf.height = mh; }
        const bx = buf.getContext('2d')!;
        bx.clearRect(0, 0, mw, mh);
        bx.drawImage(edge, 0, 0);
        bx.globalCompositeOperation = 'source-in';
        const ang = rim.phase * Math.PI * 2;
        const gx = Math.cos(ang), gy = Math.sin(ang);
        const g = bx.createLinearGradient(mw * (0.5 - gx), mh * (0.5 - gy), mw * (0.5 + gx), mh * (0.5 + gy));
        g.addColorStop(0, 'rgba(255,214,140,0.15)');
        g.addColorStop(0.45, 'rgba(255,240,214,1)');
        g.addColorStop(0.55, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,214,140,0.15)');
        bx.fillStyle = g;
        bx.fillRect(0, 0, mw, mh);
        bx.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, rim.alpha);
        ctx.drawImage(buf, 0, 0, w, h);
        ctx.restore();
      }

      // 注意力点脉冲
      const peaks = layer.subject!.peaks;
      if (peaks.length && fx.pulse > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < peaks.length; i++) {
          const a = peakPulse(fx, t, i, ability);
          if (a <= 0.01) continue;
          const px = peaks[i].x * w, py = peaks[i].y * h;
          const R = w * (0.05 + 0.05 * a);
          const g = ctx.createRadialGradient(px, py, 0, px, py, R);
          g.addColorStop(0, `rgba(255,246,226,${(0.85 * a).toFixed(3)})`);
          g.addColorStop(0.45, `rgba(255,214,150,${(0.28 * a).toFixed(3)})`);
          g.addColorStop(1, 'rgba(255,200,120,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    }

    ctx.restore();   // 镜头层结束：以下都是屏幕空间效果

    /* 扫光：一道柔光带斜扫过整幅。放在镜头之外 —— 跟着转的话光带方向会歪，
       而且用户调"扫光角度感"时不该受推镜/缓转影响。 */
    const sb = sweepBand(fx, t, dur);
    if (sb.alpha > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.translate(w * sb.x, h * 0.5);
      ctx.rotate(-0.34);
      const hw = w * sb.halfW;
      const g = ctx.createLinearGradient(-hw, 0, hw, 0);
      /* 光带的形状：三角剖面的柔光，而不是"细线 + 光晕"。
         细线在 1080 画板上只有 30px，铺到封面里像一道划痕；柔和宽带才像扫光。 */
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.16, `rgba(255,250,238,${(0.14 * sb.alpha).toFixed(3)})`);
      g.addColorStop(0.34, `rgba(255,252,244,${(0.42 * sb.alpha).toFixed(3)})`);
      g.addColorStop(0.5, `rgba(255,255,255,${(0.78 * sb.alpha).toFixed(3)})`);
      g.addColorStop(0.66, `rgba(255,252,244,${(0.42 * sb.alpha).toFixed(3)})`);
      g.addColorStop(0.84, `rgba(255,250,238,${(0.14 * sb.alpha).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-hw, -h * 0.95, hw * 2, h * 1.9);
      ctx.restore();
    }

    /* 星尘：全部由 (索引, 相位) 推出来，不持有状态 —— 拖时间轴/导出都同一画面 */
    const dn = dustCount(fx);
    if (dn > 0) {
      const sprite = this.dustSpriteFor();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < dn; i++) {
        const p = dustParticle(i, fx, t, dur);
        if (p.a <= 0.012) continue;
        if (p.x < -0.05 || p.x > 1.05) continue;
        const R = p.r * w * 2.6;                  // 精灵半径（亮芯约占 1/3）
        ctx.globalAlpha = Math.min(1, p.a);
        ctx.drawImage(sprite, p.x * w - R, p.y * h - R, R * 2, R * 2);
      }
      ctx.restore();
    }

    /* 节拍补光：缩放脉冲（镜头层已含）+ 一点整体提亮，卡点才"有力度" */
    if (fx.beat > 0) {
      const be = beatEnv(fx, t, dur);
      if (be > 0.02) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,246,232,${(0.055 * (fx.beat / 100) * be).toFixed(4)})`;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }

    /* ---- 频闪族：四个通道共用同一条方形波 ----
       顺序固定：抽色 → 反相 → 提亮 → 压暗。反相放在提亮前，否则"反相+提亮"会互相抵消成灰。
       作用范围由 flashScope 决定：0 全幅 / 1 框选矩形 / 2 主体剪影。 */
    const fp = flashPulse(fx, t, dur);
    if (fp.on > 0) {
      const scope = Math.round(fx.flashScope);
      const feather = flashFeatherPx(fx, w);
      const common = { scope, feather, layer, mask, w, h };
      if (fx.mono > 0) {
        this.paintFlash(ctx, { ...common, mode: 'saturation', color: '#808080', alpha: fx.mono / 100 });
      }
      if (fx.invert > 0) {
        /* 增益 1.6：difference 在部分 alpha 下对中间调会落到"灰"，看着像褪色而不是负片。
           高值要直接吃到满反相，低值仍保留渐进（20% 以下是若隐若现的偏色）。 */
        this.paintFlash(ctx, { ...common, mode: 'difference', color: '#ffffff', alpha: (fx.invert / 100) * 1.6 });
      }
      if (fx.strobe > 0) {
        this.paintFlash(ctx, { ...common, mode: 'lighter', color: '#fffcf4', alpha: 0.55 * (fx.strobe / 100) });
      }
      if (fx.strobeDark > 0) {
        this.paintFlash(ctx, { ...common, mode: 'source-over', color: '#000000', alpha: 0.88 * (fx.strobeDark / 100) });
      }
    }

    /* ---- 切片错位 ----
       需要先把当前画面复制一份，再按条带错位重绘；露出的那条边用条带首列拉伸填上，
       不然会看到"位移后底下还有原画面"，变成双层而不是错位。
       限定范围时：在离屏画布上做完错位，再按范围裁切后贴回 —— 不能直接在主画布上 clip，
       因为我们要裁的是"错位后的结果"，而不是"错位的笔刷"。 */
    const gl = glitchState(fx, t, dur);
    if (gl.amt > 0.01) {
      const slices = glitchSlices(gl.seed, gl.amt);
      if (slices.length) {
        const scope = Math.round(fx.flashScope);
        const masked = scope !== 0 && (scope !== 2 || !!mask);
        const src = this.bufFor('glitch', w, h);
        src.ctx.clearRect(0, 0, w, h);
        // 必须显式给目标尺寸：预览缩放后 canvas 后备尺寸 < doc 尺寸，
        // 不写尺寸会把画面画到缓冲区的左上角一小块里
        src.ctx.drawImage(ctx.canvas, 0, 0, w, h);

        let out: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
        let tctx = ctx;
        if (masked) {
          out = this.bufFor('scratch', w, h);
          out.ctx.clearRect(0, 0, w, h);
          out.ctx.drawImage(src.canvas, 0, 0);
          tctx = out.ctx;
        }
        for (const sl of slices) {
          const y0 = Math.round(sl.y * h);
          const sh = Math.max(1, Math.round(sl.h * h));
          const dx = Math.round(sl.dx * w);
          if (!dx) continue;
          if (dx > 0) {
            tctx.drawImage(src.canvas, 0, y0, w - dx, sh, dx, y0, w - dx, sh);
            tctx.drawImage(src.canvas, 0, y0, 1, sh, 0, y0, dx, sh);
          } else {
            const ad = -dx;
            tctx.drawImage(src.canvas, ad, y0, w - ad, sh, 0, y0, w - ad, sh);
            tctx.drawImage(src.canvas, w - 1, y0, 1, sh, w - ad, y0, ad, sh);
          }
        }
        if (out) {
          // 与频闪共用同一套裁切 + 羽化，否则两种效果的边界会不一致
          this.clipToScope(out.ctx, scope, layer, mask, flashFeatherPx(fx, w), w, h);
          ctx.drawImage(out.canvas, 0, 0);
        }
      }
    }

    /* ---- 滤镜：结构 → 颜色 → 纹理（在暗角与颗粒之前，让这两者盖在最上面） ---- */
    if (fx.fxPixel > 0) this.applyPixelate(ctx, fx, w, h);
    if (fx.fxRgb > 0) this.applyChroma(ctx, fx, w, h);
    if (fx.fxDuotone > 0) this.applyDuotone(ctx, fx, w, h);
    if (fx.fxScan > 0) this.applyScanlines(ctx, fx, w, h);
    if (fx.fxDot > 0) this.applyDots(ctx, fx, w, h);

    if (fx.vignette > 0) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.min(w, h) * 0.78);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${(0.62 * fx.vignette / 100).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (fx.grain > 0) this.drawCoverGrain(ctx, fx, t, w, h);
  }

  private drawCoverGrain(ctx: CanvasRenderingContext2D, fx: CoverFx, t: number, w: number, h: number) {
    if (!this.grainTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 220;
      const x = c.getContext('2d')!;
      const d = x.createImageData(220, 220);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = 118 + Math.random() * 74;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
        d.data[i + 3] = 255;
      }
      x.putImageData(d, 0, 0);
      this.grainTex = c;
    }
    ctx.save();
    ctx.globalAlpha = 0.5 * fx.grain / 100;
    ctx.globalCompositeOperation = 'overlay';
    // 逐帧位移用 15fps 量化，避免噪点每次重绘都跳（码率与"呼吸感"之间的折中）
    const f = Math.floor((t / 1000) * 15);
    const ox = -Math.floor((f * 91) % 220), oy = -Math.floor((f * 57) % 220);
    for (let gx = ox; gx < w; gx += 220) for (let gy = oy; gy < h; gy += 220) {
      ctx.drawImage(this.grainTex, gx, gy);
    }
    ctx.restore();
  }

  /* ---------- 图片图层 ---------- */

  private srcSig(layer: ImageLayer): string {
    // 只取长度 + 头部指纹：整串比较在 400KB dataURL 上是纯浪费
    return layer.src.length + ':' + layer.src.slice(0, 40) + ':' + layer.src.slice(-24);
  }

  /** 取已解码图片；未就绪则发起加载并返回 null（首帧空白，解码完回调重绘） */
  private ensureImage(layer: ImageLayer): HTMLImageElement | null {
    const sig = this.srcSig(layer);
    const hit = this.imgs.get(layer.id);
    if (hit && hit.sig === sig) {
      return hit.img.complete && hit.img.naturalWidth > 0 ? hit.img : null;
    }
    const img = new Image();
    img.onload = () => { this.onNeedsRender?.(); };
    img.src = layer.src;
    this.imgs.set(layer.id, { img, sig });
    return null;
  }

  /** 预处理：饱和度 + cover 适配一次性烘焙（逐帧走 ctx.filter 会把帧率打到个位数） */
  private prepFor(layer: ImageLayer, img: HTMLImageElement): HTMLCanvasElement {
    const S = 900;
    const key = layer.id + '|' + layer.fx.sat + '|' + img.naturalWidth + 'x' + img.naturalHeight;
    const hit = this.preps.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, S, S);
    x.save();
    x.filter = 'saturate(' + (layer.fx.sat / 100).toFixed(2) + ')';
    const s = Math.max(S / img.naturalWidth, S / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    x.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
    x.restore();
    this.preps.set(layer.id, { key, canvas: c });
    return c;
  }

  /** 背景虚化（仅最底层图片）：缓存，不逐帧算 filter */
  private backdropFor(layer: ImageLayer, img: HTMLImageElement, cw: number, ch: number): HTMLCanvasElement {
    const key = layer.id + '|' + layer.fx.bgBlur + '|' + cw + 'x' + ch + '|' + img.naturalWidth;
    const hit = this.bgs.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const c = hit ? hit.canvas : document.createElement('canvas');
    c.width = cw; c.height = ch;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, cw, ch);
    x.save();
    x.filter = 'blur(' + Math.round(layer.fx.bgBlur) + 'px) saturate(1.25) brightness(.55)';
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight) * 1.18;
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    x.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    x.restore();
    this.bgs.set(layer.id, { key, canvas: c });
    return c;
  }

  private drawImageLayer(ctx: CanvasRenderingContext2D, layer: ImageLayer, t: number,
    cw: number, ch: number, isFirstImage: boolean) {
    const img = this.ensureImage(layer);
    if (!img) return;
    const fx = layer.fx;
    const prep = this.prepFor(layer, img);

    if (isFirstImage && fx.bgBlur > 0) {
      ctx.drawImage(this.backdropFor(layer, img, cw, ch), 0, 0);
    }

    const m = fxAt(fx, t);
    const w = layer.w * m.scale;
    const h = layer.h * m.scale;
    const x = layer.x - w / 2 + m.dx * layer.w;
    const y = layer.y - h / 2 + m.dy * layer.h;
    const r = (fx.radius / 100) * Math.min(w, h) / 2;
    const cx = layer.x + m.dx * layer.w;
    const cy = layer.y + m.dy * layer.h;

    if (fx.glow > 0) this.drawGlow(ctx, fx, t, cx, cy, Math.min(w, h) / 2);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(m.rot);
    ctx.translate(-cx, -cy);

    if (fx.vinyl > 0.5) {
      this.drawVinyl(ctx, layer, prep, cx, cy, Math.min(w, h) / 2, t);
    } else {
      roundRectPath(ctx, x, y, w, h, r);
      ctx.save();
      ctx.clip();

      if (fx.warp > 0) {
        // 液态扭曲：横向条带位移 + 6% 过扫描，防止位移后露出边缘
        const strips = 30;
        const amp = (fx.warp / 100) * (w * 0.023);
        const ow = w * 1.06, ox = x - w * 0.03;
        for (let i = 0; i < strips; i++) {
          const sy = (900 / strips) * i;
          const dy = y + (h / strips) * i;
          const ddx = Math.sin(m.T * 1.6 + i * 0.42) * amp + Math.sin(m.T * 0.7 + i * 0.19) * amp * 0.6;
          ctx.drawImage(prep, 0, sy, 900, 900 / strips + 1,
            ox + ddx, dy, ow, h / strips + 1.2);
        }
      } else {
        ctx.drawImage(prep, x, y, w, h);
      }
      ctx.restore();

      // 玻璃边缘
      ctx.save();
      roundRectPath(ctx, x, y, w, h, r);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.lineWidth = Math.max(1, w * 0.004);
      roundRectPath(ctx, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1));
      ctx.stroke();
      ctx.restore();

      if (fx.sweep > 0) this.drawSweep(ctx, fx, t, x, y, w, h, r);
    }
    ctx.restore();

    if (isFirstImage) {
      if (fx.vignette > 0) this.drawVignette(ctx, fx, cw, ch);
      if (fx.grain > 0) this.drawGrain(ctx, fx, t, cw, ch);
    }
  }

  private drawGlow(ctx: CanvasRenderingContext2D, fx: ImageLayer['fx'], t: number, cx: number, cy: number, half: number) {
    const accent = [242, 168, 92]; // 主色（暂用暖金；主色提取在 ui 侧算好可后续接入）
    const pulse = glowPulse(fx, t);
    const rad = half * (1.48 + 0.24 * pulse);
    const al = (fx.glow / 100) * pulse;
    const g = ctx.createRadialGradient(cx, cy, half * 0.36, cx, cy, rad);
    g.addColorStop(0, `rgba(${accent[0]},${accent[1]},${accent[2]},${(0.30 * al).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(${accent[0]},${accent[1]},${accent[2]},${(0.10 * al).toFixed(3)})`);
    g.addColorStop(1, `rgba(${accent[0]},${accent[1]},${accent[2]},0)`);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  private drawVinyl(ctx: CanvasRenderingContext2D, layer: ImageLayer, prep: HTMLCanvasElement,
    cx: number, cy: number, R: number, t: number) {
    const dg = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
    dg.addColorStop(0, '#23262d');
    dg.addColorStop(0.6, '#131519');
    dg.addColorStop(1, '#0a0b0e');
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = Math.max(1, R * 0.004);
    for (let i = 1; i <= 26; i++) {
      ctx.beginPath(); ctx.arc(cx, cy, R * (0.42 + i * 0.022), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const hg = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.2, cy + R * 0.4);
    hg.addColorStop(0, 'rgba(255,255,255,.14)');
    hg.addColorStop(0.5, 'rgba(255,255,255,.02)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    const ir = R * 0.40;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(vinylAngle(layer.fx, t, this.doc.duration));
    ctx.beginPath(); ctx.arc(0, 0, ir, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(prep, -ir, -ir, ir * 2, ir * 2);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#0d0e11';
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, ir * 0.045), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    if (layer.fx.sweep > 0) this.drawSweep(ctx, layer.fx, t, cx - R, cy - R, R * 2, R * 2, R);
  }

  private drawSweep(ctx: CanvasRenderingContext2D, fx: ImageLayer['fx'], t: number,
    x: number, y: number, w: number, h: number, r: number) {
    const ph = sweepPhase(fx, t);
    const a = fx.angle * Math.PI / 180;
    const span = Math.hypot(w, h) * 1.3;
    const pos = -span / 2 + ph * span;
    const cx = x + w / 2 + Math.cos(a) * pos;
    const cy = y + h / 2 + Math.sin(a) * pos;
    const nx = Math.cos(a + Math.PI / 2), ny = Math.sin(a + Math.PI / 2);
    const g = ctx.createLinearGradient(cx - nx * w * 0.34, cy - ny * h * 0.34, cx + nx * w * 0.34, cy + ny * h * 0.34);
    const al = 0.30 * fx.sweep / 100;
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.42, 'rgba(255,246,230,0)');
    g.addColorStop(0.5, `rgba(255,250,240,${al.toFixed(3)})`);
    g.addColorStop(0.58, 'rgba(255,246,230,0)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  private drawVignette(ctx: CanvasRenderingContext2D, fx: ImageLayer['fx'], w: number, h: number) {
    const cx = w / 2, cy = h / 2;
    const g = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.30, cx, cy, Math.min(w, h) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${(0.62 * fx.vignette / 100).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  private grainTex: HTMLCanvasElement | null = null;
  private drawGrain(ctx: CanvasRenderingContext2D, fx: ImageLayer['fx'], t: number, w: number, h: number) {
    if (!this.grainTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 220;
      const x = c.getContext('2d')!;
      const d = x.createImageData(220, 220);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = 118 + Math.random() * 74;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
        d.data[i + 3] = 255;
      }
      x.putImageData(d, 0, 0);
      this.grainTex = c;
    }
    ctx.save();
    ctx.globalAlpha = 0.5 * fx.grain / 100;
    ctx.globalCompositeOperation = 'overlay';
    const ox = -Math.floor((t / 1000 * 91) % 220), oy = -Math.floor((t / 1000 * 57) % 220);
    for (let gx = ox; gx < w; gx += 220) {
      for (let gy = oy; gy < h; gy += 220) ctx.drawImage(this.grainTex, gx, gy);
    }
    ctx.restore();
  }

  /** 等待文档里的图片全部解码完成（导出前调用，避免导出空白帧） */
  async whenImagesReady(doc: Doc, timeoutMs = 8000): Promise<boolean> {
    const imgs = doc.layers.filter(isImage);
    if (imgs.length === 0) return true;
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      let pending = false;
      for (const l of imgs) {
        if (!this.ensureImage(l)) pending = true;
      }
      if (!pending) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    return false;
  }

  private drawBg(ctx: CanvasRenderingContext2D, layer: BgLayer, t: number, w: number, h: number) {
    const props = layerProps(layer.anim, t);
    ctx.save();
    ctx.globalAlpha = props.alpha;
    ctx.translate(w / 2, h / 2);
    ctx.scale(props.scale, props.scale);
    ctx.translate(-w / 2, -h / 2);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, layer.color1);
    g.addColorStop(1, layer.color2);
    ctx.fillStyle = g;
    ctx.fillRect(-w * 0.12, -h * 0.12, w * 1.24, h * 1.24);
    ctx.restore();
  }

  private drawText(ctx: CanvasRenderingContext2D, layer: TextLayer, t: number, w: number, h: number) {
    const layout = this.getLayout(layer);
    if (layout.chars.length === 0) return;
    const s = layer.style;
    const props = layerProps(layer.anim, t);
    const vis = visibleChars(layer.anim, t, layout.chars.length);
    const byLine = layer.anim.preset === 'lineSlide';

    ctx.save();
    ctx.font = `400 ${s.size}px ${FONT_STACKS[s.font]}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = s.color;

    if (props.clipTop !== null) {
      const cutY = s.y - layout.blockH / 2 + props.clipTop * layout.blockH;
      ctx.beginPath();
      ctx.rect(0, cutY, w, Math.max(0, h - cutY));
      ctx.clip();
    }

    ctx.translate(s.x, s.y);
    ctx.translate(props.dx, props.dy);
    ctx.scale(props.scale, props.scale);
    ctx.translate(-s.x, -s.y);

    let i = 0;
    for (const c of layout.chars) {
      if (i >= vis) break;
      const a = charAlpha(layer.anim, t, byLine ? c.line : i);
      if (a > 0.01) {
        const off = charOffset(layer.anim, t, byLine ? c.line : i);
        ctx.globalAlpha = a;
        ctx.fillText(c.ch, c.cx + off.dx, c.cy + off.dy);
      }
      i++;
    }

    const ca = caretAlpha(layer.anim, t);
    if (ca > 0) {
      const last = layout.chars[vis - 1];
      const caretX = last ? last.cx + last.w / 2 + s.size * 0.08 : s.x - s.boxWidth / 2;
      const caretY = last ? last.cy : s.y - layout.blockH / 2 + layout.lineH / 2;
      ctx.globalAlpha = ca;
      ctx.fillRect(caretX, caretY - s.size * 0.52, Math.max(4, s.size * 0.07), s.size * 1.04);
    }
    ctx.restore();
  }

  /** 命中测试：返回最上层可拖拽图层 id（画布逻辑坐标） */
  hitTest(x: number, y: number): string | null {
    for (let i = this.doc.layers.length - 1; i >= 0; i--) {
      const l = this.doc.layers[i];
      if (isImage(l)) {
        const half = Math.min(l.w, l.h) / 2;
        if (Math.abs(x - l.x) <= l.w / 2 && Math.abs(y - l.y) <= l.h / 2) return l.id;
        if (half > 0 && Math.abs(x - l.x) <= l.w / 2 + 20 && Math.abs(y - l.y) <= l.h / 2 + 20) return l.id;
        continue;
      }
      if (!isText(l)) continue;
      const s = l.style;
      const layout = this.getLayout(l);
      if (layout.chars.length === 0) continue;
      const pad = s.size * 0.6;
      if (Math.abs(x - s.x) <= layout.blockW / 2 + pad && Math.abs(y - s.y) <= layout.blockH / 2 + pad) {
        return l.id;
      }
    }
    return null;
  }
}
