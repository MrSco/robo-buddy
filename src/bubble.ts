/**
 * Speech bubble: a small DOM element positioned above the character's head.
 * It lives outside the canvas, so it never affects the pixel hit-test and is
 * click-through by default, but supports interactive action chips when provided.
 */

export interface BubbleChip {
  label: string;
  action: string;
  prompt?: string;
  data?: string;
}

export class Bubble {
  private el: HTMLDivElement;
  private textEl: HTMLDivElement;
  private chipsEl: HTMLDivElement;
  private hideAt = 0;
  private lastLine = "";
  /** A showing bubble with a higher priority is not replaced by a lower one (replies beat quips). */
  priority = 0;
  onShow?: () => void;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "bubble";
    this.el.hidden = true;

    this.textEl = document.createElement("div");
    this.textEl.className = "bubble-text";

    this.chipsEl = document.createElement("div");
    this.chipsEl.className = "bubble-chips";
    this.chipsEl.hidden = true;

    this.el.append(this.textEl, this.chipsEl);
    document.body.appendChild(this.el);
  }

  /** Show one of the lines (never the same one twice in a row) for `seconds`, with optional action chips. */
  say(
    lines: string[] | undefined,
    seconds = 2.5,
    now = performance.now() / 1000,
    priority = 0,
    chips?: BubbleChip[],
    onChip?: (chip: BubbleChip) => void,
  ) {
    if (!lines || lines.length === 0) return;
    if (!this.el.hidden && now < this.hideAt && this.priority > priority) return;
    this.priority = priority;
    let line = lines[Math.floor(Math.random() * lines.length)];
    if (lines.length > 1 && line === this.lastLine) line = lines[(lines.indexOf(line) + 1) % lines.length];
    this.lastLine = line;
    this.el.classList.remove("listening");
    this.textEl.textContent = line;
    this.el.classList.toggle("long", line.length > 28);
    this.el.classList.toggle("xl", line.length > 120);

    this.chipsEl.innerHTML = "";
    if (chips && chips.length > 0) {
      this.el.classList.add("has-chips");
      this.chipsEl.hidden = false;
      for (const chip of chips) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bubble-chip";
        if (chip.action === "mute" || chip.action === "dismiss") {
          btn.classList.add("secondary");
        }
        btn.textContent = chip.label;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (onChip) onChip(chip);
        });
        this.chipsEl.appendChild(btn);
      }
    } else {
      this.el.classList.remove("has-chips");
      this.chipsEl.hidden = true;
    }

    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    this.el.classList.remove("pop");
    void this.el.offsetWidth; // restart the pop animation
    this.el.classList.add("pop");
    if (wasHidden && this.onShow) this.onShow();
    this.hideAt = now + seconds;
  }

  /** Height in CSS px while showing, else 0; the camera reserves this much above the head. */
  visibleHeight(): number {
    return this.el.hidden ? 0 : this.el.offsetHeight;
  }

  hide() {
    this.el.hidden = true;
    this.chipsEl.hidden = true;
    this.chipsEl.innerHTML = "";
    this.el.classList.remove("has-chips");
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
    this.textEl.textContent = `🎤 ${text}`;
    this.chipsEl.hidden = true;
    this.chipsEl.innerHTML = "";
    this.el.classList.remove("has-chips");
    this.el.classList.add("listening");
    this.el.classList.toggle("long", text.length > 28);
    this.el.classList.toggle("xl", text.length > 120);
    this.el.hidden = false;
    this.hideAt = Infinity;
  }

  /** True while a heard line is showing, so a caller can leave it up instead of talking over it. */
  get listening(): boolean {
    return !this.el.hidden && this.el.classList.contains("listening");
  }

  /** True while interactive chips are present in the visible bubble. */
  get hasChips(): boolean {
    return !this.el.hidden && !this.chipsEl.hidden && this.chipsEl.children.length > 0;
  }

  /** Hit test client (x, y) coordinates against clickable chips. */
  hitTest(x: number, y: number): boolean {
    if (this.el.hidden || this.chipsEl.hidden) return false;
    const buttons = this.chipsEl.querySelectorAll<HTMLButtonElement>("button");
    for (let i = 0; i < buttons.length; i++) {
      const r = buttons[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return true;
      }
    }
    return false;
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
