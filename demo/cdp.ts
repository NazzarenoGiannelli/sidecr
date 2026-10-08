/** A minimal Chrome DevTools Protocol client: one page target, commands, and events by name. */

export interface Cdp {
  send<T = any>(method: string, params?: object): Promise<T>;
  on(method: string, fn: (params: any) => void): void;
  eval<T = unknown>(expression: string): Promise<T>;
  close(): void;
}

/** Waits for a page target on the debug port whose URL passes `match`, then opens its socket. */
export async function connectPage(port: number, match: (url: string) => boolean, timeoutMs = 20_000): Promise<Cdp> {
  const until = Date.now() + timeoutMs;
  let target: { webSocketDebuggerUrl: string } | undefined;
  while (!target) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === "page" && match(t.url));
    } catch {
      /* not listening yet */
    }
    if (!target) {
      if (Date.now() > until) throw new Error(`no matching page on debug port ${port}`);
      await Bun.sleep(250);
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let next = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; method: string }>();
  const handlers = new Map<string, ((p: any) => void)[]>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
      else p.res(m.result);
    } else if (m.method) {
      for (const fn of handlers.get(m.method) ?? []) fn(m.params);
    }
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("debug socket failed"));
  });
  const cdp: Cdp = {
    send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++next;
        pending.set(id, { res, rej, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      handlers.set(method, [...(handlers.get(method) ?? []), fn]);
    },
    async eval(expression) {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result?.value;
    },
    close() {
      ws.close();
    },
  };
  return cdp;
}

/** Waits until `expression` is truthy in the page. */
export async function until(cdp: Cdp, expression: string, what: string, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await cdp.eval<boolean>(`!!(${expression})`)) return;
    } catch {
      /* the page is reloading */
    }
    await Bun.sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Two animation frames and a pause: layout, paint and the panels' transitions have settled. */
export async function settle(cdp: Cdp, ms = 450): Promise<void> {
  await cdp.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  await Bun.sleep(ms);
}
