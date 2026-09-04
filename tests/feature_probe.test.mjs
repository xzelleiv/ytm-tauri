import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src-tauri/src/feature_probe.js", import.meta.url), "utf8");

function createRuntime(initialTitle = "YouTube Music") {
  let timerId = 0;
  const timers = [];
  const context = {
    clearTimeout() {},
    console,
    Date,
    document: {
      addEventListener() {},
      documentElement: {},
      querySelector() {
        return null;
      },
      createElement() {
        return { id: "", textContent: "", appendChild() {} };
      },
      getElementById() {
        return null;
      },
      readyState: "complete",
      title: initialTitle,
    },
    setTimeout(callback, delay = 0) {
      timers.push({ callback, delay });
      return ++timerId;
    },
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(source, context);
  context.runImmediateTimers = () => {
    const ready = timers.splice(0).filter((timer) => timer.delay <= 10);
    for (const timer of ready) timer.callback();
  };
  return context;
}

test("feature requests release the document title after a native response", async () => {
  const context = createRuntime();
  const pending = context.window.__ytmFeatures.request("https://lrclib.net/api/search");
  const request = JSON.parse(context.document.title.slice("YTMFEATURE:".length));

  context.window.__ytmFeatures.receive(request.id, { ok: true });

  await pending;
  assert.equal(context.document.title, "YouTube Music");
});

test("feature responses do not overwrite a newer track title", async () => {
  const context = createRuntime();
  const pending = context.window.__ytmFeatures.request("https://lrclib.net/api/search");
  const request = JSON.parse(context.document.title.slice("YTMFEATURE:".length));
  const trackTitle = 'YTMRPC:{"type":"track"}';
  context.document.title = trackTitle;

  context.window.__ytmFeatures.receive(request.id, { ok: true });

  await pending;
  assert.equal(context.document.title, trackTitle);
});

test("setSetting emits feature request and updates config", async () => {
  const context = createRuntime();
  const pending = context.window.__ytmFeatures.setSetting("synced_lyrics", false);
  const request = JSON.parse(context.document.title.slice("YTMFEATURE:".length));

  assert.equal(request.kind, "set_setting");
  assert.equal(request.key, "synced_lyrics");
  assert.equal(request.value, false);
  assert.equal(context.window.__ytmFeatures.config.synced_lyrics, false);

  context.window.__ytmFeatures.receive(request.id, { ok: true });
  await pending;
});

test("triggerAction emits action request", async () => {
  const context = createRuntime();
  const pending = context.window.__ytmFeatures.triggerAction("check_updates");
  const request = JSON.parse(context.document.title.slice("YTMFEATURE:".length));

  assert.equal(request.kind, "action");
  assert.equal(request.action, "check_updates");

  context.window.__ytmFeatures.receive(request.id, { ok: true });
  await pending;
});

test("late feature responses cannot release the active request slot", async () => {
  const context = createRuntime();
  const first = context.window.__ytmFeatures.getSettings();
  const firstTitle = context.document.title;
  const firstRequest = JSON.parse(firstTitle.slice("YTMFEATURE:".length));
  const second = context.window.__ytmFeatures.triggerAction("check_updates");

  context.window.__ytmFeatures.receive(firstRequest.id + 100, { ok: true });
  context.runImmediateTimers();
  assert.equal(context.document.title, firstTitle);

  context.window.__ytmFeatures.receive(firstRequest.id, { ok: true });
  context.runImmediateTimers();
  const secondRequest = JSON.parse(context.document.title.slice("YTMFEATURE:".length));
  context.window.__ytmFeatures.receive(secondRequest.id, { ok: true });
  await Promise.all([first, second]);
});

test("rejected setting writes restore the previous runtime value", async () => {
  const context = createRuntime();
  context.window.__ytmFeatures.configure({ synced_lyrics: true });
  const pending = context.window.__ytmFeatures.setSetting("synced_lyrics", false);
  const request = JSON.parse(context.document.title.slice("YTMFEATURE:".length));

  context.window.__ytmFeatures.receive(request.id, { error: "invalid setting value" });

  await assert.rejects(pending, /invalid setting value/);
  assert.equal(context.window.__ytmFeatures.config.synced_lyrics, true);
});

test("clearOrphanedInert removes inert attribute when no dialog is visible", () => {
  let inertRemoved = false;
  let pointerDownHandler = null;
  const layout = {
    removeAttribute(attr) {
      if (attr === "inert") inertRemoved = true;
    },
  };
  const context = {
    clearTimeout() {},
    console,
    Date,
    document: {
      addEventListener() {},
      documentElement: {},
      querySelector(selector) {
        if (selector === "ytmusic-app-layout[inert]") return layout;
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement() {
        return { id: "", textContent: "", appendChild() {} };
      },
      getElementById() {
        return null;
      },
      readyState: "complete",
      title: "YouTube Music",
    },
    setTimeout() {
      return 1;
    },
    setInterval() {
      return 1;
    },
    addEventListener(event, handler) {
      if (event === "pointerdown") pointerDownHandler = handler;
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);

  assert.equal(typeof pointerDownHandler, "function");
  pointerDownHandler();
  assert.equal(inertRemoved, true);
});
