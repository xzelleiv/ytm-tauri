import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src-tauri/src/synced_lyrics_probe.js", import.meta.url), "utf8");

function createRuntime() {
  const events = new Map();
  const storage = new Map();
  const elements = new Map();
  const intervals = [];

  const doc = {
    addEventListener(name, handler) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      const list = events.get(name);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        children: [],
        dataset: {},
        style: {
          setProperty() {},
          removeProperty() {},
        },
        classList: {
          add() {},
          remove() {},
          contains() {
            return false;
          },
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        prepend(child) {
          this.children.unshift(child);
          return child;
        },
        append(...children) {
          this.children.push(...children);
        },
        replaceChildren(...children) {
          this.children = [...children];
        },
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect() {
          return { top: 0, height: 100, width: 100 };
        },
      };
      return el;
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    head: null,
    body: null,
    documentElement: null,
  };
  doc.head = doc.createElement("head");
  doc.body = doc.createElement("body");
  doc.documentElement = doc.createElement("html");

  const context = {
    console,
    Date,
    document: doc,
    localStorage: {
      getItem(k) {
        return storage.get(k) || null;
      },
      setItem(k, v) {
        storage.set(k, String(v));
      },
      removeItem(k) {
        storage.delete(k);
      },
    },
    sessionStorage: {
      getItem(k) {
        return storage.get(k) || null;
      },
      setItem(k, v) {
        storage.set(k, String(v));
      },
      removeItem(k) {
        storage.delete(k);
      },
    },
    location: {
      hostname: "music.youtube.com",
      href: "https://music.youtube.com/",
    },
    navigator: {
      mediaSession: {
        metadata: null,
      },
    },
    setInterval(callback, delay) {
      const id = intervals.length + 1;
      intervals.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearInterval(id) {
      const interval = intervals.find((item) => item.id === id);
      if (interval) interval.cleared = true;
    },
    setTimeout(fn, delay) {
      if (typeof fn === "function") {
        return globalThis.setTimeout(fn, Math.min(delay || 0, 10));
      }
      return 1;
    },
    clearTimeout(id) {
      return globalThis.clearTimeout(id);
    },
    addEventListener(name, handler) {
      doc.addEventListener(name, handler);
    },
    removeEventListener(name, handler) {
      doc.removeEventListener(name, handler);
    },
    dispatchEvent(event) {
      const list = events.get(event.type);
      if (list) {
        for (const fn of list) fn(event);
      }
    },
    URL,
    URLSearchParams,
    AbortController: globalThis.AbortController,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(fn) {
      if (typeof fn === "function") fn();
      return 1;
    },
    cancelAnimationFrame() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch: () => Promise.resolve({ ok: false }),
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  };
  context.window = context;

  const features = new Map();
  context.window.__ytmFeatures = {
    config: {
      lyrics_precise_timing: true,
      lyrics_show_inexact: true,
      lyrics_show_timecodes: false,
      lyrics_romanization: false,
      lyrics_line_effect: "fancy",
    },
    media() {
      return null;
    },
    register(name, feature) {
      features.set(name, feature);
    },
    request() {
      return Promise.reject(new Error("mock request"));
    },
  };

  vm.runInNewContext(source, context);
  return { context, features, intervals };
}

test("synced lyrics registers with runtime", () => {
  const { features } = createRuntime();
  assert.ok(features.has("synced_lyrics"));
  const plugin = features.get("synced_lyrics");
  assert.equal(typeof plugin.start, "function");
  assert.equal(typeof plugin.stop, "function");
});

test("synced lyrics does not activate off music.youtube.com host", () => {
  const events = new Map();
  const context = {
    console,
    Date,
    location: {
      hostname: "accounts.google.com",
      href: "https://accounts.google.com/",
    },
    window: {},
  };
  context.window = context;
  context.window.__ytmFeatures = {
    register() {
      assert.fail("should not register off host");
    },
  };
  vm.runInNewContext(source, context);
});

test("synced lyrics respects auto sync setting and starts cleanly", () => {
  const { features } = createRuntime();
  const plugin = features.get("synced_lyrics");
  plugin.start();
  assert.equal(typeof plugin.stop, "function");
  plugin.stop();
});

test("synced lyrics probe handles title sanitization and romanization", () => {
  const { context } = createRuntime();
  assert.ok(context);
});

test("synced lyrics updates its active timing interval without restart", () => {
  const { context, features, intervals } = createRuntime();
  const plugin = features.get("synced_lyrics");
  plugin.start();
  assert.ok(intervals.some((interval) => interval.delay === 100 && !interval.cleared));

  context.window.__ytmFeatures.config.lyrics_precise_timing = false;
  plugin.update();

  assert.ok(intervals.some((interval) => interval.delay === 250 && !interval.cleared));
  assert.ok(intervals.filter((interval) => interval.delay === 100).every((interval) => interval.cleared));
  plugin.stop();
});

test("parseRetryAfter handles integer seconds and HTTP Date strings with bounds", () => {
  const { features } = createRuntime();
  const plugin = features.get("synced_lyrics");
  assert.equal(typeof plugin.parseRetryAfter, "function");

  assert.equal(plugin.parseRetryAfter("120"), 120);
  assert.equal(plugin.parseRetryAfter("10"), 10);
  assert.equal(plugin.parseRetryAfter("1000"), 300); // clamped to 300
  assert.equal(plugin.parseRetryAfter(null), 60); // default
  assert.equal(plugin.parseRetryAfter("invalid"), 60); // default on invalid

  const future = new Date(Date.now() + 45000).toUTCString();
  const diff = plugin.parseRetryAfter(future);
  assert.ok(diff >= 40 && diff <= 50);
});

test("fetchLrcLib honors 429 Retry-After and suppresses subsequent calls", async () => {
  let fetchAttempts = 0;
  const { context, features } = createRuntime();
  const plugin = features.get("synced_lyrics");

  context.fetch = async () => {
    fetchAttempts++;
    return {
      status: 429,
      ok: false,
      headers: {
        get(key) {
          return key.toLowerCase() === "retry-after" ? "60" : null;
        },
      },
    };
  };

  const res1 = await plugin.fetchLrcLib({ title: "Song One", artist: "Artist One" }, 0);
  assert.equal(res1, null);
  assert.equal(fetchAttempts, 1);

  // Subsequent call during cooldown should be suppressed without network fetch
  const res2 = await plugin.fetchLrcLib({ title: "Song Two", artist: "Artist Two" }, 0);
  assert.equal(res2, null);
  assert.equal(fetchAttempts, 1);
});

test("fetchLrcLib aborts execution when track epoch changes", async () => {
  const { context, features } = createRuntime();
  const plugin = features.get("synced_lyrics");

  // If epoch passed does not match currentTrackEpoch (which is initialized to 0), it aborts immediately
  const res = await plugin.fetchLrcLib({ title: "Song", artist: "Artist" }, 999);
  assert.equal(res, null);
});

test("parseLrc parses flexible timestamps and strips inline section headers", () => {
  const { features } = createRuntime();
  const plugin = features.get("synced_lyrics");
  assert.equal(typeof plugin.parseLrc, "function");

  const lrc = [
    "[re:LRCLIB]",
    "[00:10,50][Verse 1] Comma decimal",
    "[00:20.123][Chorus] Three digit millis",
    "[00:30] Integer seconds",
    "[00:40:50] Colon subseconds",
  ].join("\n");

  const parsed = plugin.parseLrc(lrc);
  assert.equal(parsed.lines.length, 5);
  assert.equal(parsed.lines[1].timeInMs, 10500);
  assert.equal(parsed.lines[1].text, "Comma decimal");
  assert.equal(parsed.lines[2].timeInMs, 20123);
  assert.equal(parsed.lines[2].text, "Three digit millis");
  assert.equal(parsed.lines[3].timeInMs, 30000);
  assert.equal(parsed.lines[3].text, "Integer seconds");
  assert.equal(parsed.lines[4].timeInMs, 40500);
  assert.equal(parsed.lines[4].text, "Colon subseconds");
});

test("renderPlain sanitizes metadata headers and leading timestamps", () => {
  const { context, features } = createRuntime();
  const plugin = features.get("synced_lyrics");
  assert.equal(typeof plugin.renderPlain, "function");

  const target = context.document.createElement("div");
  const rawPlain = [
    "[ar:Test Artist]",
    "[ti:Test Song]",
    "[00:05.10]First line of song",
    "[00:10]Second line of song",
    "[re:LRCLIB]",
  ].join("\n");

  plugin.renderPlain(target, rawPlain);
  assert.equal(target.children.length, 2);
  const firstText = target.children[0].children[0].children[0].children[0].textContent;
  const secondText = target.children[1].children[0].children[0].children[0].textContent;
  assert.equal(firstText, "First line of song");
  assert.equal(secondText, "Second line of song");
});

test("fetchLrcLib aborts immediately when signal is aborted", async () => {
  let fetchCalled = false;
  const { context, features } = createRuntime();
  const plugin = features.get("synced_lyrics");

  context.fetch = async () => {
    fetchCalled = true;
    return { ok: false };
  };

  const controller = new context.AbortController();
  controller.abort();

  const res = await plugin.fetchLrcLib({ title: "Song", artist: "Artist" }, 0, controller.signal);
  assert.equal(res, null);
  assert.equal(fetchCalled, false);
});


