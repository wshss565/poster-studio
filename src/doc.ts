export type EasingKey = 'linear' | 'easeOut' | 'easeInOut' | 'back';
export type PresetKey = 'none' | 'typewriter' | 'charRise' | 'lineSlide' | 'maskWipe' | 'popScale' | 'kenBurns';

export interface AnimSpec {
  preset: PresetKey;
  duration: number; // ms
  delay: number;    // ms
  stagger: number;  // ms，逐字/逐行间隔
  easing: EasingKey;
}

export interface TextStyle {
  font: 'serif' | 'sans' | 'kai';
  size: number;
  lineHeight: number;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  color: string;
  x: number; // 画布逻辑坐标，文本块中心
  y: number;
  boxWidth: number;
}

export interface TextLayer {
  id: string;
  type: 'text';
  text: string;
  style: TextStyle;
  anim: AnimSpec;
}

export interface BgLayer {
  id: string;
  type: 'bg';
  color1: string;
  color2: string;
  anim: AnimSpec; // preset: 'none' | 'kenBurns'
}

/** 图片图层的动效参数（对标网易云动态封面的那组效果） */
export interface ImageFx {
  speed: number;    // 10..300 (%)
  breathe: number;  // 0..100 呼吸缩放
  float: number;    // 0..100 轨道漂浮
  spin: number;     // 0..100 旋转幅度
  sweep: number;    // 0..100 光扫强度
  angle: number;    // 0..360 光扫角度
  glow: number;     // 0..100 呼吸光晕（取封面主色）
  grain: number;    // 0..100 胶片颗粒
  vignette: number; // 0..100 暗角
  warp: number;     // 0..100 液态扭曲
  radius: number;   // 0..50 圆角（占短边百分比）
  sat: number;      // 40..200 饱和度
  bgBlur: number;   // 0..60 背景虚化（仅最底层图片生效）
  vinyl: number;    // 0..1 黑胶模式
}

export interface ImageLayer {
  id: string;
  type: 'image';
  name: string;
  src: string;  // dataURL（导入时已降采样，最长边 ≤ 1600）
  x: number;    // 图层矩形中心（画布逻辑坐标）
  y: number;
  w: number;
  h: number;
  fx: ImageFx;
  /** 封面模式专用动效与识别结果（海报模式不用） */
  cover?: CoverFx;
  subject?: SubjectInfo;
}

/* ============================================================
   封面模式（v0.7）：1:1 画板、无背景层、动效作用在「识别出的主体」上
   ============================================================ */

export type DocMode = 'poster' | 'cover';

/** 识别结果：坐标一律归一化到 0..1（相对图片矩形），换画布尺寸不用重算 */
export interface SubjectInfo {
  maskUrl: string;   // data:image/png，白=主体（低分辨率，绘制时放大）
  mw: number;
  mh: number;
  bbox: [number, number, number, number]; // x0,y0,x1,y1
  cx: number;        // 质心
  cy: number;
  feet: [number, number];  // 底边中点（摇摆/弹入的 pivot）
  neck: number;            // 颈部 y（点头 pivot）
  peaks: { x: number; y: number; v: number }[]; // 注意力点（最多 3 个）
  conf: number;      // 置信度 0..1
  tier: 'precise' | 'ok' | 'fallback';
  source: 'local' | 'remote';
  /** 识别走的分支：纯色底 / 复杂背景（仅用于检查器展示，渲染不依赖） */
  path?: 'uniform' | 'saliency';
  /** 手动框选的主体范围（归一化 x0,y0,x1,y1）：约束下一次识别，渲染不依赖 */
  roi?: [number, number, number, number];
  /** 掩膜指纹，仅供渲染层做背景板缓存：笔刷改 maskUrl 时不失效 */
  seed?: string;
  /** 人工介入过（框选兜底 / 笔刷），状态卡据此显示"手动" */
  manual?: boolean;
  /**
   * 掩膜可信度用途：
   * - `cut`（默认）：贴合剪影，可做「主体抠图 + 背景虚化」分层
   * - `region`：只能当"动效作用区域"（被框切断 / 盖住大半幅 / 识别本身不准），
   *   此时不做景深分层，整幅保持原样，只让这块区域形变
   */
  fit?: 'cut' | 'region';
}

