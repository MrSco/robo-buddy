/** A clock whose deadlines stop with the simulation, not just its rendered frames. */
export class SimulationClock {
  elapsedTime = 0;
  private last: number;
  private paused = false;
  constructor(private now: () => number = () => performance.now()) {
    this.last = now();
  }
  setPaused(paused: boolean) {
    this.last = this.now();
    this.paused = paused;
  }
  getDelta() {
    const now = this.now();
    const dt = this.paused ? 0 : Math.max(0, Math.min((now - this.last) / 1000, 0.1));
    this.last = now;
    this.elapsedTime += dt;
    return dt;
  }
}
