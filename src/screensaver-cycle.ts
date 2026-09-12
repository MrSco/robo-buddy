export interface DesktopRect { x: number; y: number; width: number; height: number }
export interface CrtCycle { startedAt: number; voidSeconds: number }
export const CRT_SECONDS = 1.35;

/** Zero is buddy-only; the default 20% takes about eight minutes without his hits. */
export function erosionSeconds(speed: number): number {
  const value = Number.isFinite(speed) ? Math.max(0, Math.min(100, speed)) : 20;
  return value === 0 ? Infinity : 600 - 560 * value / 100;
}

export function cyclePhase(cycle: CrtCycle, now: number): "waiting" | "crtOff" | "void" | "erode" {
  const seconds = (now - cycle.startedAt) / 1000;
  if (seconds < 0) return "waiting";
  if (seconds < CRT_SECONDS) return "crtOff";
  if (seconds < CRT_SECONDS + cycle.voidSeconds) return "void";
  return "erode";
}

/** All monitors draw this same global geometry, clipped by their own canvas. */
export function crtShape(rect: DesktopRect, seconds: number) {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  if (seconds < 0 || seconds >= CRT_SECONDS) return null;
  if (seconds < 0.6) {
    const height = Math.max(3, rect.height * (1 - seconds / 0.6) ** 2);
    return { x: rect.x, y: cy - height / 2, width: rect.width, height, alpha: 0.85, round: false };
  }
  if (seconds < 1) {
    const width = Math.max(1, rect.width * (1 - (seconds - 0.6) / 0.4) ** 2);
    return { x: cx - width / 2, y: cy - 2.5, width, height: 5, alpha: 0.95, round: false };
  }
  const p = (seconds - 1) / 0.35, radius = 4 + p * 3;
  return { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2, alpha: 0.95 * (1 - p), round: true };
}

export function drawCrtSlice(ctx: CanvasRenderingContext2D, monitor: DesktopRect, desktop: DesktopRect, seconds: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const shape = crtShape(desktop, seconds);
  if (shape) {
    const sx = ctx.canvas.width / monitor.width, sy = ctx.canvas.height / monitor.height;
    ctx.setTransform(sx, 0, 0, sy, -monitor.x * sx, -monitor.y * sy);
    ctx.fillStyle = "#eaf6ff";
    ctx.globalAlpha = shape.alpha;
    if (shape.round) {
      ctx.beginPath();
      ctx.arc(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.fillRect(shape.x, shape.y, shape.width, shape.height);
  }
  ctx.restore();
}