export interface CoverFx {
  speed: number;     // 10..300 (%)
  breathe: number;   // 0..100 主体呼吸
  float: number;     // 0..100 主体漂浮
  sway: number;      // 0..100 摇摆（绕脚底）
  parallax: number;  // 0..100 主体/背景视差
  nod: number;       // 0..100 点头（绕颈部）
  rim: number;       // 0..100 轮廓流光
  pulse: number;     // 0..100 注意力点脉冲
  sweep: number;     // 0..100 扫光强度（斜向光带扫过）
  sweepW: number;    // 8..100 扫光宽度（映射到画板 6%~35%）
  dust: number;      // 0..100 星尘密度（0~56 颗）
  spin: number;      // 0..100 背景缓转（±2.5°）
  zoom: number;      // 0..100 推镜（0~8%，推进后自动退回）
  beat: number;      // 0..100 节拍脉冲（缩放 + 微亮）
  bpm: number;       // 60..180 节拍速度
  strobe: number;    // 0..100 频闪·提亮（硬切闪）
  strobeDark: number;// 0..100 频闪·压暗（黑场闪）
  invert: number;    // 0..100 反相闪（负片感）
  mono: number;      // 0..100 抽色闪（瞬间黑白）
  glitch: number;    // 0..100 切片错位（磁带/信号故障）
  flashHz: number;   // 1..12 频闪族共用频率
  /** 频闪作用范围：0=全幅 1=框选矩形（无框选时用主体包围盒） 2=主体剪影（掩膜，软边） */
  flashScope: number;
  /** 频闪范围内边缘羽化（0..100，映射到画板宽度 0~9%） */
  flashFeather: number;

  /* ---- 滤镜（v0.8.10）：屏幕空间后处理，全部用画布运算，不做逐像素循环 ---- */
  fxPixel: number;    // 0..100 像素化（块 = 0~6% 画板宽）
  fxRgb: number;      // 0..100 色差（通道位移 = 0~2.5% 画板宽）
  fxDuotone: number;  // 0..100 双色调强度
  fxDuoHue: number;   // 0..360 双色调色相（暗部取它，亮部取补色）
  fxScan: number;     // 0..100 扫描线强度
  fxScanGap: number;  // 4..60 扫描线行距（1080 下的像素）
  fxDot: number;      // 0..100 网点强度
  fxDotScale: number; // 3..30 网点格大小（1080 下的像素）
  frameZoom: number; // 100..160 构图缩放（整幅，纯镜头，不改相对几何）
  panX: number;      // -100..100 构图水平平移（占可用余量的比例）
  panY: number;      // -100..100 构图垂直平移
  bgBlur: number;    // 0..60 背景板虚化
  bgDark: number;    // 0..100 背景板压暗
  vignette: number;  // 0..100
  grain: number;     // 0..100
  sat: number;       // 40..200
}

export type CoverPreset =
  | 'still' | 'breathe' | 'float' | 'sway' | 'parallax' | 'rim' | 'pulse' | 'nod'
  | 'sweep' | 'dust' | 'spin' | 'zoom' | 'beat'
  | 'strobe' | 'invert' | 'mono' | 'glitch'
  | 'crt' | 'pixel8' | 'print' | 'chroma';

export const COVER_PRESETS: CoverPreset[] = [
  'breathe', 'float', 'sway', 'parallax', 'rim', 'pulse', 'nod',
  'sweep', 'dust', 'spin', 'zoom', 'beat',
  'strobe', 'invert', 'mono', 'glitch',
  'crt', 'pixel8', 'print', 'chroma', 'still',
];

