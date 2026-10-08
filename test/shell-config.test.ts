import { expect, test } from "bun:test";

const read = async (p: string) => JSON.parse(await Bun.file(new URL(`../shell/src-tauri/${p}`, import.meta.url)).text());

test("the main capability is the loopback page only, with exactly the window, event and lightbox permissions it needs", async () => {
  const cap = await read("capabilities/default.json");
  expect(cap.windows).toEqual(["main"]);
  expect(cap.local).toBe(false);
  expect(cap.remote.urls).toEqual(["http://localhost:*/*", "http://127.0.0.1:*/*"]);
  expect([...cap.permissions].sort()).toEqual(
    [
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      "core:window:allow-close",
      "core:window:allow-destroy",
      "core:window:allow-minimize",
      "core:window:allow-start-dragging",
      "core:window:allow-set-effects",
      "core:window:allow-set-always-on-top",
      "allow-open-lightbox",
    ].sort(),
  );
});

test("the lightbox capability: its own window, loopback only, may only close or destroy itself", async () => {
  const cap = await read("capabilities/lightbox.json");
  expect(cap.windows).toEqual(["lightbox"]);
  expect(cap.local).toBe(false);
  expect(cap.remote.urls).toEqual(["http://localhost:*/*", "http://127.0.0.1:*/*"]);
  expect([...cap.permissions].sort()).toEqual(["core:window:allow-close", "core:window:allow-destroy"]);
});

test("no other capability file exists (each one is checked above)", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../shell/src-tauri/capabilities/", import.meta.url);
  expect(readdirSync(dir).sort()).toEqual(["default.json", "lightbox.json"]);
});

test("open_lightbox is reachable only through the app manifest permission, and is the only app command", async () => {
  const build = await Bun.file(new URL("../shell/src-tauri/build.rs", import.meta.url)).text();
  expect(build).toContain('AppManifest::new().commands(&["open_lightbox"])');
  const rust = await Bun.file(new URL("../shell/src-tauri/src/main.rs", import.meta.url)).text();
  expect(rust).toContain("tauri::generate_handler![open_lightbox]");
  expect(rust.match(/#\[tauri::command\]/g)?.length).toBe(1);
  // The lightbox window gets the same navigation guard as the main one: the launch origin only.
  expect(rust.match(/\.on_navigation\(/g)?.length).toBe(2);
});

test("the close request is sent to the main window only, so closing the lightbox never closes Sidecr", async () => {
  const rust = await Bun.file(new URL("../shell/src-tauri/src/main.rs", import.meta.url)).text();
  expect(rust).toContain('emit_to("main", CLOSE_REQUESTED_EVENT');
  expect(rust).not.toMatch(/\.emit\(CLOSE_REQUESTED_EVENT/);
});

test("the shell leaves file drops to the page: Tauri's drag-drop handler is off", async () => {
  // With Tauri's handler on, wry calls SetAllowExternalDrop(false) on WebView2 and the page's HTML5 drop never fires,
  // so dragging a file onto the window would attach nothing.
  const rust = await Bun.file(new URL("../shell/src-tauri/src/main.rs", import.meta.url)).text();
  expect(rust).toContain(".disable_drag_drop_handler()");
});

test("tauri.conf.json: name, identifier, binary, global API, no bundle", async () => {
  const conf = await read("tauri.conf.json");
  expect(conf.productName).toBe("Sidecr");
  expect(conf.identifier).toBe("dev.nazz.sidecr");
  expect(conf.mainBinaryName).toBe("sidecr-shell");
  expect(conf.app.withGlobalTauri).toBe(true);
  expect(conf.app.windows).toEqual([]);
  expect(conf.bundle.active).toBe(false);
});

test("test shells: tauri.test.conf.json changes only the identifier, and build:shell:test builds into its own target dir", async () => {
  // A second sidecr-shell with the same identifier hands its URL to the open window (single instance): a test build
  // must never share it with the user's shell, nor overwrite the release binary.
  expect(await read("tauri.test.conf.json")).toEqual({ identifier: "dev.nazz.sidecr.test" });
  const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text());
  expect(pkg.scripts["build:shell:test"]).toContain("--config tauri.test.conf.json");
  expect(pkg.scripts["build:shell:test"]).toContain("CARGO_TARGET_DIR=target-test");
  expect(pkg.scripts["build:shell"]).not.toContain("tauri.test.conf.json");
});
