/**
 * The terminal on the left of the hero: herdr's TUI drawn as a character-cell grid (all content invented). Every row
 * is exactly COLS cells; each cell has a character, a foreground and a background class. ASCII runs are plain text in
 * a monospaced font; any other character sits in a box exactly one cell wide, so box drawing, status dots and a
 * glyph from a fallback font can never push the columns out of line.
 */

export interface TermGrid {
  cols: number;
  rows: number;
  html: string;
}

interface Cell {
  ch: string;
  fg: string;
  bg: string;
}

const SIDE = 24; // sidebar width in cells; its vertical line is column SIDE
const MAIN = SIDE + 2; // where the Claude Code pane's text starts

export function herdrGrid(cols: number, rows: number): TermGrid {
  const g: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: " ", fg: "", bg: "" })));
  const put = (r: number, c: number, text: string, fg = "", bg?: string) => {
    if (r < 0 || r >= rows) return;
    [...text].forEach((ch, i) => {
      const cell = g[r]?.[c + i];
      if (!cell) return;
      cell.ch = ch;
      cell.fg = fg;
      if (bg !== undefined) cell.bg = bg;
    });
  };
  const fill = (r: number, c0: number, c1: number, bg: string) => {
    for (let c = c0; c < Math.min(c1, cols); c++) if (g[r]?.[c]) g[r]![c]!.bg = bg;
  };
  const right = (r: number, cEnd: number, text: string, fg = "") => put(r, cEnd - [...text].length, text, fg);

  // ── Top row: workspace numbers, the active one in the accent; the machine name at the right ──
  fill(0, 0, cols, "bar");
  put(0, 0, " 1 ", "on", "on");
  put(0, 3, " 2  3  4  5  + ", "dim");
  right(0, cols - 1, "studio", "dim");

  // ── Sidebar ──
  for (let r = 1; r < rows; r++) put(r, SIDE, "│", "line");
  put(1, 1, "machines", "head");
  put(2, 1, "▾ ", "dim");
  put(2, 3, "Local", "b");
  fill(3, 0, SIDE, "sel");
  fill(4, 0, SIDE, "sel");
  put(3, 3, "○ ", "idle");
  put(3, 5, "api", "b");
  put(4, 5, "feat/cursor-pag…", "dim");
  put(5, 3, "● ", "acc");
  put(5, 5, "web", "");
  put(6, 5, "feat/load-more", "dim");
  put(7, 3, "▲ ", "warn");
  put(7, 5, "docs", "");
  put(8, 5, "main", "dim");
  put(10, 1, "new · Local", "dim");
  right(10, SIDE - 1, "menu", "dim");
  put(11, 0, "─".repeat(SIDE), "line");
  put(11, SIDE, "┤", "line");
  put(12, 1, "agents", "head");
  right(12, SIDE - 1, "priority", "dim");
  const agent = (r: number, state: string, cls: string, where: string) => {
    put(r, 1, "claude", "b");
    right(r, SIDE - 1, state, cls);
    put(r + 1, 1, where, "dim");
  };
  agent(14, "needs you", "warn", "docs · 1");
  agent(17, "working", "acc", "web · 1");
  agent(20, "idle", "idle", "api · 1");
  put(28, 1, "alt+s", "key");
  put(28, 10, "Sidecr", "dim");
  put(29, 1, "prefix j", "key");
  put(29, 10, "next agent", "dim");

  // ── The Claude Code pane ──
  const p = (r: number, segs: [string, string?][], bg?: string, from = MAIN) => {
    if (bg) fill(r, SIDE + 1, cols, bg);
    let c = from;
    for (const [t, fg] of segs) {
      put(r, c, t, fg ?? "", bg);
      c += [...t].length;
    }
  };
  p(2, [["● ", "fg"], ["That is the index doing its job: 24x the throughput and no more timeouts.", ""]]);
  p(4, [["> ", "dim"], ["And this is p95 on staging after the deploy. ", ""], ["[Image #1]", "acc"]], "prompt");
  p(6, [["● ", "fg"], ["From 1.8 s down to 120 ms, and flat: page 1 and page 400 now cost the same.", ""]]);
  p(7, [["  Dashboard: ", ""], ["https://metrics.example.com/d/orders-api", "link"]]);
  p(9, [["> ", "dim"], ["Great. Write the docs and a changelog entry, then I will open the PR.", ""]], "prompt");
  p(11, [["● ", "ok"], ["Write", "b"], ["(docs\\pagination.md)", ""]]);
  p(12, [["  ⎿  ", "dim"], ["Wrote ", "dim"], ["64", "b"], [" lines to docs\\pagination.md", "dim"]]);
  p(13, [["● ", "ok"], ["Update", "b"], ["(CHANGELOG.md)", ""]]);
  p(14, [["  ⎿  ", "dim"], ["Updated CHANGELOG.md with ", "dim"], ["5", "b"], [" additions", "dim"]]);
  const diff = (r: number, n: number, sign: "+" | "-", text: string) =>
    p(r, [[`      ${String(n).padStart(2)} `, sign === "+" ? "addn" : "deln"], [`${sign} ${text}`, sign === "+" ? "addt" : "delt"]], sign === "+" ? "add" : "del");
  diff(15, 12, "+", "## 2.4.0");
  diff(16, 13, "+", "");
  diff(17, 14, "+", "- GET /v1/orders takes `limit` and `cursor`, returns `next_cursor`.");
  diff(18, 15, "+", "- `limit` defaults to 50, at most 100.");
  diff(19, 16, "+", "- New index orders_account_created_id (migration 0042).");
  p(20, [["● ", "ok"], ["Update", "b"], ["(README.md)", ""]]);
  p(21, [["  ⎿  ", "dim"], ["Updated README.md with ", "dim"], ["1", "b"], [" addition and ", "dim"], ["1", "b"], [" removal", "dim"]]);
  diff(22, 48, "-", "See the API reference for the list endpoints.");
  diff(23, 48, "+", "See docs/pagination.md for walking long lists.");
  p(25, [["● ", "fg"], ["Docs are written and the changelog has a 2.4.0 entry. A client walks the list", ""]]);
  p(26, [["  with ", ""], ["next_cursor", "code"], [" until it is ", ""], ["null", "code"], ["; ", ""], ["limit", "code"], [" defaults to 50, at most 100.", ""]]);
  // the prompt box, the status line and the hint
  const w = cols - MAIN - 1;
  put(28, MAIN, `╭${"─".repeat(w - 2)}╮`, "box");
  put(29, MAIN, "│", "box");
  put(29, MAIN + w - 1, "│", "box");
  put(29, MAIN + 2, "> ", "dim");
  put(29, MAIN + 4, "▌", "caret");
  put(30, MAIN, `╰${"─".repeat(w - 2)}╯`, "box");
  p(31, [["  Sonnet 5.5", "acc"], [" | ", "line"], ["api", ""], [" | ", "line"], ["feat/cursor-pagination", "ok"], [" | ", "line"], ["ctx 41%", "dim"], [" | ", "line"], ["5h 12%", "dim"]]);
  p(32, [["  ⏵⏵ auto mode on", "acc"], [" (shift+tab to cycle)", "dim"]]);

  // ── To HTML: runs of the same classes; non-ASCII characters in one-cell boxes ──
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = g.map((row) => {
    let out = "";
    let i = 0;
    while (i < row.length) {
      const { fg, bg } = row[i]!;
      let j = i;
      let text = "";
      while (j < row.length && row[j]!.fg === fg && row[j]!.bg === bg) {
        const ch = row[j]!.ch;
        text += /^[\x20-\x7e]$/.test(ch) ? escape(ch) : `<i>${escape(ch)}</i>`;
        j++;
      }
      const cls = [fg && `f-${fg}`, bg && `b-${bg}`].filter(Boolean).join(" ");
      out += cls ? `<span class="${cls}">${text}</span>` : text;
      i = j;
    }
    return `<div class="tr">${out}</div>`;
  });
  return { cols, rows, html: lines.join("") };
}

