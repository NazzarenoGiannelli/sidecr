import { describe, expect, test } from "bun:test";
import { createUnloadRunner } from "../ui/unload";

function setup(failing: string[] = []) {
  const log: string[] = [];
  const step = (name: string) => () => {
    log.push(name);
    if (failing.includes(name)) throw new Error(`${name} failed`);
  };
  const u = createUnloadRunner([step("draft"), step("bounds"), step("bye")]);
  return { u, log };
}

describe("unload runner", () => {
  test("runs the steps in order: draft, bounds, bye last", () => {
    const { u, log } = setup();
    u.run();
    expect(log).toEqual(["draft", "bounds", "bye"]);
  });

  test("beforeunload then pagehide runs everything once", () => {
    const { u, log } = setup();
    u.run(); // beforeunload
    u.run(); // pagehide
    expect(log).toEqual(["draft", "bounds", "bye"]);
  });

  test("pagehide alone, or beforeunload alone, runs everything once", () => {
    const a = setup();
    a.u.run();
    expect(a.log).toHaveLength(3);
  });

  test("a step that throws does not stop the later ones (bye still goes), and nothing throws out", () => {
    const { u, log } = setup(["draft", "bounds"]);
    expect(() => u.run()).not.toThrow();
    expect(log).toEqual(["draft", "bounds", "bye"]);
    u.run();
    expect(log).toHaveLength(3);
  });

  test("a page restored from the back/forward cache runs them again after rearm", () => {
    const { u, log } = setup();
    u.run();
    u.rearm(); // pageshow with persisted
    u.run();
    expect(log).toEqual(["draft", "bounds", "bye", "draft", "bounds", "bye"]);
  });

  test("rearm before any run changes nothing", () => {
    const { u, log } = setup();
    u.rearm();
    u.run();
    u.run();
    expect(log).toHaveLength(3);
  });
});
