/** Short music breaks, with most of the screensaver reserved for roaming. */
export class ScreensaverDance {
  private until = -1;
  private next = Infinity;

  reset(t: number) {
    this.until = -1;
    this.next = t + 45 + Math.random() * 30;
  }

  allows(t: number, requested: boolean, onFloor: boolean): boolean {
    if (requested && onFloor && t >= this.next && t >= this.until) {
      this.until = t + 10 + Math.random() * 8;
      this.next = t + 75 + Math.random() * 45;
    }
    return t < this.until;
  }
}