export const COVER_PRESET_LABELS: Record<CoverPreset, string> = {
  breathe: '呼吸',
  float: '漂浮',
  sway: '站立摇摆',
  parallax: '视差分层',
  rim: '轮廓流光',
  pulse: '注意力点',
  nod: '点头',
  sweep: '扫光',
  dust: '星尘',
  spin: '背景缓转',
  zoom: '推镜',
  beat: '节拍脉冲',
  strobe: '频闪',
  invert: '反相闪',
  mono: '抽色闪',
  glitch: '切片错位',
  crt: '扫描线 CRT',
  pixel8: '8-bit 像素',
  print: '双色印刷',
  chroma: '色差故障',
  still: '静止（只留质感）',
};

export const COVER_RANGES: Record<keyof CoverFx, [number, number]> = {
  speed: [10, 300], breathe: [0, 100], float: [0, 100], sway: [0, 100],
  parallax: [0, 100], nod: [0, 100], rim: [0, 100], pulse: [0, 100],
  sweep: [0, 100], sweepW: [8, 100], dust: [0, 100], spin: [0, 100],
  zoom: [0, 100], beat: [0, 100], bpm: [60, 180],
  frameZoom: [100, 160], panX: [-100, 100], panY: [-100, 100],
  strobe: [0, 100], strobeDark: [0, 100], invert: [0, 100], mono: [0, 100], glitch: [0, 100], flashHz: [1, 12],
  flashScope: [0, 2], flashFeather: [0, 100],
  fxPixel: [0, 100], fxRgb: [0, 100], fxDuotone: [0, 100], fxDuoHue: [0, 360],
  fxScan: [0, 100], fxScanGap: [4, 60], fxDot: [0, 100], fxDotScale: [3, 30],
  bgBlur: [0, 60], bgDark: [0, 100], vignette: [0, 100], grain: [0, 100], sat: [40, 200],
};

export function defaultCoverFx(): CoverFx {
  return {
    speed: 100, breathe: 26, float: 18, sway: 0,
    parallax: 34, nod: 0, rim: 0, pulse: 24,
    /* 新增的四类（光效 / 星尘 / 镜头 / 节奏）默认全关：
       它们是"加分项"，一进来就跟呼吸叠加容易糊成一团。默认只保留呼吸 + 视差 + 注意力点。 */
    sweep: 0, sweepW: 40, dust: 0, spin: 0, zoom: 0, beat: 0, bpm: 120,
    strobe: 0, strobeDark: 0, invert: 0, mono: 0, glitch: 0, flashHz: 3, flashScope: 0, flashFeather: 0,
    fxPixel: 0, fxRgb: 0, fxDuotone: 0, fxDuoHue: 200, fxScan: 0, fxScanGap: 10, fxDot: 0, fxDotScale: 8,
    frameZoom: 100, panX: 0, panY: 0,
    /* 默认不虚化：canvas 的 blur(10px) 是 σ=10，可视扩散约 ±30px，
       对彩色细节背景等于把整幅糊掉（实测背景梯度 15.5 → 2.3）。
       "主体在动、背景保持原样"才是多数人的预期；要景深自己拉这一项。 */
    bgBlur: 0, bgDark: 10, vignette: 18, grain: 10, sat: 104,
  };
}

