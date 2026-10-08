import { expect, test } from "bun:test";
import { shouldCloseOnBackdropClick } from "../ui/backdrop";

test("closes only when the press and the release are both on the backdrop", () => {
  expect(shouldCloseOnBackdropClick(true, true)).toBe(true);
  expect(shouldCloseOnBackdropClick(true, false)).toBe(false); // click inside the panel
  expect(shouldCloseOnBackdropClick(false, true)).toBe(false); // pressed in the panel, released on the backdrop
  expect(shouldCloseOnBackdropClick(false, false)).toBe(false);
});