export const TERMINAL_CSS = `
  .tty { position: absolute; background: #0f1013; border: 1px solid #ffffff1c;
    box-shadow: 0 30px 90px #0000008c, 0 6px 22px #00000066; font-family: var(--mono); font-variant-ligatures: none;
    font-feature-settings: "liga" 0, "calt" 0; color: #d4d4da; overflow: hidden; }
  .tty .grid { position: absolute; white-space: pre; }
  .tty .tr { height: var(--lh); line-height: var(--lh); }
  .tty i { font-style: normal; display: inline-block; width: 1ch; text-align: center; overflow: visible; vertical-align: top; }
  .f-b { color: #f0f0f4; font-weight: 600; } .f-fg { color: #f0f0f4; } .f-dim { color: #82828e; } .f-head { color: #a9a9b6; font-weight: 600; }
  .f-acc { color: #9a92ff; } .f-ok { color: #7fd19a; } .f-warn { color: #e8a25c; } .f-idle { color: #9a9aa6; } .f-line { color: #3a3b44; }
  .f-key { color: #c9c6ff; } .f-code { color: #c9c6ff; } .f-link { color: #9a92ff; text-decoration: underline; text-underline-offset: 3px; }
  .f-box { color: #5a5b66; } .f-caret { color: #d4d4da; } .f-on { color: #ffffff; font-weight: 700; }
  .f-addn { color: #6fbf88; } .f-addt { color: #c6ead1; } .f-deln { color: #e58b8b; } .f-delt { color: #f0c4c4; }
  .b-bar { background: #15161b; } .b-on { background: #5347fd; } .b-sel { background: #5347fd1f; }
  .b-prompt { background: #ffffff0a; } .b-add { background: #2ea04326; } .b-del { background: #f8514926; }
`;

/** The terminal box at (x, y), w x h px (it may run past the canvas), font size fs, cell grid from its top-left + pad. */
export function terminalHtml(x: number, y: number, w: number, h: number, fs: number, padX: number, padY: number): string {
  const cw = fs * 0.6; // JetBrains Mono's advance is 600/1000 em
  const lh = Math.round(fs * 1.38);
  const cols = Math.floor((w - padX) / cw);
  const rows = Math.ceil((h - padY) / lh);
  const grid = herdrGrid(cols, rows);
  return `<div class="tty" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${fs}px;--lh:${lh}px">
    <div class="grid" style="left:${padX}px;top:${padY}px">${grid.html}</div></div>`;
}