/** 每个预设只覆盖自己关心的字段，其余沿用默认 */
export const COVER_PRESET_FX: Record<CoverPreset, Partial<CoverFx>> = {
  breathe: { breathe: 52, float: 0, sway: 0, nod: 0, rim: 0, pulse: 14, parallax: 20, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0 },
  float: { breathe: 18, float: 62, sway: 0, nod: 0, rim: 0, pulse: 20, parallax: 40, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0 },
  sway: { breathe: 12, float: 8, sway: 46, nod: 0, rim: 0, pulse: 16, parallax: 28, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0 },
  parallax: { breathe: 10, float: 26, sway: 0, nod: 0, rim: 0, pulse: 18, parallax: 88, bgBlur: 16, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0 },
  rim: { breathe: 14, float: 12, sway: 0, nod: 0, rim: 78, pulse: 26, parallax: 30, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0 },
  pulse: { breathe: 20, float: 10, sway: 0, nod: 0, rim: 0, pulse: 82, parallax: 26, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0 },
  nod: { breathe: 14, float: 6, sway: 10, nod: 58, rim: 0, pulse: 18, parallax: 24, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0 },
  sweep: { breathe: 14, float: 10, nod: 0, rim: 0, pulse: 12, parallax: 26, sweep: 64, sweepW: 34, dust: 0, spin: 0, zoom: 0, beat: 0 },
  dust: { breathe: 16, float: 12, nod: 0, rim: 0, pulse: 10, parallax: 30, sweep: 20, sweepW: 26, dust: 62, spin: 0, zoom: 0, beat: 0 },
  spin: { breathe: 10, float: 8, nod: 0, rim: 0, pulse: 14, parallax: 24, sweep: 0, dust: 0, spin: 48, zoom: 0, beat: 0 },
  zoom: { breathe: 8, float: 6, nod: 0, rim: 0, pulse: 12, parallax: 30, sweep: 0, dust: 0, spin: 0, zoom: 56, beat: 0 },
  beat: { breathe: 12, float: 8, nod: 0, rim: 0, pulse: 28, parallax: 26, sweep: 0, dust: 0, spin: 0, zoom: 28, beat: 60, bpm: 120 },
  /* 频闪族：四个共用同一条方形波（flashHz），预设之间必须把兄弟项显式清零，否则会叠成一片糊 */
  strobe: { breathe: 10, float: 6, nod: 0, rim: 0, pulse: 18, parallax: 22, sweep: 0, dust: 0, spin: 0, zoom: 12, beat: 0,
    strobe: 68, strobeDark: 0, invert: 0, mono: 0, glitch: 0, flashHz: 4 },
  invert: { breathe: 10, float: 6, nod: 0, rim: 0, pulse: 16, parallax: 22, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0,
    strobe: 0, strobeDark: 0, invert: 58, mono: 0, glitch: 0, flashHz: 3 },
  mono: { breathe: 14, float: 8, nod: 0, rim: 0, pulse: 12, parallax: 24, sweep: 18, dust: 0, spin: 0, zoom: 0, beat: 0,
    strobe: 0, strobeDark: 0, invert: 0, mono: 74, glitch: 0, flashHz: 2 },
  glitch: { breathe: 10, float: 6, nod: 0, rim: 0, pulse: 16, parallax: 22, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0,
    strobe: 0, strobeDark: 0, invert: 26, mono: 0, glitch: 62, flashHz: 5 },
  /* 滤镜族：只动画面质感，不动几何 —— 与动效可以任意叠 */
  crt: { breathe: 10, float: 6, nod: 0, rim: 0, pulse: 8, parallax: 22, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0,
    fxScan: 58, fxScanGap: 6, fxRgb: 16, fxDot: 0, fxDotScale: 8, fxPixel: 0, fxDuotone: 0, fxDuoHue: 200 },
  pixel8: { breathe: 8, float: 5, nod: 0, rim: 0, pulse: 10, parallax: 20, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0,
    fxPixel: 62, fxScan: 14, fxScanGap: 14, fxRgb: 0, fxDot: 0, fxDotScale: 8, fxDuotone: 0, fxDuoHue: 200 },
  print: { breathe: 10, float: 6, nod: 0, rim: 0, pulse: 8, parallax: 20, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0,
    fxDot: 42, fxDotScale: 6, fxDuotone: 58, fxDuoHue: 205, fxScan: 0, fxScanGap: 10, fxRgb: 0, fxPixel: 0 },
  chroma: { breathe: 10, float: 6, nod: 0, rim: 0, pulse: 12, parallax: 22, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0,
    fxRgb: 62, fxScan: 22, fxScanGap: 16, fxPixel: 0, fxDot: 0, fxDotScale: 8, fxDuotone: 0, fxDuoHue: 200 },
  still: { breathe: 0, float: 0, sway: 0, nod: 0, rim: 0, pulse: 0, parallax: 0, sweep: 0, dust: 0, spin: 0, zoom: 0, beat: 0,
    strobe: 0, strobeDark: 0, invert: 0, mono: 0, glitch: 0, frameZoom: 100, panX: 0, panY: 0,
    fxPixel: 0, fxRgb: 0, fxDuotone: 0, fxScan: 0, fxDot: 0 },
};

