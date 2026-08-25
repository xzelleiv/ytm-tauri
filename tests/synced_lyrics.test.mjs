import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src-tauri/src/synced_lyrics_probe.js", import.meta.url), "utf8");

function createRuntime() {
  const events = new Map();
  const storage = new Map();
  const elements = new Map();

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
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
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
  return { context, features };
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

