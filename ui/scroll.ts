/** How far the visible part of a scroller is from the end of its content, in px. */
export function distanceFromBottom(scrollTop: number, clientHeight: number, scrollHeight: number): number {
  return scrollHeight - scrollTop - clientHeight;
}

/** Closer to the end than `threshold` px. */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold: number): boolean {
  return distanceFromBottom(scrollTop, clientHeight, scrollHeight) < threshold;
}

/** The scroll-to-bottom button appears once the reader is further than this from the end. */
export const SCROLL_BUTTON_DISTANCE = 160;

export function shouldShowScrollButton(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return distanceFromBottom(scrollTop, clientHeight, scrollHeight) > SCROLL_BUTTON_DISTANCE;
}
