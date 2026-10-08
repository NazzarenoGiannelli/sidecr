import { expect, test } from "bun:test";
import { createPending } from "../ui/pending";

function harness() {
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const pending = createPending(
    () => {
      const url = `blob:test/${++n}`;
      created.push(url);
      return url;
    },
    (url) => revoked.push(url),
  );
  return { pending, created, revoked };
}

const png = (name: string) => new File(["x"], name, { type: "image/png" });
const txt = (name: string) => new File(["x"], name, { type: "text/plain" });

test("add creates one URL per image file, none for other files", () => {
  const { pending, created } = harness();
  pending.add([png("a.png"), txt("b.txt")]);
  expect(pending.count).toBe(2);
  expect(created).toEqual(["blob:test/1"]);
  expect(pending.items.map((i) => i.url)).toEqual(["blob:test/1", null]);
});

test("the URL is created once, however often the list is read", () => {
  const { pending, created } = harness();
  pending.add([png("a.png")]);
  pending.items;
  pending.files();
  pending.items;
  expect(created.length).toBe(1);
});

test("remove revokes only that file's URL and keeps order", () => {
  const { pending, revoked } = harness();
  pending.add([png("a.png"), png("b.png"), png("c.png")]);
  pending.remove(1);
  expect(revoked).toEqual(["blob:test/2"]);
  expect(pending.files().map((f) => f.name)).toEqual(["a.png", "c.png"]);
});

test("remove ignores an out-of-range index", () => {
  const { pending, revoked } = harness();
  pending.add([png("a.png")]);
  pending.remove(5);
  expect(pending.count).toBe(1);
  expect(revoked).toEqual([]);
});

test("clear revokes everything and empties the list", () => {
  const { pending, revoked } = harness();
  pending.add([png("a.png"), png("b.png"), txt("c.txt")]);
  pending.clear();
  expect(pending.count).toBe(0);
  expect(revoked.sort()).toEqual(["blob:test/1", "blob:test/2"]);
});

test("clear on an empty list is a no-op", () => {
  const { pending, revoked } = harness();
  pending.clear();
  expect(revoked).toEqual([]);
});

test("every URL created is revoked exactly once", () => {
  const { pending, created, revoked } = harness();
  pending.add([png("a.png"), png("b.png")]);
  pending.remove(0);
  pending.add([png("c.png")]);
  pending.clear();
  pending.clear();
  pending.add([png("d.png")]);
  pending.remove(0);
  expect(revoked.length).toBe(created.length);
  expect(new Set(revoked).size).toBe(created.length);
  expect([...revoked].sort()).toEqual([...created].sort());
});
