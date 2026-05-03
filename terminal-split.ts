import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { FixedClusterRender } from "./fixed-cluster.ts";

export interface TerminalLike {
  columns: number;
  rows: number;
  kittyProtocolActive?: boolean;
  write(data: string): void;
}

export interface SplitCompositorOptions {
  tui: any;
  terminal: TerminalLike;
  renderCluster: (width: number, terminalRows: number) => FixedClusterRender;
  getShowHardwareCursor?: () => boolean;
  mouseScroll?: boolean;
}

interface Patch { target: { render(width: number): string[] }; originalRender: (width: number) => string[] }

export function beginSync() { return "\x1b[?2026h"; }
export function endSync() { return "\x1b[?2026l"; }
export function resetScrollRegion() { return "\x1b[r"; }
export function setScrollRegion(top: number, bottom: number) { return `\x1b[${top};${bottom}r`; }
export function moveCursor(row: number, col: number) { return `\x1b[${row};${col}H`; }
export function emergencyTerminalReset() {
  return beginSync() + resetScrollRegion() + "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007h\x1b[?1049l\x1b[<999u\x1b[>4;0m" + endSync();
}

function clearLine() { return "\x1b[2K"; }
function hideCursor() { return "\x1b[?25l"; }
function showCursor() { return "\x1b[?25h"; }
function enterAlt() { return "\x1b[?1049h"; }
function exitAlt() { return "\x1b[?1049l"; }
function enableMouse() { return "\x1b[?1002h\x1b[?1006h"; }
function disableMouse() { return "\x1b[?1006l\x1b[?1002l\x1b[?1000l"; }
function disableAltScroll() { return "\x1b[?1007l"; }
function enableAltScroll() { return "\x1b[?1007h"; }
function stripOsc(line: string) { return line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ""); }
function hasTerminalGraphic(line: string) {
  // Kitty graphics are APC sequences: ESC _ G ... ESC \\.
  // iTerm2 images are usually OSC 1337 file sequences.
  return /\x1b_G[\s\S]*?(?:\x07|\x1b\\)/.test(line) || /\x1b\]1337;File=/.test(line);
}
function safeRootLine(line: string, width: number) {
  if (hasTerminalGraphic(line)) return truncateToWidth("[image omitted in floating-input mode]", width, "", true);
  const safe = stripOsc(line);
  return visibleWidth(safe) > width ? truncateToWidth(safe, width, "", true) : safe;
}
function readRows(terminal: TerminalLike, descriptor?: PropertyDescriptor) {
  const value = descriptor?.get ? descriptor.get.call(terminal) : Reflect.get(terminal, "rows");
  return typeof value === "number" && Number.isFinite(value) ? value : 24;
}
function descriptorForRows(terminal: TerminalLike): PropertyDescriptor | undefined {
  let target: object | null = terminal;
  while (target) {
    const d = Object.getOwnPropertyDescriptor(target, "rows");
    if (d) return d;
    target = Object.getPrototypeOf(target);
  }
}
function sanitize(line: string, width: number) {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
}
function parseMouseWheel(data: string): number {
  const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
  if (!match) return 0;
  const code = Number(match[1]);
  const base = code & ~(4 | 8 | 16 | 32);
  if (base === 64) return 3;
  if (base === 65) return -3;
  return 0;
}
function keyScrollDelta(data: string): number {
  if (isKeyRelease(data)) return 0;
  if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+shift+up") || matchesKey(data, "super+up")) return 10;
  if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+shift+down") || matchesKey(data, "super+down")) return -10;
  return 0;
}

export function buildClusterPaint(cluster: FixedClusterRender, rows: number, width: number, showHardwareCursor: boolean): string {
  if (cluster.lines.length === 0) return "";
  const startRow = Math.max(1, rows - cluster.lines.length + 1);
  let out = resetScrollRegion();
  for (let i = 0; i < cluster.lines.length; i++) {
    out += moveCursor(startRow + i, 1) + clearLine() + sanitize(cluster.lines[i] ?? "", width);
  }
  if (cluster.cursor && showHardwareCursor) out += moveCursor(startRow + cluster.cursor.row, Math.max(1, cluster.cursor.col + 1)) + showCursor();
  else out += hideCursor();
  return out;
}

export class SplitCompositor {
  private tui: any;
  private terminal: TerminalLike;
  private renderCluster: SplitCompositorOptions["renderCluster"];
  private getShowHardwareCursor: () => boolean;
  private mouseScroll: boolean;
  private rowsDescriptor?: PropertyDescriptor;
  private originalWrite: (data: string) => void;
  private originalRender: ((width: number) => string[]) | null;
  private originalDoRender: (() => void) | null;
  private patches: Patch[] = [];
  private removeInput?: () => void;
  private cleanup?: () => void;
  private installed = false;
  private disposed = false;
  private writing = false;
  private renderingRoot = false;
  private renderingCluster = false;
  private rootLines: string[] = [];
  private visibleRows = 1;
  private scrollOffset = 0;
  private maxScrollOffset = 0;

  constructor(options: SplitCompositorOptions) {
    this.tui = options.tui;
    this.terminal = options.terminal;
    this.renderCluster = options.renderCluster;
    this.getShowHardwareCursor = options.getShowHardwareCursor ?? (() => false);
    this.mouseScroll = options.mouseScroll !== false;
    this.rowsDescriptor = descriptorForRows(options.terminal);
    this.originalWrite = options.terminal.write.bind(options.terminal);
    this.originalRender = typeof options.tui.render === "function" ? options.tui.render.bind(options.tui) : null;
    this.originalDoRender = typeof options.tui.doRender === "function" ? options.tui.doRender.bind(options.tui) : null;
  }

