import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../src-tauri/src/sponsorblock_probe.js", import.meta.url),
  "utf8",
);

function createSponsorBlockEnv({ fetchMock, httpMock } = {}) {
  const registered = {};
  const listeners = {};
  let toastEl = null;

  const media = {
    currentTime: 10,
    duration: 200,
    addEventListener(event, fn) {
      listeners[event] = fn;
    },
    removeEventListener(event) {
      delete listeners[event];
    },
  };

  const context = {
    Array,
    Date,
    JSON,
    Map,
    Number,
    URL,
    encodeURIComponent,
    setTimeout(fn) {
      return 1;
    },
    clearTimeout() {},
    setInterval(fn) {
      return 1;
    },
    clearInterval() {},
    location: { href: "https://music.youtube.com/watch?v=vid123" },
    document: {
      querySelector() {
        return {
          getVideoData() {
            return { video_id: "vid123" };
          },
          addEventListener() {},
        };
      },
      getElementById(id) {
        return id === "ytm-tauri-sponsorblock-toast" ? toastEl : null;
      },
      createElement(tag) {
        toastEl = {
          id: "",
          style: {},
          textContent: "",
          remove() {},
        };
        return toastEl;
      },
      body: {
        appendChild() {},
      },
    },
    window: {
      fetch: fetchMock || (async () => ({
        ok: true,
        json: async () => [{ segment: [20, 35] }],
      })),
    },
    __ytmFeatures: {
      media() {
        return media;
      },
      register(name, obj) {
        registered[name] = obj;
      },
      http: httpMock,
    },
  };

  context.window.__ytmFeatures = context.__ytmFeatures;
  vm.runInNewContext(source, context);

  return {
    registered,
    listeners,
    media,
    context,
  };
}

test("sponsorblock registers with feature runtime", () => {
  const env = createSponsorBlockEnv();
  assert.ok(env.registered.sponsorblock);
  assert.equal(typeof env.registered.sponsorblock.start, "function");
  assert.equal(typeof env.registered.sponsorblock.stop, "function");
});

test("sponsorblock skips segment and updates media currentTime", async () => {
  let fetchCount = 0;
  const env = createSponsorBlockEnv({
    fetchMock: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => [{ segment: [25, 45] }],
      };
    },
  });

  env.registered.sponsorblock.start();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(fetchCount, 1);

  env.media.currentTime = 25;
  env.listeners.timeupdate();
  assert.equal(env.media.currentTime, 45);

  env.registered.sponsorblock.stop();
});

test("sponsorblock uses in-memory cache on repeat calls", async () => {
  let fetchCount = 0;
  const env = createSponsorBlockEnv({
    fetchMock: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => [{ segment: [10, 20] }],
      };
    },
  });

  env.registered.sponsorblock.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetchCount, 1);

  env.registered.sponsorblock.stop();
  env.registered.sponsorblock.start();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(fetchCount, 1);
  env.registered.sponsorblock.stop();
});
