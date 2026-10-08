/**
 * A wall-clock budget for a performance assertion. The bounds in the tests are set on a developer machine; a shared CI
 * runner can be several times slower, so CI sets SIDECR_TEST_TIME_SCALE (a number from 1 to 10) and every budget is
 * multiplied by it. A linear algorithm stays far inside a scaled budget, and a quadratic one on the same input still
 * takes seconds, so the tests keep catching what they are for. Without the variable the bounds are the written ones.
 */
export function timeScale(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SIDECR_TEST_TIME_SCALE);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 1;
}

export function budget(ms: number): number {
  return ms * timeScale();
}
