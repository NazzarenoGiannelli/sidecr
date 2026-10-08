import type { Bounds } from "../src/window-bounds";

export function readWindowBounds(win: { screenX: number; screenY: number; outerWidth: number; outerHeight: number }): Bounds {
  return { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight };
}

/** A window with less than this many px visible, horizontally or vertically, is treated as off the screen. */
const MIN_VISIBLE = 80;
const MARGIN = 40;

const visible = (start: number, size: number, areaStart: number, areaSize: number) =>
  Math.min(start + size, areaStart + areaSize) - Math.max(start, areaStart);

/** True when the window is essentially outside `area` (the available screen area), for example after its monitor was unplugged. */
export function needsRecovery(b: Bounds, area: Bounds): boolean {
  return visible(b.x, b.w, area.x, area.w) < MIN_VISIBLE || visible(b.y, b.h, area.y, area.h) < MIN_VISIBLE;
}

/** Where to put an off-screen window: 40 px inside the area, shrunk to the area if it is larger, never sticking out. */
export function recoveredPosition(b: Bounds, area: Bounds): Bounds {
  const w = Math.min(b.w, area.w);
  const h = Math.min(b.h, area.h);
  return {
    x: Math.min(area.x + MARGIN, area.x + area.w - w),
    y: Math.min(area.y + MARGIN, area.y + area.h - h),
    w,
    h,
  };
}

export function boundsEqual(a: Bounds | null, b: Bounds): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
