import { expect, test } from "bun:test";
import { timeScale } from "./timing";

test("the time scale: 1 by default, the number CI gives, never below 1 or above 10", () => {
  expect(timeScale({})).toBe(1);
  expect(timeScale({ SIDECR_TEST_TIME_SCALE: "3" })).toBe(3);
  expect(timeScale({ SIDECR_TEST_TIME_SCALE: "2.5" })).toBe(2.5);
  expect(timeScale({ SIDECR_TEST_TIME_SCALE: "0.1" })).toBe(1);
  expect(timeScale({ SIDECR_TEST_TIME_SCALE: "50" })).toBe(10);
  expect(timeScale({ SIDECR_TEST_TIME_SCALE: "fast" })).toBe(1);
  expect(timeScale({ SIDECR_TEST_TIME_SCALE: "" })).toBe(1);
});
