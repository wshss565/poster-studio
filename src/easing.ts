import type { EasingKey } from './doc';

export function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }

export function ease(k: EasingKey, t: number): number {
  const x = clamp01(t);
  switch (k) {
    case 'linear': return x;
    case 'easeOut': return 1 - Math.pow(1 - x, 3);
    case 'easeInOut': return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'back': {
      const c = 1.70158;
      return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
    }
    default: return x;
  }
}

/** 单个单元的进度：t 相对于 delay+duration 的位置 */
export function unitProgress(t: number, delay: number, duration: number): number {
  if (duration <= 0) return 1;
  return clamp01((t - delay) / duration);
}
