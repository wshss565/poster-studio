import type { AnimSpec, PresetKey } from './doc';
import { ease, unitProgress } from './easing';

export interface LayerProps {
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  clipTop: number | null; // 0..1，null 表示不裁剪；自该比例处向下显示
}

/** 整层属性（maskWipe / popScale / kenBurns / none） */
export function layerProps(spec: AnimSpec, t: number): LayerProps {
  const p = unitProgress(t, spec.delay, spec.duration);
  switch (spec.preset) {
    case 'maskWipe':
      return { alpha: 1, dx: 0, dy: 0, scale: 1, clipTop: 1 - p };
    case 'popScale':
      return { alpha: 1, dx: 0, dy: 0, scale: 1 + 0.12 * Math.sin(Math.PI * p), clipTop: null };
    case 'kenBurns':
      return { alpha: 1, dx: 0, dy: 0, scale: 1 + 0.08 * ease(spec.easing, p), clipTop: null };
    default:
      return { alpha: 1, dx: 0, dy: 0, scale: 1, clipTop: null };
  }
}

/** 逐字/逐行透明度（charRise / lineSlide / typewriter） */
export function charAlpha(spec: AnimSpec, t: number, index: number): number {
  if (spec.preset === 'none') return 1;
  const p = unitProgress(t, spec.delay + index * spec.stagger, spec.duration);
  return ease(spec.easing, p);
}

/** 逐字/逐行位移 */
export function charOffset(spec: AnimSpec, t: number, index: number): { dx: number; dy: number } {
  if (spec.preset === 'charRise') {
    const p = unitProgress(t, spec.delay + index * spec.stagger, spec.duration);
    return { dx: 0, dy: (1 - ease(spec.easing, p)) * 48 };
  }
  if (spec.preset === 'lineSlide') {
    const p = unitProgress(t, spec.delay + index * spec.stagger, spec.duration);
    return { dx: (1 - ease(spec.easing, p)) * 260, dy: 0 };
  }
  return { dx: 0, dy: 0 };
}

/** 打字机：当前应显示的字符数（全局索引） */
export function visibleChars(spec: AnimSpec, t: number, total: number): number {
  if (spec.preset !== 'typewriter') return total;
  const p = ease(spec.easing, unitProgress(t, spec.delay, spec.duration));
  return Math.max(0, Math.min(total, Math.floor(p * total)));
}

/** 打字机光标透明度（打字进行中闪烁，结束后隐藏） */
export function caretAlpha(spec: AnimSpec, t: number): number {
  if (spec.preset !== 'typewriter') return 0;
  const p = unitProgress(t, spec.delay, spec.duration);
  if (p >= 1) return 0;
  return 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t / 260));
}

/** 动画总时长（供时间轴显示） */
export function animSpan(spec: AnimSpec, units: number): number {
  if (spec.preset === 'none' || spec.duration <= 0) return 0;
  return spec.delay + spec.duration + Math.max(0, units - 1) * spec.stagger;
}

export const PRESET_ORDER: PresetKey[] = ['none', 'typewriter', 'charRise', 'lineSlide', 'maskWipe', 'popScale', 'kenBurns'];
export const TEXT_PRESETS: PresetKey[] = ['none', 'typewriter', 'charRise', 'lineSlide', 'maskWipe', 'popScale'];