  install() {
    if (this.installed) return;
    this.originalWrite(beginSync() + enterAlt() + disableAltScroll() + (this.mouseScroll ? enableMouse() : "") + endSync());
    this.cleanup = () => { if (!this.disposed) this.restore(); };
    process.once("exit", this.cleanup);
    Object.defineProperty(this.terminal, "rows", { configurable: true, get: () => this.getScrollableRows() });
    if (this.originalRender) this.tui.render = (width: number) => this.renderRoot(width);
    if (typeof this.tui.addInputListener === "function") this.removeInput = this.tui.addInputListener((data: string) => this.handleInput(data));
    this.terminal.write = (data: string) => this.write(data);
    if (this.originalDoRender) this.tui.doRender = () => { this.originalDoRender?.(); this.repaint(); };
    this.installed = true;
  }

  hideRenderable(target: { render(width: number): string[] }) {
    if (this.patches.some((p) => p.target === target)) return;
    const originalRender = target.render.bind(target);
    this.patches.push({ target, originalRender });
    target.render = () => [];
  }

  renderHidden(target: { render(width: number): string[] }, width: number): string[] {
    const patch = this.patches.find((p) => p.target === target);
    return (patch?.originalRender ?? target.render.bind(target))(width);
  }

  jumpBottom() { this.scrollOffset = 0; this.requestRender(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.patches.splice(0)) p.target.render = p.originalRender;
    this.removeInput?.();
    if (this.cleanup) process.removeListener("exit", this.cleanup);
    this.terminal.write = this.originalWrite;
    if (this.originalRender) this.tui.render = this.originalRender;
    if (this.originalDoRender) this.tui.doRender = this.originalDoRender;
    if (this.rowsDescriptor) Object.defineProperty(this.terminal, "rows", this.rowsDescriptor);
    else Reflect.deleteProperty(this.terminal, "rows");
    this.restore();
  }

  private restore() { this.originalWrite(beginSync() + resetScrollRegion() + (this.mouseScroll ? disableMouse() : "") + enableAltScroll() + exitAlt() + endSync()); }
  private rawRows() { return Math.max(2, readRows(this.terminal, this.rowsDescriptor)); }
  private width() { return Math.max(1, this.terminal.columns || 80); }
  private cluster(width = this.width(), rows = this.rawRows()) {
    this.renderingCluster = true;
    try { return this.renderCluster(width, rows); } finally { this.renderingCluster = false; }
  }
  private getScrollableRows() {
    if (this.disposed || this.writing || this.renderingCluster || this.hasOverlay()) return this.rawRows();
    const cluster = this.cluster(this.width(), this.rawRows());
    return Math.max(1, this.rawRows() - cluster.lines.length);
  }
  private renderRoot(width: number): string[] {
    if (!this.originalRender || this.renderingRoot || this.hasOverlay()) return this.originalRender?.(width).map((l) => safeRootLine(l, width)) ?? [];
    this.renderingRoot = true;
    try {
      const rawRows = this.rawRows();
      const cluster = this.cluster(Math.max(1, width), rawRows);
      const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
      const lines = this.originalRender(width).map((l) => safeRootLine(l, width));
      this.rootLines = lines;
      this.visibleRows = scrollableRows;
      this.maxScrollOffset = Math.max(0, lines.length - scrollableRows);
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));
      const start = Math.max(0, lines.length - scrollableRows - this.scrollOffset);
      const visible = lines.slice(start, start + scrollableRows);
      while (visible.length < scrollableRows) visible.push("");
      return visible;
    } finally { this.renderingRoot = false; }
  }
  private handleInput(data: string): { consume?: boolean } | undefined {
    if (this.disposed || this.hasOverlay()) return undefined;
    const delta = (this.mouseScroll ? parseMouseWheel(data) : 0) || keyScrollDelta(data);
    if (!delta) return undefined;
    const next = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScrollOffset));
    if (next !== this.scrollOffset) { this.scrollOffset = next; this.requestRender(); }
    return { consume: true };
  }
  private write(data: string) {
    if (this.disposed || this.writing || this.hasOverlay()) { this.originalWrite(data); return; }
    this.writing = true;
    try {
      const rows = this.rawRows();
      const width = this.width();
      const cluster = this.cluster(width, rows);
      const reserved = cluster.lines.length;
      if (reserved === 0) { this.originalWrite(data); return; }
      const scrollBottom = Math.max(1, rows - reserved);
      const cursorRow = typeof this.tui.hardwareCursorRow === "number" ? this.tui.hardwareCursorRow : 1;
      const viewportTop = typeof this.tui.previousViewportTop === "number" ? this.tui.previousViewportTop : 0;
      const screenRow = Math.max(1, Math.min(scrollBottom, cursorRow - viewportTop + 1));
      this.originalWrite(beginSync() + setScrollRegion(1, scrollBottom) + moveCursor(screenRow, 1) + data + buildClusterPaint(cluster, rows, width, this.getShowHardwareCursor()) + endSync());
    } finally { this.writing = false; }
  }
  private repaint() {
    if (this.disposed || this.hasOverlay()) return;
    const rows = this.rawRows();
    const width = this.width();
    this.originalWrite(beginSync() + buildClusterPaint(this.cluster(width, rows), rows, width, this.getShowHardwareCursor()) + endSync());
  }
  private requestRender() { if (typeof this.tui.requestRender === "function") this.tui.requestRender(); }
  private hasOverlay(): boolean {
    if (typeof this.tui.hasOverlay === "function" && this.tui.hasOverlay()) return true;
    const stack = Reflect.get(this.tui, "overlayStack");
    return Array.isArray(stack) && stack.some((e) => e && e.hidden !== true);
  }
}