export function coverFxForPreset(p: CoverPreset): CoverFx {
  return { ...defaultCoverFx(), ...COVER_PRESET_FX[p] };
}

/** 反查当前参数最接近哪个预设；都不像就返回 null（UI 显示"自定义"）
 *  按**整组参数**比对（而不是只比预设声明的那几个字段）：
 *  预设从 8 个涨到 13 个之后，只比部分字段会把"呼吸 + 扫光"也报成「呼吸」，误导性太大。 */
export function coverMatchPreset(fx: CoverFx): CoverPreset | null {
  for (const p of COVER_PRESETS) {
    const want = coverFxForPreset(p);
    const keys = Object.keys(want) as (keyof CoverFx)[];
    if (keys.every(k => Math.abs((fx[k] as number) - (want[k] as number)) < 0.5)) return p;
  }
  return null;
}

/** 空封面文档：1:1、无背景层、无文字层。放图之后才有一层 image */
export function emptyCoverDoc(): Doc {
  return {
    version: 1,
    mode: 'cover',
    canvas: { w: 1080, h: 1080, bg: '#0b0d11' },
    duration: 4200,
    layers: [],
  };
}


export type Layer = TextLayer | BgLayer | ImageLayer;

export interface Doc {
  version: 1;
  mode?: DocMode;   // 缺省视为 'poster'（v0.6 及之前的文档）
  canvas: { w: number; h: number; bg: string };
  duration: number; // ms
  layers: Layer[];
}

export const RATIOS: { key: string; label: string; w: number; h: number }[] = [
  { key: '9:16', label: '9:16 竖屏 1080×1920', w: 1080, h: 1920 },
  { key: '3:4', label: '3:4 竖屏 1080×1440', w: 1080, h: 1440 },
  { key: '1:1', label: '1:1 方形 1080×1080', w: 1080, h: 1080 },
  { key: '4:5', label: '4:5 竖版 1080×1350', w: 1080, h: 1350 },
];

export const FONT_STACKS: Record<TextStyle['font'], string> = {
  serif: '"Noto Serif SC Poster", "Noto Serif SC", "Songti SC", "STSong", "SimSun", serif',
  sans: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif SC Poster", serif',
};

export const FONT_LABELS: Record<TextStyle['font'], string> = {
  serif: '思源宋体（内嵌）',
  sans: '系统黑体',
  kai: '系统楷体',
};

export const EASING_LABELS: Record<EasingKey, string> = {
  linear: '线性',
  easeOut: '缓出',
  easeInOut: '缓入缓出',
  back: '回弹',
};

export const PRESET_LABELS: Record<PresetKey, string> = {
  none: '无动画',
  typewriter: '打字机',
  charRise: '逐字上浮',
  lineSlide: '整行滑入',
  maskWipe: '遮罩扫过',
  popScale: '缩放回弹',
  kenBurns: '背景缓推',
};

