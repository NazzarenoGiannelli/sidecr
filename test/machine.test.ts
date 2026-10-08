import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMachineName } from "../src/machine";

const fresh = () => mkdtempSync(join(tmpdir(), "sidecr-machine-"));
const host = () => "  box-host  ";

describe("readMachineName", () => {
  test("reads and trims the file", () => {
    const dir = fresh();
    writeFileSync(join(dir, "machine-name"), "  desk \n");
    expect(readMachineName(dir, host)).toBe("desk");
  });

  test("a missing file gives the trimmed hostname", () => {
    expect(readMachineName(join(fresh(), "nope"), host)).toBe("box-host");
  });

  test("an empty or blank file gives the hostname", () => {
    const dir = fresh();
    writeFileSync(join(dir, "machine-name"), "  \n\t \n");
    expect(readMachineName(dir, host)).toBe("box-host");
  });

  test("whitespace is collapsed and control characters are stripped", () => {
    const dir = fresh();
    writeFileSync(join(dir, "machine-name"), "my \t  big\u0000 mach\u001b[31mine\r\n");
    expect(readMachineName(dir, host)).toBe("my big mach[31mine");
  });

  test("the name is limited to 40 characters", () => {
    const dir = fresh();
    writeFileSync(join(dir, "machine-name"), "x".repeat(100));
    expect(readMachineName(dir, host)).toBe("x".repeat(40));
  });

  test("the hostname fallback is limited too", () => {
    expect(readMachineName(fresh(), () => "h".repeat(90))).toBe("h".repeat(40));
  });

  test("never throws: a directory in place of the file, a throwing hostname", () => {
    const dir = fresh();
    writeFileSync(join(dir, "machine-name"), "x");
    expect(() => readMachineName(join(dir, "machine-name"), host)).not.toThrow();
    expect(readMachineName(fresh(), () => { throw new Error("no hostname"); })).toBe("");
  });

  test("uses os.hostname by default", () => {
    expect(typeof readMachineName(join(fresh(), "nope"))).toBe("string");
  });
});
