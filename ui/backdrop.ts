/**
 * A backdrop click closes the switcher only when the press and the release were both on the backdrop itself.
 * Pressing inside the panel (selecting text in the search box) and releasing on the backdrop dispatches the click
 * at their common ancestor, the backdrop, and must not close it.
 */
export function shouldCloseOnBackdropClick(pressTargetIsBackdrop: boolean, clickTargetIsBackdrop: boolean): boolean {
  return pressTargetIsBackdrop && clickTargetIsBackdrop;
}