let _seq = 0;
export function uid(): string {
  return 'l' + Date.now().toString(36) + (_seq++).toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 图片动效默认值：与预演页（album-motion/prototype.html）保持一致 */
export function defaultFx(): ImageFx {
  return {
    speed: 100, breathe: 42, float: 30, spin: 0,
    sweep: 35, angle: 205, glow: 30,
    grain: 12, vignette: 22, warp: 0,
    radius: 17, sat: 108, bgBlur: 26, vinyl: 0,
  };
}

export const FX_RANGES: Record<keyof ImageFx, [number, number]> = {
  speed: [10, 300], breathe: [0, 100], float: [0, 100], spin: [0, 100],
  sweep: [0, 100], angle: [0, 360], glow: [0, 100],
  grain: [0, 100], vignette: [0, 100], warp: [0, 100],
  radius: [0, 50], sat: [40, 200], bgBlur: [0, 60], vinyl: [0, 1],
};

export function defaultDoc(): Doc {
  return {
    version: 1,
    canvas: { w: 1080, h: 1920, bg: '#101418' },
    duration: 4200,
    layers: [
      { id: 'bg', type: 'bg', color1: '#12161c', color2: '#232a33', anim: { preset: 'kenBurns', duration: 4200, delay: 0, stagger: 0, easing: 'easeInOut' } },
      {
        id: uid(), type: 'text',
        text: '把文字海报\n变成会动的片头',
        style: { font: 'serif', size: 104, lineHeight: 1.42, letterSpacing: 6, align: 'center', color: '#F2EDE2', x: 540, y: 880, boxWidth: 900 },
        anim: { preset: 'charRise', duration: 900, delay: 300, stagger: 90, easing: 'easeOut' },
      },
      {
        id: uid(), type: 'text',
        text: '动态海报编辑器',
        style: { font: 'serif', size: 42, lineHeight: 1.4, letterSpacing: 18, align: 'center', color: '#C9B08A', x: 540, y: 1160, boxWidth: 900 },
        anim: { preset: 'lineSlide', duration: 800, delay: 1600, stagger: 120, easing: 'easeOut' },
      },
    ],
  };
}

/** 反序列化 + 迁移：任何结构异常都退回默认文档 */
/**
 * 读工程文件（纯函数，便于单测）。
 *
 * 只认两种形状：`{ kind:'project', doc:{...} }` 的包装，或者裸的 doc。
 * **不能直接丢给 migrateDoc** —— 它在形状不对时会静默返回 defaultDoc()，
 * 于是"导入了一个坏文件"会变成"内容被重置成示例海报"，比报错更糟。
 */
export function readProject(raw: unknown): Doc | null {
  const wrapped = raw as { kind?: string; doc?: unknown } | null;
  const d = (wrapped && wrapped.kind === 'project' ? wrapped.doc : raw) as Partial<Doc> | null;
  if (!d || typeof d !== 'object') return null;
  if ((d as { version?: unknown }).version !== 1) return null;
  if (!Array.isArray(d.layers) || !d.canvas || typeof d.canvas.w !== 'number') return null;
  return migrateDoc(d);
}

export function migrateDoc(raw: unknown): Doc {
  const def = defaultDoc();
  if (!raw || typeof raw !== 'object') return def;
  const d = raw as Partial<Doc>;
  if (d.version !== 1 || !Array.isArray(d.layers)) return def;
  const mode: DocMode = d.mode === 'cover' ? 'cover' : 'poster';
  const duration = Number(d.duration) > 500 ? Number(d.duration) : def.duration;

  if (mode === 'cover') {
    /* 封面模式：画布锁 1:1、只保留图片层（文字/背景一律丢弃）。允许空文档（未放图）。 */
    const layers: Layer[] = [];
    for (const l of d.layers) {
      if (!l || typeof l !== 'object' || l.type !== 'image') continue;
      const src = typeof l.src === 'string' && l.src.startsWith('data:image/') ? l.src : '';
      if (!src) continue;
      layers.push({
        id: typeof l.id === 'string' ? l.id : uid(),
        type: 'image',
        name: typeof l.name === 'string' && l.name.trim() ? l.name.slice(0, 40) : '封面',
        src,
        x: 540, y: 540, w: 1080, h: 1080,   // 封面模式下图片恒铺满画板
        fx: migFx(l.fx),
        cover: migCover(l.cover),
        subject: migSubject(l.subject),
      });
      if (layers.length >= 1) break;        // 封面只有一张图
    }
    return { version: 1, mode: 'cover', canvas: { w: 1080, h: 1080, bg: '#0b0d11' }, duration, layers };
  }

  if (!Array.isArray(d.layers) || d.layers.length === 0) return def;
  const canvas = { w: 1080, h: 1920, bg: '#101418', ...(d.canvas || {}) };
  const layers: Layer[] = [];
  for (const l of d.layers) {
    if (!l || typeof l !== 'object') continue;
    if (l.type === 'bg') {
      layers.push({
        id: typeof l.id === 'string' ? l.id : 'bg',
        type: 'bg',
        color1: str(l.color1, '#12161c'),
        color2: str(l.color2, '#232a33'),
        anim: migAnim(l.anim, 'kenBurns'),
      });
    } else if (l.type === 'text') {
      layers.push({
        id: typeof l.id === 'string' ? l.id : uid(),
        type: 'text',
        text: typeof l.text === 'string' ? l.text : '',
        style: {
          font: ['serif', 'sans', 'kai'].includes(l.style?.font) ? l.style!.font : 'serif',
          size: num(l.style?.size, 96, 16, 400),
          lineHeight: num(l.style?.lineHeight, 1.4, 0.8, 3),
          letterSpacing: num(l.style?.letterSpacing, 4, -20, 80),
          align: ['left', 'center', 'right'].includes(l.style?.align) ? l.style!.align : 'center',
          color: str(l.style?.color, '#F2EDE2'),
          x: num(l.style?.x, 540, -2000, 4000),
          y: num(l.style?.y, 900, -2000, 4000),
          boxWidth: num(l.style?.boxWidth, 900, 100, 2000),
        },
        anim: migAnim(l.anim, 'charRise'),
      });
    } else if (l.type === 'image') {
      const src = typeof l.src === 'string' && l.src.startsWith('data:image/') ? l.src : '';
      if (!src) continue; // 没有图像数据就丢弃，避免出现空图层
      layers.push({
        id: typeof l.id === 'string' ? l.id : uid(),
        type: 'image',
        name: typeof l.name === 'string' && l.name.trim() ? l.name.slice(0, 40) : '图片',
        src,
        x: num(l.x, canvas.w / 2, -4000, 8000),
        y: num(l.y, canvas.h / 2, -4000, 8000),
        w: num(l.w, Math.min(canvas.w, canvas.h) * 0.8, 40, 8000),
        h: num(l.h, Math.min(canvas.w, canvas.h) * 0.8, 40, 8000),
        fx: migFx(l.fx),
      });
    }
  }
  if (layers.length === 0) return def;
  if (!layers.some(l => l.type === 'bg')) {
    layers.unshift({ id: 'bg', type: 'bg', color1: canvas.bg, color2: '#232a33', anim: { preset: 'kenBurns', duration, delay: 0, stagger: 0, easing: 'easeInOut' } });
  }
  return { version: 1, canvas, duration, layers };
}

function migCover(a: any): CoverFx {
  const d = defaultCoverFx();
  const out = { ...d };
  for (const k of Object.keys(d) as (keyof CoverFx)[]) {
    const [lo, hi] = COVER_RANGES[k];
    out[k] = num(a?.[k], d[k], lo, hi);
  }
  return out;
}

/** 识别结果迁移：掩膜必须是 data:image/，坐标一律钳到 0..1，峰值最多 3 个 */
function migSubject(a: any): SubjectInfo | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const maskUrl = typeof a.maskUrl === 'string' && a.maskUrl.startsWith('data:image/') ? a.maskUrl : '';
  if (!maskUrl) return undefined;
  const u01 = (v: any, d = 0.5) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
  };
  const peaks = Array.isArray(a.peaks) ? a.peaks.slice(0, 3).map((p: any) => ({
    x: u01(p?.x), y: u01(p?.y), v: Math.min(1, Math.max(0, Number(p?.v) || 0)),
  })) : [];
  const bbox = Array.isArray(a.bbox) && a.bbox.length === 4
    ? [u01(a.bbox[0], 0), u01(a.bbox[1], 0), u01(a.bbox[2], 1), u01(a.bbox[3], 1)] as [number, number, number, number]
    : [0, 0, 1, 1] as [number, number, number, number];
  const tier = a.tier === 'precise' || a.tier === 'ok' || a.tier === 'fallback' ? a.tier : 'ok';
  return {
    maskUrl,
    mw: num(a.mw, 160, 32, 1024),
    mh: num(a.mh, 160, 32, 1024),
    bbox,
    cx: u01(a.cx), cy: u01(a.cy),
    feet: [u01(Array.isArray(a.feet) ? a.feet[0] : 0.5), u01(Array.isArray(a.feet) ? a.feet[1] : 0.98)],
    neck: u01(a.neck, 0.3),
    peaks,
    conf: Math.min(1, Math.max(0, Number(a.conf) || 0)),
    tier,
    source: a.source === 'remote' ? 'remote' : 'local',
    path: a.path === 'saliency' ? 'saliency' : a.path === 'uniform' ? 'uniform' : undefined,
    roi: migRoi(a.roi),
    seed: typeof a.seed === 'string' && a.seed.length <= 32 ? a.seed : undefined,
    manual: a.manual === true ? true : undefined,
    fit: a.fit === 'region' ? 'region' : a.fit === 'cut' ? 'cut' : undefined,
  };
}

