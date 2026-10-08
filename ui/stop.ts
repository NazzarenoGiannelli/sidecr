import { realTimers, type TimerApi } from "./timers";

export const STOP_COOLDOWN_MS = 1500;

export interface StopperDeps {
  /** POST /api/stop for the pane; resolves for `{ ok: true }` and `{ ok: true, deduped: true }`, rejects on an error. */
  post(pane: string): Promise<unknown>;
  getPane(): string;
  setDisabled(disabled: boolean): void;
  showError(text: string): void;
  timers?: TimerApi;
  cooldownMs?: number;
}

/** The Stop button's behaviour: one request per click, then the button stays disabled for a moment. */
export function createStopper(deps: StopperDeps) {
  const timers = deps.timers ?? realTimers;
  const cooldown = deps.cooldownMs ?? STOP_COOLDOWN_MS;
  let cooling = false;
  return {
    async click(): Promise<void> {
      if (cooling) return;
      cooling = true;
      deps.setDisabled(true);
      timers.set(() => {
        cooling = false;
        deps.setDisabled(false);
      }, cooldown);
      try {
        await deps.post(deps.getPane());
      } catch (e) {
        deps.showError(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
