/** The pane herdr was focused on when the plugin was invoked: HERDR_PANE_ID, else the plugin context JSON. */
export function resolvePaneId(env: Record<string, string | undefined>): string | null {
  const direct = env.HERDR_PANE_ID;
  if (direct) return direct;
  const raw = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      const id = JSON.parse(raw)?.focused_pane_id;
      if (typeof id === "string" && id) return id;
    } catch {
      /* invalid context: treat as absent */
    }
  }
  return null;
}
