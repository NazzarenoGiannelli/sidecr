import { realTimers, type TimerApi } from "./timers";

/** How often an open window tells the server it is still there. The server forgets a window after 9000 ms. */
export const PING_MS = 3000;
/** sendBeacon goes out with the content type of its Blob; the server only takes JSON. */
export const byeBlobType = "application/json";

export type WindowEvent = "hello" | "ping" | "bye";

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (a: Uint8Array) => Uint8Array;
}

const SERVER_ID = /^[A-Za-z0-9-]{1,64}$/;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A fresh window id the server accepts: a UUID when the browser has one, else 32 random hex characters. */
export function newWindowId(c: CryptoLike | undefined): string {
  try {
    const id = c?.randomUUID?.();
    if (typeof id === "string" && SERVER_ID.test(id)) return id;
  } catch {
    /* fall through to the hex id */
  }
  const bytes = new Uint8Array(16);
  try {
    if (c?.getRandomValues) {
      c.getRandomValues(bytes);
      return hex(bytes);
    }
  } catch {
    /* fall through to Math.random */
  }
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return hex(bytes);
}

/** The JSON body of a /api/window call. */
export const windowEventBody = (id: string, event: WindowEvent): string => JSON.stringify({ id, event });

export interface WindowSessionDeps {
  id: string;
  /**
   * Sends one event to the server. A failure is ignored: the next ping tells the server again.
   * The answer may say `close: true`: the open key was pressed and this window's event stream could not carry it.
   */
  send(event: "hello" | "ping"): Promise<{ close?: boolean } | void> | void;
  /** Called when an answer asks this window to close. */
  onClose?(): void;
  timers?: TimerApi;
}

/** Announces this window to the server (hello) and keeps telling it that the window is still open (ping). */
export function createWindowSession(deps: WindowSessionDeps) {
  const timers = deps.timers ?? realTimers;
  let handle: unknown = null;
  let running = false;
  const safeSend = (event: "hello" | "ping") => {
    try {
      const result = deps.send(event);
      if (result) {
        result.then(
          (answer) => {
            if (running && answer && answer.close === true) deps.onClose?.();
          },
          () => {
            /* the server is unreachable for now */
          },
        );
      }
    } catch {
      /* the server is unreachable for now */
    }
  };
  const schedule = () => {
    handle = timers.set(() => {
      if (!running) return;
      safeSend("ping");
      schedule();
    }, PING_MS);
  };
  return {
    id: deps.id,
    start(): void {
      if (running) return;
      running = true;
      safeSend("hello");
      schedule();
    },
    stop(): void {
      running = false;
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
  };
}