/** 手动框：必须是 0..1 内、且宽高都为正的矩形，否则当作没设 */
export function migRoi(a: any): [number, number, number, number] | undefined {
  if (!Array.isArray(a) || a.length !== 4) return undefined;
  const u = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN;
  };
  const [x0, y0, x1, y1] = a.map(u);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return undefined;
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return undefined;
  return [x0, y0, x1, y1];
}

function migAnim(a: any, fallback: PresetKey): AnimSpec {
  const presets: PresetKey[] = ['none', 'typewriter', 'charRise', 'lineSlide', 'maskWipe', 'popScale', 'kenBurns'];
  const easings: EasingKey[] = ['linear', 'easeOut', 'easeInOut', 'back'];
  return {
    preset: presets.includes(a?.preset) ? a.preset : fallback,
    duration: num(a?.duration, 900, 100, 20000),
    delay: num(a?.delay, 0, 0, 20000),
    stagger: num(a?.stagger, 0, 0, 1000),
    easing: easings.includes(a?.easing) ? a.easing : 'easeOut',
  };
}
function migFx(a: any): ImageFx {

  const d = defaultFx();
  const out = { ...d };
  for (const k of Object.keys(d) as (keyof ImageFx)[]) {
    const [lo, hi] = FX_RANGES[k];
    out[k] = num(a?.[k], d[k], lo, hi);
  }
  return out;
}

function str(v: any, d: string) { return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : d; }
function num(v: any, d: number, lo: number, hi: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

export function isText(l: Layer): l is TextLayer { return l.type === 'text'; }
export function isBg(l: Layer): l is BgLayer { return l.type === 'bg'; }
export function isImage(l: Layer): l is ImageLayer { return l.type === 'image'; }
export function isCover(d: Doc): boolean { return d.mode === 'cover'; }
/** 封面的那张图（封面模式有且只有一张） */
export function coverLayer(d: Doc): ImageLayer | null {
  for (const l of d.layers) if (isImage(l)) return l;
  return null;
}

export function modeOf(d: Doc): DocMode { return d.mode === 'cover' ? 'cover' : 'poster'; }

/**
 * 整篇替换（模式切换用）。
 * 必须逐字段覆盖而不是 Object.assign：海报文档没有 mode 字段，
 * 直接 assign 会让封面模式残留下来，切回去还是封面。
 */
export function applyDoc(dst: Doc, src: Doc) {
  const s = structuredClone(src);
  dst.version = 1;
  dst.mode = s.mode;
  dst.canvas = s.canvas;
  dst.duration = s.duration;
  dst.layers = s.layers;
}
