import { describe, expect, test } from "bun:test";
import { cleanUserText, parseTranscript, turnOf, type Exchange } from "../src/transcript/parse";
import { budget } from "./timing";

let n = 0;
const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({ type: "user", uuid: `u${n++}`, message: { role: "user", content }, ...extra });
const assistant = (content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const toolResult = () => user([{ type: "tool_result", tool_use_id: "x", content: "ok" }]);

describe("parseTranscript", () => {
  test("returns the last n exchanges", () => {
    const lines = [
      user("one"), assistant([{ type: "text", text: "A1" }]),
      user("two"), assistant([{ type: "text", text: "A2" }]),
      user("three"), assistant([{ type: "text", text: "A3" }]),
    ];
    const out = parseTranscript(lines, 2);
    expect(out.map((e) => e.user)).toEqual([[{ kind: "text", text: "two" }], [{ kind: "text", text: "three" }]]);
    expect(out[1].assistant).toEqual([{ kind: "text", text: "A3" }]);
  });

  test("collapses tool calls across tool results into one block", () => {
    const lines = [
      user("go"),
      assistant([{ type: "tool_use", id: "1", name: "Bash", input: {} }]), toolResult(),
      assistant([{ type: "tool_use", id: "2", name: "Read", input: {} }]), toolResult(),
      assistant([{ type: "tool_use", id: "3", name: "Edit", input: {} }]), toolResult(),
      assistant([{ type: "text", text: "done" }]),
    ];
    const [ex] = parseTranscript(lines, 2);
    expect(ex.assistant).toEqual([
      { kind: "tools", count: 3, items: [{ name: "Bash", summary: "" }, { name: "Read", summary: "" }, { name: "Edit", summary: "" }] },
      { kind: "text", text: "done" },
    ]);
  });

  test("hides thinking and keeps an exchange that has no answer yet", () => {
    const lines = [user("hello"), assistant([{ type: "thinking", thinking: "secret" }])];
    const [ex] = parseTranscript(lines, 2);
    expect(ex.assistant).toEqual([]);
    expect(ex.user).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("skips meta, sidechain, unknown types and malformed lines without crashing", () => {
    const lines = [
      "{not json",
      JSON.stringify({ type: "permission-mode", mode: "x" }),
      JSON.stringify({ type: "attachment" }),
      user("meta", { isMeta: true }),
      user("side", { isSidechain: true }),
      user("real"),
      assistant([{ type: "text", text: "ok" }]),
    ];
    const out = parseTranscript(lines, 5);
    expect(out).toHaveLength(1);
    expect(out[0].user).toEqual([{ kind: "text", text: "real" }]);
  });

  test("compact-summary rows are not prompts", () => {
    const lines = [
      user("before"), assistant([{ type: "text", text: "A0" }]),
      user("This session is being continued from a previous conversation that ran out of context.", { isCompactSummary: true }),
      user("after"), assistant([{ type: "text", text: "A1" }]),
    ];
    const out = parseTranscript(lines, 5);
    expect(out.map((e) => e.user)).toEqual([[{ kind: "text", text: "before" }], [{ kind: "text", text: "after" }]]);
  });

  test("assistant lines before any user prompt (tail started mid-exchange) are ignored", () => {
    const out = parseTranscript([assistant([{ type: "text", text: "orphan" }]), user("q")], 2);
    expect(out).toHaveLength(1);
    expect(out[0].assistant).toEqual([]);
  });

  test("base64 image block becomes an image block", () => {
    const lines = [
      user([
        { type: "text", text: "see this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ]),
    ];
    const [ex] = parseTranscript(lines, 1);
    expect(ex.user).toEqual([
      { kind: "text", text: "see this" },
      { kind: "image", dataUrl: "data:image/png;base64,AAAA" },
    ]);
  });

  const unsupported = [{ kind: "text" as const, text: "[image not shown: unsupported data]" }];
  const imageRow = (media_type: string, data: string) =>
    user([{ type: "image", source: { type: "base64", media_type, data } }]);

  test("hostile media_type never becomes an image block", () => {
    const [ex] = parseTranscript([imageRow('image/png" onerror="x', "AAAA")], 1);
    expect(ex.user).toEqual(unsupported);
  });

  test("data containing a quote or a space never becomes an image block", () => {
    const [quoted] = parseTranscript([imageRow("image/png", 'AA"AA')], 1);
    expect(quoted.user).toEqual(unsupported);
    const [spaced] = parseTranscript([imageRow("image/png", "AA AA")], 1);
    expect(spaced.user).toEqual(unsupported);
  });
});

const toolItems = (name: string, input: unknown) => {
  const [ex] = parseTranscript([user("go"), assistant([{ type: "tool_use", id: "t", name, input }])], 1);
  const block = ex.assistant[0];
  if (block?.kind !== "tools") throw new Error("expected a tools block");
  return block.items;
};
const summaryOf = (name: string, input: unknown) => toolItems(name, input)[0].summary;

describe("tool summaries", () => {
  test("Bash gives the command", () => expect(summaryOf("Bash", { command: "ls -la" })).toBe("ls -la"));
  test("Read, Write, Edit and MultiEdit give file_path", () => {
    for (const name of ["Read", "Write", "Edit", "MultiEdit"]) {
      expect(summaryOf(name, { file_path: "/a/b.ts", content: "x" }), name).toBe("/a/b.ts");
    }
  });
  test("NotebookEdit gives notebook_path, or file_path when that is what it has", () => {
    expect(summaryOf("NotebookEdit", { notebook_path: "/n.ipynb", new_source: "x" })).toBe("/n.ipynb");
    expect(summaryOf("NotebookEdit", { file_path: "/m.ipynb" })).toBe("/m.ipynb");
  });
  test("Grep gives the pattern, plus ' in ' and the path when there is one", () => {
    expect(summaryOf("Grep", { pattern: "foo" })).toBe("foo");
    expect(summaryOf("Grep", { pattern: "foo", path: "src" })).toBe("foo in src");
  });
  test("Glob gives the pattern", () => expect(summaryOf("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts"));
  test("WebFetch gives the url, WebSearch the query", () => {
    expect(summaryOf("WebFetch", { url: "https://a.dev", prompt: "p" })).toBe("https://a.dev");
    expect(summaryOf("WebSearch", { query: "bun test" })).toBe("bun test");
  });
  test("Agent and Task give the description", () => {
    expect(summaryOf("Agent", { description: "Find it", prompt: "long" })).toBe("Find it");
    expect(summaryOf("Task", { description: "Do it", prompt: "long" })).toBe("Do it");
  });
  test("TodoWrite gives 'todo list'", () => expect(summaryOf("TodoWrite", { todos: [{ content: "x" }] })).toBe("todo list"));
  test("any other tool gives its first string-valued input field", () => {
    expect(summaryOf("Custom", { n: 3, flag: true, label: "hello", other: "later" })).toBe("hello");
  });
  test("an unknown tool with no string input, or no input at all, gives an empty summary", () => {
    expect(summaryOf("Custom", { n: 3 })).toBe("");
    expect(summaryOf("Custom", undefined)).toBe("");
    expect(summaryOf("Custom", null)).toBe("");
    expect(summaryOf("Custom", "text")).toBe("");
  });
  test("a known tool whose field is missing or not a string gives an empty summary", () => {
    expect(summaryOf("Bash", {})).toBe("");
    expect(summaryOf("Bash", { command: 5 })).toBe("");
    expect(summaryOf("Grep", { path: "src" })).toBe("");
  });
  test("a missing tool name becomes an empty name, not a crash", () => {
    expect(toolItems(undefined as unknown as string, { command: "x" })).toEqual([{ name: "", summary: "x" }]);
  });
  test("newlines are flattened to single spaces and the ends are trimmed", () => {
    expect(summaryOf("Bash", { command: "  echo a\n\necho b\r\nexit  " })).toBe("echo a echo b exit");
  });
  test("long summaries are cut to 160 characters including the ellipsis", () => {
    const s = summaryOf("Bash", { command: "x".repeat(500) });
    expect(s).toHaveLength(160);
    expect(s.endsWith("…")).toBe(true);
    expect(summaryOf("Bash", { command: "y".repeat(160) })).toBe("y".repeat(160));
  });
});

describe("tools blocks", () => {
  const useRow = (i: number) => assistant([{ type: "tool_use", id: String(i), name: "Bash", input: { command: `cmd ${i}` } }]);
  test("keep at most 40 items while count stays the true number", () => {
    const lines = [user("go"), ...Array.from({ length: 55 }, (_, i) => useRow(i)), assistant([{ type: "text", text: "done" }])];
    const [ex] = parseTranscript(lines, 1);
    const block = ex.assistant[0];
    if (block.kind !== "tools") throw new Error("expected tools");
    expect(block.count).toBe(55);
    expect(block.items).toHaveLength(40);
    expect(block.items[0].summary).toBe("cmd 0");
    expect(block.items[39].summary).toBe("cmd 39");
  });
  test("several tool_use blocks in one assistant row are all counted and listed", () => {
    const row = assistant([
      { type: "tool_use", id: "1", name: "Read", input: { file_path: "/a" } },
      { type: "tool_use", id: "2", name: "Glob", input: { pattern: "*.md" } },
    ]);
    const [ex] = parseTranscript([user("go"), row], 1);
    expect(ex.assistant).toEqual([
      { kind: "tools", count: 2, items: [{ name: "Read", summary: "/a" }, { name: "Glob", summary: "*.md" }] },
    ]);
  });
  test("a text block between tool calls starts a new tools block", () => {
    const lines = [user("go"), useRow(1), assistant([{ type: "text", text: "mid" }]), useRow(2)];
    const [ex] = parseTranscript(lines, 1);
    expect(ex.assistant.map((b) => b.kind)).toEqual(["tools", "text", "tools"]);
  });
});

describe("startedAt and tokens", () => {
  const stamped = (content: unknown, timestamp?: unknown) =>
    JSON.stringify({ type: "user", uuid: `s${n++}`, timestamp, message: { role: "user", content } });
  const withUsage = (id: string | undefined, usage: unknown, content: unknown[] = [{ type: "text", text: "x" }]) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", id, content, usage } });

  test("startedAt is the timestamp of the user row that began the exchange", () => {
    const lines = [stamped("one", "2026-10-01T09:00:00.000Z"), assistant([{ type: "text", text: "a" }]), stamped("two", "2026-10-01T09:05:00.000Z")];
    const out = parseTranscript(lines, 2);
    expect(out.map((e) => e.startedAt)).toEqual(["2026-10-01T09:00:00.000Z", "2026-10-01T09:05:00.000Z"]);
  });

  test("a missing or non-string timestamp leaves startedAt out", () => {
    const out = parseTranscript([stamped("one"), stamped("two", 12345)], 2);
    expect(out.map((e) => "startedAt" in e)).toEqual([false, false]);
  });

  test("a single assistant row", () => {
    const [ex] = parseTranscript([user("go"), withUsage("m1", { input_tokens: 10, output_tokens: 5 })], 1);
    expect(ex.tokens).toEqual({ input: 10, output: 5 });
  });

  test("rows with the same message id count once, with the last usage seen", () => {
    const lines = [
      user("go"),
      withUsage("m1", { input_tokens: 10, output_tokens: 1 }),
      withUsage("m1", { input_tokens: 10, output_tokens: 7 }, [{ type: "tool_use", id: "t", name: "Bash", input: {} }]),
    ];
    const [ex] = parseTranscript(lines, 1);
    expect(ex.tokens).toEqual({ input: 10, output: 7 });
  });

  test("several message ids are summed", () => {
    const lines = [
      user("go"),
      withUsage("m1", { input_tokens: 10, output_tokens: 5 }),
      toolResult(),
      withUsage("m2", { input_tokens: 20, output_tokens: 6 }),
      withUsage("m2", { input_tokens: 20, output_tokens: 8 }),
      withUsage("m3", { input_tokens: 1, output_tokens: 2 }),
    ];
    const [ex] = parseTranscript(lines, 1);
    expect(ex.tokens).toEqual({ input: 31, output: 15 });
  });

  test("usage is counted per exchange", () => {
    const lines = [user("a"), withUsage("m1", { input_tokens: 4, output_tokens: 4 }), user("b"), withUsage("m2", { input_tokens: 9, output_tokens: 1 })];
    const out = parseTranscript(lines, 2);
    expect(out.map((e) => e.tokens)).toEqual([{ input: 4, output: 4 }, { input: 9, output: 1 }]);
  });

  test("missing or malformed usage counts as 0", () => {
    const lines = [
      user("go"),
      withUsage("m1", undefined),
      withUsage("m2", { input_tokens: "lots", output_tokens: null }),
      withUsage("m3", { output_tokens: 3 }),
      withUsage("m4", { input_tokens: -5, output_tokens: Number.NaN }),
    ];
    const [ex] = parseTranscript(lines, 1);
    expect(ex.tokens).toEqual({ input: 0, output: 3 });
  });

  test("rows without a message id each count", () => {
    const lines = [user("go"), withUsage(undefined, { input_tokens: 1, output_tokens: 1 }), withUsage(undefined, { input_tokens: 2, output_tokens: 2 })];
    const [ex] = parseTranscript(lines, 1);
    expect(ex.tokens).toEqual({ input: 3, output: 3 });
  });

  test("an exchange with no assistant row has no tokens", () => {
    const [ex] = parseTranscript([user("go")], 1);
    expect("tokens" in ex).toBe(false);
  });

  test("sidechain rows are not counted", () => {
    const side = JSON.stringify({ type: "assistant", isSidechain: true, message: { id: "sx", content: [], usage: { input_tokens: 99, output_tokens: 99 } } });
    const [ex] = parseTranscript([user("go"), side, withUsage("m1", { input_tokens: 1, output_tokens: 1 })], 1);
    expect(ex.tokens).toEqual({ input: 1, output: 1 });
  });
});

describe("tool name cap", () => {
  test("a tool name over 60 characters is cut to 60 including the ellipsis; count is unaffected", () => {
    const long = "mcp__" + "x".repeat(100);
    const [ex] = parseTranscript([user("go"), assistant([{ type: "tool_use", id: "1", name: long, input: { q: "hi" } }])], 1);
    const block = ex.assistant[0];
    if (block.kind !== "tools") throw new Error("expected tools");
    expect(block.count).toBe(1);
    expect(block.items[0].name).toHaveLength(60);
    expect(block.items[0].name.endsWith("…")).toBe(true);
    expect(block.items[0].name.startsWith("mcp__xxx")).toBe(true);
    expect(block.items[0].summary).toBe("hi");
  });
  test("a name of exactly 60 characters is kept", () => {
    const name = "n".repeat(60);
    const [ex] = parseTranscript([user("go"), assistant([{ type: "tool_use", id: "1", name, input: {} }])], 1);
    const block = ex.assistant[0];
    if (block.kind !== "tools") throw new Error("expected tools");
    expect(block.items[0].name).toBe(name);
  });
});

describe("queued messages", () => {
  let k = 0;
  const T = (s: number) => `2026-10-01T09:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z`;
  const queuedAttachment = (prompt: unknown, ts = T(30), extra: object = {}) =>
    JSON.stringify({
      type: "attachment", timestamp: ts, uuid: `q${k++}`,
      attachment: { type: "queued_command", commandMode: "prompt", source_uuid: `src${k}`, prompt },
      ...extra,
    });
  const stamped = (content: unknown, ts: string, extra: object = {}) =>
    JSON.stringify({ type: "user", uuid: `s${k++}`, timestamp: ts, message: { role: "user", content }, ...extra });
  const say = (text: string, id?: string, usage?: object) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", id, content: [{ type: "text", text }], usage } });
  const op = (operation: string) => JSON.stringify({ type: "queue-operation", operation, timestamp: T(31), sessionId: "s" });
  const texts = (blocks: { kind: string; text?: string }[]) => blocks.map((b) => b.text);

  test("a queued_command attachment starts an exchange; the assistant rows after it belong to it", () => {
    const lines = [
      stamped("first", T(0)), say("working"),
      queuedAttachment("  also this  ", T(30)),
      say("ok, both"),
    ];
    const out = parseTranscript(lines, 10);
    expect(out).toHaveLength(2);
    expect(out[0].assistant).toEqual([{ kind: "text", text: "working" }]);
    expect(out[1].user).toEqual([{ kind: "text", text: "also this" }]);
    expect(out[1].queued).toBe(true);
    expect(out[1].assistant).toEqual([{ kind: "text", text: "ok, both" }]);
    expect(out[1].id).toMatch(/^q/);
    expect("queued" in out[0]).toBe(false);
  });

  test("startedAt is inherited from the previous exchange, else the row's own timestamp", () => {
    const withPrev = parseTranscript([stamped("first", T(0)), queuedAttachment("more", T(30))], 10);
    expect(withPrev[1].startedAt).toBe(T(0));
    const alone = parseTranscript([queuedAttachment("more", T(30))], 10);
    expect(alone[0].startedAt).toBe(T(30));
    const noStamp = parseTranscript([stamped("first", undefined as unknown as string), queuedAttachment("more", T(30))], 10);
    expect(noStamp[1].startedAt).toBe(T(30));
  });

  test("ignored: empty, whitespace, non-string prompts, other attachment types, sidechain rows, queue-operation rows", () => {
    const other = JSON.stringify({ type: "attachment", timestamp: T(1), uuid: "x", attachment: { type: "todo_reminder", prompt: "no" } });
    const lines = [
      stamped("first", T(0)),
      queuedAttachment(""), queuedAttachment("   "), queuedAttachment(42), queuedAttachment(undefined),
      other,
      queuedAttachment("from a subagent", T(5), { isSidechain: true }),
      op("enqueue"), op("dequeue"), op("remove"),
      say("done"),
    ];
    const out = parseTranscript(lines, 10);
    expect(out).toHaveLength(1);
    expect(out[0].assistant).toEqual([{ kind: "text", text: "done" }]);
  });

  test("the prompt goes through cleanUserText", () => {
    const out = parseTranscript([queuedAttachment("<command-name>/model</command-name><command-args>opus</command-args>")], 10);
    expect(texts(out[0].user)).toEqual(["/model opus"]);
    expect(parseTranscript([queuedAttachment("<local-command-stdout>x</local-command-stdout>")], 10)).toEqual([]);
  });

  test("attachment first, then the later user row with promptSource queued: shown once", () => {
    const lines = [
      stamped("first", T(0)), say("working"),
      queuedAttachment("add tests", T(30)),
      op("dequeue"),
      say("on it"),
      stamped("add tests", T(40), { promptSource: "queued" }),
      say("done"),
    ];
    const out = parseTranscript(lines, 10);
    expect(out.map((e) => texts(e.user))).toEqual([["first"], ["add tests"]]);
    expect(out[1].assistant.map((b) => (b as any).text)).toEqual(["on it", "done"]);
  });

  test("user row with promptSource queued first, then the attachment: shown once", () => {
    const lines = [
      stamped("first", T(0)), say("working"),
      stamped("add tests", T(40), { promptSource: "queued" }),
      queuedAttachment("add tests", T(41)),
      say("done"),
    ];
    const out = parseTranscript(lines, 10);
    expect(out.map((e) => texts(e.user))).toEqual([["first"], ["add tests"]]);
  });

  test("an ordinary user row is not taken for the earlier duplicate of an attachment", () => {
    const lines = [stamped("go", T(0)), say("a"), stamped("again", T(10)), say("b"), queuedAttachment("again", T(20)), say("c")];
    const out = parseTranscript(lines, 10);
    expect(out.map((e) => texts(e.user))).toEqual([["go"], ["again"], ["again"]]);
  });

  test("the same text typed twice: the second occurrence after the first was matched still shows", () => {
    const lines = [
      stamped("first", T(0)), say("w"),
      queuedAttachment("yes", T(30)),
      say("x"),
      stamped("yes", T(40), { promptSource: "queued" }), // matched with the attachment: hidden
      say("y"),
      stamped("yes", T(50)), // typed again later: shows
      say("z"),
    ];
    const out = parseTranscript(lines, 10);
    expect(out.map((e) => texts(e.user))).toEqual([["first"], ["yes"], ["yes"]]);
    expect(out[2].queued).toBeUndefined();
  });

  test("a user row with the same text after more than 50 rows is not a duplicate", () => {
    const filler = Array.from({ length: 60 }, (_, i) => op(i % 2 ? "enqueue" : "dequeue"));
    const lines = [stamped("first", T(0)), queuedAttachment("late", T(30)), ...filler, stamped("late", T(50), { promptSource: "queued" })];
    const out = parseTranscript(lines, 10);
    expect(out.map((e) => texts(e.user))).toEqual([["first"], ["late"], ["late"]]);
  });

  test("only prompts count: a task-notification attachment creates no exchange", () => {
    const xml = "<task-notification><task-id>bx1</task-id><summary>Monitor event: build finished</summary><status>completed</status></task-notification>";
    const withMode = (prompt: string, commandMode: string) =>
      JSON.stringify({ type: "attachment", timestamp: T(30), uuid: `n${k++}`, attachment: { type: "queued_command", commandMode, prompt } });
    const base = [stamped("go", T(0)), say("working")];
    const before = parseTranscript(base, 2);
    const after = parseTranscript([...base, withMode(xml, "task-notification"), withMode("x", "bash"), say("more")], 2);
    expect(after).toHaveLength(1);
    expect(after[0].user).toEqual(before[0].user);
    expect(after[0].assistant.map((b) => (b as any).text)).toEqual(["working", "more"]);
  });

  test("a prompt-mode attachment, and one with no commandMode, are the user's messages", () => {
    const noMode = JSON.stringify({ type: "attachment", timestamp: T(30), uuid: "nm", attachment: { type: "queued_command", prompt: "no mode" } });
    const out = parseTranscript([stamped("go", T(0)), queuedAttachment("with mode", T(20)), noMode], 10);
    expect(out.map((e) => texts(e.user))).toEqual([["go"], ["with mode"], ["no mode"]]);
  });

  test("a retyped message (promptSource typed or absent) after a queued one shows both", () => {
    for (const extra of [{ promptSource: "typed" }, {}]) {
      const lines = [stamped("go", T(0)), say("a"), queuedAttachment("continue", T(20)), say("b"), stamped("continue", T(40), extra), say("c")];
      const out = parseTranscript(lines, 10);
      expect(out.map((e) => texts(e.user))).toEqual([["go"], ["continue"], ["continue"]]);
    }
  });

  test("a promptSource queued user row with the text of a preceding queued attachment is shown once", () => {
    const lines = [stamped("go", T(0)), queuedAttachment("continue", T(20)), say("b"), stamped("continue", T(40), { promptSource: "queued" }), say("c")];
    expect(parseTranscript(lines, 10).map((e) => texts(e.user))).toEqual([["go"], ["continue"]]);
  });

  test("a user row with an image and the same text is not matched", () => {
    const row = stamped([{ type: "text", text: "pic" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }], T(40));
    const out = parseTranscript([stamped("first", T(0)), queuedAttachment("pic", T(30)), row], 10);
    expect(out).toHaveLength(3);
  });

  test("real-shaped transcript: user, assistant, queued attachment, queue-operation rows, later duplicate user row", () => {
    const lines = [
      stamped("fix the build", T(0)),
      say("looking", "m1", { input_tokens: 100, output_tokens: 10 }),
      op("enqueue"),
      queuedAttachment("and update the README", T(20)),
      op("dequeue"),
      say("I will do both", "m2", { input_tokens: 120, output_tokens: 15 }),
      op("remove"),
      stamped("and update the README", T(25), { promptSource: "queued" }),
      say("all done", "m3", { input_tokens: 130, output_tokens: 20 }),
      stamped("thanks", T(60)),
      say("welcome", "m4", { input_tokens: 5, output_tokens: 2 }),
    ];
    const out = parseTranscript(lines, 10);
    expect(out.map((e) => texts(e.user))).toEqual([["fix the build"], ["and update the README"], ["thanks"]]);
    expect(out.map((e) => e.queued)).toEqual([undefined, true, undefined]);
    expect(out[0].tokens).toEqual({ input: 100, output: 10 });
    expect(out[1].tokens).toEqual({ input: 250, output: 35 });
    expect(out[1].startedAt).toBe(T(0));
    expect(out[2].startedAt).toBe(T(60));
  });

  test("a malformed attachment row does not throw", () => {
    const lines = ["{}", JSON.stringify({ type: "attachment" }), JSON.stringify({ type: "attachment", attachment: null }), JSON.stringify({ type: "attachment", attachment: "x" })];
    expect(parseTranscript(lines, 10)).toEqual([]);
  });
});

describe("the window counts real prompts, not queued ones", () => {
  let k = 0;
  const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
  const prompt = (text: string, ts: string) => JSON.stringify({ type: "user", uuid: `w${k++}`, timestamp: ts, message: { role: "user", content: text } });
  const queued = (text: string) =>
    JSON.stringify({ type: "attachment", uuid: `w${k++}`, timestamp: "2026-10-01T09:30:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: text } });
  const reply = (text: string, id: string, input = 1, output = 1) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", id, content: [{ type: "text", text }], usage: usage(input, output) } });
  const users = (out: Exchange[]) => out.map((e) => (e.user[0] as { text: string }).text);

  test("one prompt plus three queued messages: the prompt, its answer and the three bubbles all stay", () => {
    const lines = [prompt("real", "t0"), reply("first answer", "m1", 10, 5), queued("q1"), reply("a1", "m2"), queued("q2"), queued("q3"), reply("a3", "m3")];
    const out = parseTranscript(lines, 1);
    expect(users(out)).toEqual(["real", "q1", "q2", "q3"]);
    expect(out[0].assistant).toEqual([{ kind: "text", text: "first answer" }]);
    expect(out.map((e) => e.queued === true)).toEqual([false, true, true, true]);
  });

  test("n = 2 with two prompts each followed by one queued message keeps all four", () => {
    const lines = [prompt("p1", "t0"), queued("q1"), prompt("p2", "t1"), queued("q2")];
    expect(users(parseTranscript(lines, 2))).toEqual(["p1", "q1", "p2", "q2"]);
  });

  test("older real prompts and their queued messages fall out together; queued ones before the first kept prompt go", () => {
    const lines = [prompt("p1", "t0"), queued("q1"), prompt("p2", "t1"), queued("q2"), prompt("p3", "t2")];
    expect(users(parseTranscript(lines, 2))).toEqual(["p2", "q2", "p3"]);
    expect(users(parseTranscript(lines, 1))).toEqual(["p3"]);
  });

  test("tokens are summed for every exchange before the window is cut, so turnOf gives the whole turn", () => {
    const lines = [
      prompt("real", "2026-10-01T09:00:00.000Z"), reply("a", "m1", 10, 5),
      queued("q1"), reply("b", "m2", 20, 6),
      queued("q2"), reply("c", "m3", 30, 7),
    ];
    const out = parseTranscript(lines, 1);
    expect(out.map((e) => e.tokens)).toEqual([{ input: 10, output: 5 }, { input: 20, output: 6 }, { input: 30, output: 7 }]);
    expect(turnOf(out)).toEqual({ startedAt: "2026-10-01T09:00:00.000Z", tokens: { input: 60, output: 18 } });
  });

  test("a transcript with many queued rows still returns promptly", () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(prompt(`p${i}`, "t"));
      for (let j = 0; j < 20; j++) lines.push(queued(`q${i}-${j}`), reply("x", `m${i}-${j}`));
    }
    const t = performance.now();
    const out = parseTranscript(lines, 2);
    expect(performance.now() - t).toBeLessThan(budget(1000));
    expect(users(out).filter((u) => u.startsWith("p"))).toEqual(["p298", "p299"]);
    expect(out).toHaveLength(2 + 40);
  });
});

describe("harness text is not the user's message", () => {
  let k = 0;
  const T = (s: number) => `2026-10-01T09:00:${String(s).padStart(2, "0")}.000Z`;
  const userRow = (text: string, extra: object = {}) =>
    JSON.stringify({ type: "user", uuid: `h${k++}`, timestamp: T(k), message: { role: "user", content: text }, ...extra });
  const att = (prompt: string, commandMode: string | undefined = "prompt") =>
    JSON.stringify({ type: "attachment", uuid: `h${k++}`, timestamp: T(k), attachment: { type: "queued_command", commandMode, prompt } });
  const say = (text: string, id: string, input = 1, output = 1) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", id, content: [{ type: "text", text }], usage: { input_tokens: input, output_tokens: output } } });
  const users = (out: Exchange[]) => out.map((e) => (e.user[0] as { text: string }).text);
  const NOTE = "<task-notification><task-id>bx1</task-id><summary>Monitor event: build finished</summary></task-notification>";
  const PEER = '<agent-message from="abc">[Subagent hand-back] The review found three problems ...</agent-message>';

  test("a user row with a task-notification origin creates no exchange", () => {
    const row = userRow(NOTE, { origin: { kind: "task-notification" }, promptSource: "system", isMeta: false });
    expect(users(parseTranscript([userRow("go"), say("a", "m1"), row, say("b", "m2")], 5))).toEqual(["go"]);
  });

  test("a user row with a peer origin and no isMeta creates no exchange", () => {
    const row = userRow(PEER, { origin: { kind: "peer", from: "agent-7" } });
    expect(users(parseTranscript([userRow("go"), row], 5))).toEqual(["go"]);
  });

  test("any other non-human origin kind is skipped too", () => {
    expect(users(parseTranscript([userRow("go"), userRow("x", { origin: { kind: "something-new" } })], 5))).toEqual(["go"]);
  });

  test("origin human, and no origin at all (older transcripts), still start exchanges", () => {
    const out = parseTranscript([userRow("one", { origin: { kind: "human" } }), userRow("two"), userRow("three", { origin: {} }), userRow("four", { origin: null })], 10);
    expect(users(out)).toEqual(["one", "two", "three", "four"]);
  });

  test("promptSource alone does not hide a row: sdk and system rows without a non-human origin stay", () => {
    const out = parseTranscript([userRow("one", { promptSource: "sdk" }), userRow("two", { promptSource: "system" })], 10);
    expect(users(out)).toEqual(["one", "two"]);
  });

  test("a prompt-mode attachment that starts with agent-message, task-notification or system-reminder creates none", () => {
    const lines = [
      userRow("go"),
      att(PEER),
      att(NOTE),
      att("<system-reminder>Something the harness says</system-reminder>"),
      att("  \n\t" + PEER), // leading whitespace before the tag is tolerated
    ];
    expect(users(parseTranscript(lines, 5))).toEqual(["go"]);
  });

  test("an attachment that only mentions agent-message later in the text still shows", () => {
    const out = parseTranscript([userRow("go"), att("please explain the <agent-message> tag"), att("what is a task-notification?")], 5);
    expect(users(out)).toEqual(["go", "please explain the <agent-message> tag", "what is a task-notification?"]);
  });

  test("the match is on the opening tag text and case-sensitive", () => {
    const out = parseTranscript([userRow("go"), att("<Agent-Message from=\"a\">hi</Agent-Message>"), att("<agent-messages are fun")], 5);
    // The first differs in case and shows; the second starts with the opening tag text, so the prefix rule skips it.
    expect(users(out)).toEqual(["go", '<Agent-Message from="a">hi</Agent-Message>']);
  });

  test("a long attachment that is not harness text is scanned quickly", () => {
    const t = performance.now();
    parseTranscript([userRow("go"), att("<".repeat(200000)), att(" ".repeat(200000) + "hello")], 5);
    expect(performance.now() - t).toBeLessThan(budget(500));
  });

  test("real-shaped fixture: prompt, answers, queued user message, peer attachment, task-notification user row", () => {
    const lines = [
      userRow("fix the build"),
      say("looking", "m1", 10, 5),
      att(PEER),
      say("still on it", "m2", 20, 6),
      att("and update the README"),
      userRow(NOTE, { origin: { kind: "task-notification" }, promptSource: "system", isMeta: false }),
      say("both done", "m3", 30, 7),
    ];
    const out = parseTranscript(lines, 2);
    expect(users(out)).toEqual(["fix the build", "and update the README"]);
    expect(out[0].assistant.map((b) => (b as any).text)).toEqual(["looking", "still on it"]);
    expect(out[1].queued).toBe(true);
    expect(out[1].assistant.map((b) => (b as any).text)).toEqual(["both done"]);
    expect(turnOf(out)).toEqual({ startedAt: out[0].startedAt, tokens: { input: 60, output: 18 } });
  });
});

describe("turnOf", () => {
  const ex = (id: string, extra: Partial<Exchange> = {}): Exchange => ({ id, user: [], assistant: [], ...extra });

  test("a last exchange that is not queued is a turn of its own", () => {
    expect(turnOf([ex("a", { startedAt: "t0", tokens: { input: 1, output: 1 } }), ex("b", { startedAt: "t1", tokens: { input: 5, output: 7 } })])).toEqual({
      startedAt: "t1", tokens: { input: 5, output: 7 },
    });
  });

  test("queued exchanges join the turn they interrupted: first startedAt, summed tokens", () => {
    const list = [
      ex("old", { startedAt: "t0", tokens: { input: 1, output: 1 } }),
      ex("a", { startedAt: "t1", tokens: { input: 10, output: 5 } }),
      ex("b", { queued: true, startedAt: "t1", tokens: { input: 20, output: 6 } }),
      ex("c", { queued: true, startedAt: "t1" }),
    ];
    expect(turnOf(list)).toEqual({ startedAt: "t1", tokens: { input: 30, output: 11 } });
  });

  test("a queued exchange with no earlier one in the list is its own turn start", () => {
    expect(turnOf([ex("b", { queued: true, startedAt: "t5", tokens: { input: 2, output: 3 } })])).toEqual({ startedAt: "t5", tokens: { input: 2, output: 3 } });
  });

  test("no tokens anywhere leaves tokens out; no exchanges gives an empty turn", () => {
    expect(turnOf([ex("a", { startedAt: "t0" }), ex("b", { queued: true })])).toEqual({ startedAt: "t0" });
    expect(turnOf([])).toEqual({});
  });
});

describe("cleanUserText", () => {
  test("slash command wrapper becomes the command", () => {
    const raw = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>";
    expect(cleanUserText(raw)).toBe("/model");
  });
  test("slash command keeps its arguments", () => {
    const raw = "<command-name>/rename</command-name><command-args>morning</command-args>";
    expect(cleanUserText(raw)).toBe("/rename morning");
  });
  test("local command output is dropped", () => {
    expect(cleanUserText("<local-command-stdout>Set model</local-command-stdout>")).toBe("");
  });
  test("plain text is trimmed", () => {
    expect(cleanUserText("  hi  ")).toBe("hi");
  });

  describe("pasted_content wrapper", () => {
    test("the exact stored shape: only the two tags go, the content stays", () => {
      expect(cleanUserText('<pasted_content id="cbd4">dictated text here</pasted_content id="cbd4">')).toBe("dictated text here");
    });
    test("the content keeps its own line breaks and inner spacing", () => {
      expect(cleanUserText('<pasted_content id="a1">line one\n\n  indented\nline  three</pasted_content id="a1">')).toBe(
        "line one\n\n  indented\nline  three",
      );
    });
    test("text before and after the block", () => {
      expect(cleanUserText('see this: <pasted_content id="x-1">body</pasted_content id="x-1"> thanks')).toBe("see this: body thanks");
      expect(cleanUserText('before\n<pasted_content id="b">body</pasted_content id="b">\nafter')).toBe("before\nbody\nafter");
    });
    test("two blocks in one message", () => {
      expect(cleanUserText('<pasted_content id="a">one</pasted_content id="a"> and <pasted_content id="b_2">two</pasted_content id="b_2">')).toBe(
        "one and two",
      );
    });
    test("the plain closing form, quoted or unquoted ids, and whitespace inside the tags", () => {
      expect(cleanUserText('<pasted_content id="a">x</pasted_content>')).toBe("x");
      expect(cleanUserText("<pasted_content id=abc>x</pasted_content id=abc>")).toBe("x");
      expect(cleanUserText('<pasted_content   id="a"  >x</pasted_content   id="a"  >')).toBe("x");
      expect(cleanUserText("<pasted_content>x</pasted_content >")).toBe("x");
    });
    test("a message that is only the wrapper is empty", () => {
      expect(cleanUserText('<pasted_content id="a"></pasted_content id="a">')).toBe("");
      expect(cleanUserText('  <pasted_content id="a">\n</pasted_content id="a">  ')).toBe("");
    });
    test("similar tags and other attributes are left alone", () => {
      expect(cleanUserText("<pasted_contents>x</pasted_contents>")).toBe("<pasted_contents>x</pasted_contents>");
      expect(cleanUserText('<pasted_content src="a">x')).toBe('<pasted_content src="a">x');
      expect(cleanUserText("a < b and c > d")).toBe("a < b and c > d");
    });
    test("a very long run after the tag name is handled in bounded time", () => {
      const t = Date.now();
      cleanUserText("<pasted_content id=" + "a".repeat(200_000));
      cleanUserText("<pasted_content ".repeat(20_000));
      expect(Date.now() - t).toBeLessThan(budget(1000));
    });
  });
});

describe("pasted_content in a transcript", () => {
  const texts = (blocks: { kind: string; text?: string }[]) => blocks.map((b) => b.text);
  test("a dictated message stays a user bubble without the wrapper, as a row, a text block and a queued prompt", () => {
    const row = { type: "user", uuid: "u1", message: { role: "user", content: '<pasted_content id="cbd4">hello there</pasted_content id="cbd4">' } };
    const out = parseTranscript([JSON.stringify(row)], 10);
    expect(out).toHaveLength(1);
    expect(texts(out[0].user)).toEqual(["hello there"]);
    const asBlocks = { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: '<pasted_content id="z">in a block</pasted_content id="z">' }] } };
    expect(texts(parseTranscript([JSON.stringify(asBlocks)], 10)[0].user)).toEqual(["in a block"]);
    const queued = { type: "attachment", timestamp: "2026-10-01T10:00:00.000Z", attachment: { type: "queued_command", prompt: '<pasted_content id="q">queued</pasted_content id="q">' } };
    expect(texts(parseTranscript([JSON.stringify(queued)], 10)[0].user)).toEqual(["queued"]);
  });
});

describe("interruption markers", () => {
  const texts = (blocks: { kind: string; text?: string }[]) => blocks.map((b) => b.text);
  const userRow = (content: unknown, ts: string, uuid: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: ts, message: { role: "user", content } });
  const reply = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const MARKERS = ["[Request interrupted by user]", "[Request interrupted by user for tool use]"];

  test("the block form, the string form and the for-tool-use form are not user prompts", () => {
    for (const marker of MARKERS) {
      expect(parseTranscript([userRow([{ type: "text", text: marker }], "2026-10-01T10:00:00.000Z", "i1")], 10)).toEqual([]);
      expect(parseTranscript([userRow(marker, "2026-10-01T10:00:00.000Z", "i2")], 10)).toEqual([]);
      expect(parseTranscript([userRow(`  ${marker}\n`, "2026-10-01T10:00:00.000Z", "i3")], 10)).toEqual([]);
    }
  });

  test("an interrupted turn keeps the exchange before it and adds none", () => {
    const lines = [
      userRow("do the thing", "2026-10-01T10:00:00.000Z", "u1"),
      reply("working"),
      userRow([{ type: "text", text: "[Request interrupted by user]" }], "2026-10-01T10:01:00.000Z", "i1"),
    ];
    const out = parseTranscript(lines, 10);
    expect(out).toHaveLength(1);
    expect(texts(out[0].user)).toEqual(["do the thing"]);
    expect(out[0].assistant).toEqual([{ kind: "text", text: "working" }]);
  });

  test("the window of two keeps the two real exchanges around an interruption", () => {
    const lines = [
      userRow("first", "2026-10-01T10:00:00.000Z", "u1"),
      reply("a1"),
      userRow([{ type: "text", text: "[Request interrupted by user for tool use]" }], "2026-10-01T10:01:00.000Z", "i1"),
      userRow("second", "2026-10-01T10:02:00.000Z", "u2"),
      reply("a2"),
      userRow([{ type: "text", text: "[Request interrupted by user]" }], "2026-10-01T10:03:00.000Z", "i2"),
    ];
    const out = parseTranscript(lines, 2);
    expect(out.map((e) => texts(e.user))).toEqual([["first"], ["second"]]);
    expect(turnOf(out).startedAt).toBe("2026-10-01T10:02:00.000Z"); // the clock is from the real prompt
  });

  test("a real message that only contains the phrase stays", () => {
    const sentence = "why does it print [Request interrupted by user] when I press Esc?";
    expect(texts(parseTranscript([userRow(sentence, "2026-10-01T10:00:00.000Z", "u1")], 10)[0].user)).toEqual([sentence]);
    const extra = "[Request interrupted by user] and then more";
    expect(texts(parseTranscript([userRow(extra, "2026-10-01T10:00:00.000Z", "u2")], 10)[0].user)).toEqual([extra]);
  });

  test("a mixed row keeps its other text", () => {
    const row = userRow([{ type: "text", text: "[Request interrupted by user]" }, { type: "text", text: "use the other file" }], "2026-10-01T10:00:00.000Z", "m1");
    expect(texts(parseTranscript([row], 10)[0].user)).toEqual(["use the other file"]);
  });

  test("as a queued prompt it is dropped too", () => {
    const queued = { type: "attachment", timestamp: "2026-10-01T10:00:00.000Z", attachment: { type: "queued_command", prompt: "[Request interrupted by user]" } };
    expect(parseTranscript([JSON.stringify(queued)], 10)).toEqual([]);
  });

  test("ArrowUp recall does not offer it", async () => {
    const { userTexts } = await import("../ui/recall");
    const lines = [
      userRow("first", "2026-10-01T10:00:00.000Z", "u1"),
      reply("a1"),
      userRow("[Request interrupted by user]", "2026-10-01T10:01:00.000Z", "i1"),
    ];
    expect(userTexts(parseTranscript(lines, 10))).toEqual(["first"]);
  });
});
