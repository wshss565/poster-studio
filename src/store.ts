import type { Doc } from './doc';
import { defaultDoc, migrateDoc, applyDoc } from './doc';

export interface StoreState {
  doc: Doc;
  selectedId: string | null;
  playing: boolean;
  loop: boolean;
}

const STORAGE_KEY = 'poster-studio.v1';
const UNDO_LIMIT = 50;
const UNDO_LIMIT_IMG = 20; // 含图片时快照体积大，减少栈深避免内存压力

export class Store {
  state: StoreState;
  revision = 0;
  onSave: (() => void) | null = null;
  onSaveError: ((msg: string) => void) | null = null;

  private listeners = new Set<() => void>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.state = { doc: this.load(), selectedId: null, playing: false, loop: true };
    const firstText = this.state.doc.layers.find(l => l.type === 'text');
    this.state.selectedId = firstText ? firstText.id : null;
  }

  private load(): Doc {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return migrateDoc(JSON.parse(raw));
    } catch { /* 忽略损坏数据 */ }
    return defaultDoc();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() { this.listeners.forEach(f => f()); }

  /** 预览：修改文档但不入 undo 栈（滑块拖动、画布拖拽过程中用） */
  preview(fn: (draft: Doc) => void) {
    const draft = structuredClone(this.state.doc);
    fn(draft);
    this.state.doc = draft;
    this.emit();
    // 预览也必须落盘：滑块 / 输入框 / 拖拽全走这里，不存就等于「调完参数关页面全丢」。
    // scheduleSave 是 300ms 防抖，连续拖动只在停手后写一次。
    this.scheduleSave();
  }

  /** 提交：修改文档并压入 undo 栈 */
  commit(fn: (draft: Doc) => void) {
    const before = JSON.stringify(this.state.doc);
    const draft = structuredClone(this.state.doc);
    fn(draft);
    const after = JSON.stringify(draft);
    if (after === before) return;
    this.undoStack.push(before);
    this.trimUndo();
    this.redoStack = [];
    this.state.doc = draft;
    this.revision++;
    this.emit();
    this.scheduleSave();
  }

  /** 拖拽开始时的检查点：把当前状态压入 undo 栈，之后的 preview 都可被一步撤销 */
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.state.doc));
    this.trimUndo();
    this.redoStack = [];
  }

  select(id: string | null) {
    if (this.state.selectedId !== id) {
      this.state.selectedId = id;
      this.emit();
    }
  }

  setPlaying(p: boolean) {
    if (this.state.playing !== p) { this.state.playing = p; this.emit(); }
  }

  setLoop(b: boolean) {
    if (this.state.loop !== b) { this.state.loop = b; this.emit(); }
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.state.doc));
    this.state.doc = migrateDoc(JSON.parse(prev));
    this.revision++;
    this.emit();
    this.scheduleSave();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.state.doc));
    this.state.doc = migrateDoc(JSON.parse(next));
    this.revision++;
    this.emit();
    this.scheduleSave();
  }

  /** 重置为给定文档（缺省为示例海报）；封面模式传 emptyCoverDoc() */
  resetDoc(d?: Doc) {
    const next = d ?? defaultDoc();
    this.commit(draft => applyDoc(draft, next));
    const first = this.state.doc.layers.find(l => l.type === 'text' || l.type === 'image');
    this.select(first ? first.id : null);
  }

  /** 含图片时降低撤销栈深度：每步快照包含 dataURL，50 步会吃掉几十 MB */
  private trimUndo() {
    const limit = this.state.doc.layers.some(l => l.type === 'image') ? UNDO_LIMIT_IMG : UNDO_LIMIT;
    while (this.undoStack.length > limit) this.undoStack.shift();
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state.doc));
        this.onSave?.();
      } catch (err) {
        this.onSaveError?.((err as Error).message || '存储空间不足');
      }
    }, 300);
  }
}
