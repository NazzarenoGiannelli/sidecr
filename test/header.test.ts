import { expect, test } from "bun:test";
import { headerSubtitle } from "../ui/header";

test("machine and workspace are joined with a middle dot", () => {
  expect(headerSubtitle("desk", "API")).toBe("desk · API");
});
test("an empty part leaves no dot behind", () => {
  expect(headerSubtitle("desk", "")).toBe("desk");
  expect(headerSubtitle("", "API")).toBe("API");
  expect(headerSubtitle("  ", "API")).toBe("API");
});
test("missing parts give an empty string", () => {
  expect(headerSubtitle(undefined, undefined)).toBe("");
  expect(headerSubtitle(null, "")).toBe("");
});
