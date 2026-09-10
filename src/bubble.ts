/**
 * Speech bubble: a small DOM element positioned above the character's head.
 * It lives outside the canvas, so it never affects the pixel hit-test and is
 * always click-through.
 */
export class Bubble {
  private el: HTMLDivElement;
  private hideAt = 0;
  private lastLine = "";

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "bubble";
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  /** Show one of the lines (never the same one twice in a row) for `seconds`. */
  say(lines: string[] | undefined, seconds = 2.5, now = performance.now() / 1000) {
    if (!lines || lines.length === 0) return;
    let line = lines[Math.floor(Math.random() * lines.length)];
    if (lines.length > 1 && line === this.lastLine) line = lines[(lines.indexOf(line) + 1) % lines.length];
    this.lastLine = line;
    this.el.textContent = line;
    this.el.hidden = false;
    this.el.classList.remove("pop");
    void this.el.offsetWidth; // restart the pop animation
    this.el.classList.add("pop");
    this.hideAt = now + seconds;
  }

  hide() {
    this.el.hidden = true;
    this.hideAt = 0;
  }

  /** Reposition each frame; (x, y) is the top of the head in CSS pixels. */
  update(now: number, headX: number, headY: number, stageW: number) {
    if (this.el.hidden) return;
    if (now >= this.hideAt) {
      this.hide();
      return;
    }
    const w = this.el.offsetWidth;
    const left = Math.max(4, Math.min(stageW - w - 4, headX - w / 2));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.max(2, headY - this.el.offsetHeight - 12)}px`;
    // Tail points at the head.
    this.el.style.setProperty("--tail", `${Math.max(12, Math.min(w - 12, headX - left))}px`);
  }
}
