/** Hands out request tokens; only the most recently issued one is "latest". */
export function createLatest() {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isLatest(token: number): boolean {
      return token === current;
    },
  };
}
