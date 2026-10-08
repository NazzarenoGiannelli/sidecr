import { expect, test } from "bun:test";
import { createLatest } from "../ui/latest";

test("the most recently issued token is the latest", () => {
  const l = createLatest();
  const a = l.next();
  expect(l.isLatest(a)).toBe(true);
});

test("issuing a new token makes earlier ones stale", () => {
  const l = createLatest();
  const a = l.next();
  const b = l.next();
  expect(l.isLatest(a)).toBe(false);
  expect(l.isLatest(b)).toBe(true);
});

test("out-of-order completion: only the newest request may render", () => {
  const l = createLatest();
  const first = l.next();
  const second = l.next();
  const rendered: string[] = [];
  // the second response lands first, then the older one
  if (l.isLatest(second)) rendered.push("second");
  if (l.isLatest(first)) rendered.push("first");
  expect(rendered).toEqual(["second"]);
});

test("separate helpers do not share tokens", () => {
  const x = createLatest();
  const y = createLatest();
  const t = x.next();
  y.next();
  y.next();
  expect(x.isLatest(t)).toBe(true);
});

test("a token that was never issued is not the latest", () => {
  const l = createLatest();
  l.next();
  expect(l.isLatest(999)).toBe(false);
});
