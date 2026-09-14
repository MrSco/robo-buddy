/** Only the newest asynchronous operation owns its loading/error message. */
export class LoadingOwner {
  private serial = 0;
  begin() {
    return ++this.serial;
  }
  owns(ticket: number) {
    return ticket === this.serial;
  }
  cancel() {
    ++this.serial;
  }
}
export class PreviewLoading {
  private owner = new LoadingOwner();
  private element: HTMLDivElement;
  constructor(canvas: HTMLCanvasElement) {
    this.element = document.createElement("div");
    this.element.className = "preview-loading";
    this.element.setAttribute("role", "status");
    this.element.hidden = true;
    canvas.parentElement?.append(this.element);
  }
  begin() {
    const ticket = this.owner.begin();
    this.element.hidden = false;
    this.element.classList.remove("failed");
    this.element.textContent = "Loading…";
    return ticket;
  }
  finish(ticket: number, error?: unknown) {
    if (!this.owner.owns(ticket)) return;
    this.element.hidden = !error;
    this.element.classList.toggle("failed", !!error);
    if (error) this.element.textContent = "Could not load this preview. Try selecting it again.";
  }
  cancel() {
    this.owner.cancel();
    this.element.hidden = true;
  }
}
