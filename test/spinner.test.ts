import { describe, expect, test } from "bun:test";
import { parseSpinnerLine } from "../src/spinner";
import { budget } from "./timing";

const screen = (...lines: string[]) => lines.join("\n") + "\n";

describe("parseSpinnerLine", () => {
  test("the usual line with a token count", () => {
    expect(parseSpinnerLine(screen("output", "* Considering… (1m 44s · ↓ 9.0k tokens)", "❯ "))).toEqual({
      verb: "Considering", elapsedSec: 104, detail: "↓ 9.0k tokens",
    });
  });

  test("the interrupt hint is left out of the detail", () => {
    expect(parseSpinnerLine(screen("✶ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)"))).toEqual({
      verb: "Pondering", elapsedSec: 12, detail: "↑ 1.2k tokens",
    });
  });

  test("elapsed time only gives a null detail", () => {
    expect(parseSpinnerLine(screen("✻ Cooking… (3s)"))).toEqual({ verb: "Cooking", elapsedSec: 3, detail: null });
  });

  test("three dots, hours, and a middle dot glyph", () => {
    expect(parseSpinnerLine(screen("· Brewing... (1h 2m 3s · ↓ 120 tokens)"))).toEqual({
      verb: "Brewing", elapsedSec: 3723, detail: "↓ 120 tokens",
    });
  });

  test("a part with ctrl+ is dropped, other parts stay in order", () => {
    expect(parseSpinnerLine(screen("✢ Working… (5s · ctrl+c to stop · ↓ 1 tokens · thinking)"))).toEqual({
      verb: "Working", elapsedSec: 5, detail: "↓ 1 tokens · thinking",
    });
  });

  test("only hint parts besides the time gives a null detail", () => {
    expect(parseSpinnerLine(screen("✻ Cooking… (3s · esc to interrupt)"))).toEqual({ verb: "Cooking", elapsedSec: 3, detail: null });
  });

  test("the time may come after other parts; minutes alone are fine", () => {
    expect(parseSpinnerLine(screen("✻ Cooking… (↓ 3 tokens · 2m)"))).toEqual({ verb: "Cooking", elapsedSec: 120, detail: "↓ 3 tokens" });
  });

  test("verbs with an apostrophe or a hyphen", () => {
    expect(parseSpinnerLine(screen("✻ Moonwalkin'… (4s)"))?.verb).toBe("Moonwalkin'");
    expect(parseSpinnerLine(screen("✻ Spelunk-ing… (4s)"))?.verb).toBe("Spelunk-ing");
  });

  test("surrounding whitespace and an astral glyph are tolerated", () => {
    expect(parseSpinnerLine(screen("   ✶ Pondering… (12s)   "))?.elapsedSec).toBe(12);
    expect(parseSpinnerLine(screen("\u{1F4A0} Pondering… (12s)"))?.elapsedSec).toBe(12);
  });

  test("CRLF line endings", () => {
    expect(parseSpinnerLine("a\r\n✶ Pondering… (12s)\r\n❯ \r\n")?.elapsedSec).toBe(12);
  });

  test.each([
    "Considering… (maybe later)",
    "* Considering… (maybe later)",
    "Update installed · Restart to update",
    "* considering… (12s)", // verb must start uppercase
    "** Considering… (12s)", // exactly one glyph
    "a Considering… (12s)", // the glyph is not alphanumeric
    "* Considering (12s)", // no ellipsis
    "* Considering…(12s)", // no space before the parenthesis
    "* Considering… (12s) and more text",
    "* Considering… (12s",
    "* Considering… ()",
    "* Considering… (12 s)",
    "* Considering… (12x)",
    "* Considering… (m 12s)",
    "* Considering… (12s 1m)", // units out of order
    "* 3Considering… (12s)",
    "- Fetching… (3s)", // markdown list bullet, not a spinner glyph
    "+ Adding… (3s)",
    "> Thinking… (1s)", // markdown quote
    "# Heading… (1s)",
    "| Cell… (1s)",
    '" Quoted… (1s)',
    "",
  ])("not a spinner: %p", (line) => {
    expect(parseSpinnerLine(screen("before", line, "after"))).toBeNull();
  });

  test("the real glyphs still match: * · ✶ ✻", () => {
    for (const glyph of ["*", "·", "✶", "✻"]) {
      expect(parseSpinnerLine(screen(`${glyph} Fetching… (3s)`))).toEqual({ verb: "Fetching", elapsedSec: 3, detail: null });
    }
  });

  test("the last match wins", () => {
    expect(parseSpinnerLine(screen("* Reading… (10s)", "text", "✶ Writing… (20s · ↓ 5 tokens)", "❯ "))).toEqual({
      verb: "Writing", elapsedSec: 20, detail: "↓ 5 tokens",
    });
  });

  test("only the last 30 non-empty lines are scanned; blank lines do not count", () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
    expect(parseSpinnerLine(screen("* Old… (1s)", ...filler(30)))).toBeNull();
    expect(parseSpinnerLine(screen("* Old… (1s)", ...filler(29)))?.verb).toBe("Old");
    expect(parseSpinnerLine("* Old… (1s)\n" + "\n\n".repeat(50) + filler(29).join("\n\n\n"))?.verb).toBe("Old");
  });

  test("an empty screen", () => {
    expect(parseSpinnerLine("")).toBeNull();
    expect(parseSpinnerLine("\n\n")).toBeNull();
  });

  test("long untrusted input is scanned in linear time", () => {
    const inputs = [
      "* Considering… (" + "1s · ".repeat(20000),
      "* " + "A".repeat(100000),
      "*" + " ".repeat(100000) + "Considering… (1s)",
      "* Considering… (" + "1h ".repeat(40000) + ")",
      ("* Considering… (1s)" + " ").repeat(5000),
      "x".repeat(100000),
      ("* A… (" + "9".repeat(50) + "s)\n").repeat(3000),
      "\n".repeat(100000),
      ("-".repeat(99) + "\n").repeat(1000),
    ];
    for (const input of inputs) {
      const t = performance.now();
      parseSpinnerLine(input);
      expect(performance.now() - t).toBeLessThan(budget(100));
    }
  });
});
