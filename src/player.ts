export class Player {
  currentTime = 0;
  loop = true;
  onEnd: (() => void) | null = null;
  onFrame: ((t: number) => void) | null = null;

  private raf = 0;
  private last = 0;
  private running = false;

  constructor(private duration: () => number) {}

  get isRunning() { return this.running; }

  play() {
    if (this.running) return;
    if (this.currentTime >= this.duration()) this.currentTime = 0;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const dt = now - this.last;
      this.last = now;
      this.currentTime += dt;
      const dur = this.duration();
      if (this.currentTime >= dur) {
        if (this.loop && dur > 0) {
          this.currentTime = this.currentTime % dur;
        } else {
          this.currentTime = dur;
          this.running = false;
          this.onFrame?.(this.currentTime);
          this.onEnd?.();
          return;
        }
      }
      this.onFrame?.(this.currentTime);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  toggle() { this.running ? this.pause() : this.play(); }

  seek(t: number) {
    const dur = this.duration();
    this.currentTime = Math.max(0, Math.min(dur, t));
    this.onFrame?.(this.currentTime);
  }
}
