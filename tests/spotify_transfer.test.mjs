import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const spotSource = await readFile(
  new URL("../src-tauri/src/spotify_transfer_probe.js", import.meta.url),
  "utf8"
);
const ytmSource = await readFile(
  new URL("../src-tauri/src/ytm_transfer_probe.js", import.meta.url),
  "utf8"
);

function createSpotifyRuntime(initialTitle = "YouTube Music") {
  let timerId = 0;
  const context = {
    clearTimeout() {},
    console,
    Date,
    location: { hostname: "music.youtube.com", href: "https://music.youtube.com" },
    document: {
      addEventListener() {},
      head: { appendChild() {} },
      body: { appendChild() {} },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement() {
        return {
          id: "",
          className: "",
          innerHTML: "",
          textContent: "",
          classList: { add() {}, remove() {} },
          appendChild() {},
          querySelector() {
            return null;
          },
          querySelectorAll() {
            return [];
          },
        };
      },
      getElementById() {
        return null;
      },
      readyState: "complete",
      title: initialTitle,
    },
    setTimeout() {
      return ++timerId;
    },
    setInterval() {
      return ++timerId;
    },
    clearInterval() {},
  };
  context.window = context;
  vm.runInNewContext(spotSource, context);
  return context;
}

function createYtmRuntime() {
  const context = {
    clearTimeout() {},
    console,
    Date,
    parseInt,
    isNaN,
    encodeURIComponent,
    JSON,
    location: { hostname: "music.youtube.com" },
    window: {
      ytcfg: {
        get(key) {
          if (key === "INNERTUBE_API_KEY") return "test-api-key";
          if (key === "INNERTUBE_CONTEXT") return { client: { clientName: "WEB_REMIX" } };
          return null;
        },
      },
    },
  };
  context.window.window = context.window;
  vm.runInNewContext(ytmSource, context);
  return context;
}

test("spotify bridge serializes and resolves title requests", async () => {
  const runtime = createSpotifyRuntime();
  const promise = runtime.window.__ytmSpotify.send({ action: "get_status" });

  assert.ok(runtime.document.title.startsWith("YTMSPOTIFY:"));
  const payload = JSON.parse(runtime.document.title.slice("YTMSPOTIFY:".length));
  assert.equal(payload.action, "get_status");
  assert.equal(typeof payload.id, "number");

  runtime.window.__ytmSpotify.receive(payload.id, {
    ok: true,
    is_authenticated: true,
    user_name: "Test User",
  });

  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.user_name, "Test User");
  assert.equal(runtime.document.title, "YouTube Music");
});

test("spotify bridge rejects on error payload", async () => {
  const runtime = createSpotifyRuntime();
  const promise = runtime.window.__ytmSpotify.send({ action: "parse_link", link: "invalid" });

  const payload = JSON.parse(runtime.document.title.slice("YTMSPOTIFY:".length));
  runtime.window.__ytmSpotify.receive(payload.id, {
    ok: false,
    error: "invalid spotify link",
  });

  await assert.rejects(promise, /invalid spotify link/);
});

test("ytm transfer adapter cleans search queries", () => {
  const runtime = createYtmRuntime();
  const adapter = runtime.window.__ytmTransferAdapter;

  assert.equal(
    adapter.cleanQuery("Solomon", ["Munimuni", "Clara Benin"]),
    "Munimuni Solomon"
  );
  assert.equal(
    adapter.cleanQuery("Super Trouper - 2011 Remaster", ["ABBA"]),
    "ABBA Super Trouper"
  );
  assert.equal(
    adapter.cleanQuery("Girls Need Love (with Drake) - Remix", ["Summer Walker", "Drake"]),
    "Summer Walker Girls Need Love - Remix"
  );
});

test("ytm transfer adapter batches playlist additions into chunks of 25", async () => {
  const runtime = createYtmRuntime();
  const adapter = runtime.window.__ytmTransferAdapter;

  const calls = [];
  runtime.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return {
      ok: true,
      json: async () => ({ actions: body.actions }),
    };
  };

  const sampleIds = Array.from({ length: 65 }, (_, i) => `vid_${i}`);
  const result = await adapter.addPlaylistItems("PL_TEST", sampleIds);

  assert.equal(result.added, 65);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.actions.length, 25);
  assert.equal(calls[1].body.actions.length, 25);
  assert.equal(calls[2].body.actions.length, 15);
});

test("spotify bridge handles session_connected event emission", () => {
  const runtime = createSpotifyRuntime();
  runtime.window.__ytmSpotify.emit("session_connected", { user_name: "Audiophile Alice" });
  assert.ok(runtime.window.__ytmSpotify);
});

test("Spotify credentials never cross the remote page title bridge", () => {
  assert.doesNotMatch(spotSource, /action:\s*["']set_token["']/);
  assert.doesNotMatch(spotSource, /sp_dc cookie \/ accessToken/i);
  assert.doesNotMatch(spotSource, /manual-token/);
});

test("Spotify Library remains available in the transfer navigation", () => {
  assert.match(spotSource, /data-tab="library">Spotify Library/);
  assert.doesNotMatch(spotSource, /<!-- devmode only\s*<button[^>]+data-tab="library"/);
});

test("ytm transfer adapter passes initial videoIds on createPlaylist", async () => {
  const runtime = createYtmRuntime();
  const adapter = runtime.window.__ytmTransferAdapter;

  let capturedPayload = null;
  runtime.fetch = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ playlistId: "PL_CREATED_123" }),
    };
  };

  const initialIds = ["vid_1", "vid_2", "vid_3"];
  const playlistId = await adapter.createPlaylist("My Spotify Mix", "Desc", "PRIVATE", initialIds);

  assert.equal(playlistId, "PL_CREATED_123");
  assert.equal(capturedPayload.title, "My Spotify Mix");
  assert.deepEqual(capturedPayload.videoIds, initialIds);
});

