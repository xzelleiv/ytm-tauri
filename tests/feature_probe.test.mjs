import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src-tauri/src/feature_probe.js", import.meta.url), "utf8");

function createRuntime(initialTitle = "YouTube Music") {
  let timerId = 0;
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
      readyState: "complete",
      title: initialTitle,
    },
    setTimeout() {
      return ++timerId;
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);
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
