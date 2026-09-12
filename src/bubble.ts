/**
 * Speech bubble: a small DOM element positioned above the character's head.
 * It lives outside the canvas, so it never affects the pixel hit-test and is
 * always click-through.
 */
export class Bubble {
  private el: HTMLDivElement;
  private hideAt = 0;
  private lastLine = "";
  /** A showing bubble with a higher priority is not replaced by a lower one (replies beat quips). */
  priority = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "bubble";
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  /** Show one of the lines (never the same one twice in a row) for `seconds`. */
  say(lines: string[] | undefined, seconds = 2.5, now = performance.now() / 1000, priority = 0) {
    if (!lines || lines.length === 0) return;
    if (!this.el.hidden && now < this.hideAt && this.priority > priority) return;
    this.priority = priority;
    let line = lines[Math.floor(Math.random() * lines.length)];
    if (lines.length > 1 && line === this.lastLine) line = lines[(lines.indexOf(line) + 1) % lines.length];
    this.lastLine = line;
    this.el.classList.remove("listening");
    this.el.textContent = line;
    this.el.classList.toggle("long", line.length > 28);
    this.el.classList.toggle("xl", line.length > 120);
    this.el.hidden = false;
    this.el.classList.remove("pop");
    void this.el.offsetWidth; // restart the pop animation
    this.el.classList.add("pop");
    this.hideAt = now + seconds;
  }

  /** Height in CSS px while showing, else 0; the camera reserves this much above the head. */
  visibleHeight(): number {
    return this.el.hidden ? 0 : this.el.offsetHeight;
  }

  hide() {
    this.el.hidden = true;
    this.hideAt = 0;
    this.priority = 0;
  }

  /** Hide only if what is showing has this priority (closing the talk strip drops the reply). */
  hideIf(priority: number) {
    if (this.priority === priority) this.hide();
  }

  /** Enter or update listening state with interim text and high priority. */
  listen(text = "Listening…", priority = 10) {
    this.priority = priority;
    this.el.textContent = `🎤 ${text}`;
    this.el.classList.add("listening");
    this.el.classList.toggle("long", text.length > 28);
    this.el.classList.toggle("xl", text.length > 120);
    this.el.hidden = false;
    this.hideAt = Infinity;
  }

  /** Leave the listening state; a reply that already replaced it is left alone. */
  stopListening() {
    if (!this.el.classList.contains("listening")) return;
    this.el.classList.remove("listening");
    this.hide();
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
