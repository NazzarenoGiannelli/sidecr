export interface PaneRow {
  paneId: string;
  title: string;
  workspaceId: string;
  /** The workspace label shown to the user; the id stands in when herdr has no label. */
  workspace: string;
  agentStatus: string;
}

export function filterPanes(rows: PaneRow[], query: string): PaneRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const hay = `${r.title} ${r.workspace}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * The pane `delta` steps from the current one in the list (Alt+Up/Alt+Down), wrapping around at the ends. A current
 * pane that is not in the list steps from before the first row (Down gives the first, Up the last). Null for an
 * empty list or when the only row is the current one.
 */
export function paneStep(rows: PaneRow[], current: string, delta: number): PaneRow | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((r) => r.paneId === current);
  const from = at < 0 ? (delta > 0 ? -1 : rows.length) : at;
  const next = rows[(((from + delta) % rows.length) + rows.length) % rows.length]!;
  return next.paneId === current ? null : next;
}

/** The Nth pane of the list (Alt+1..9, 1-based), or null when the list is shorter. */
export function nthPane(rows: PaneRow[], n: number): PaneRow | null {
  return Number.isInteger(n) && n >= 1 ? (rows[n - 1] ?? null) : null;
}
