import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const playbackSource = await readFile(
  new URL("../src-tauri/src/playback_speed_probe.js", import.meta.url),
  "utf8",
);
const autoplaySource = await readFile(
  new URL("../src-tauri/src/disable_autoplay_probe.js", import.meta.url),
  "utf8",
);
const dislikedSource = await readFile(
  new URL("../src-tauri/src/skip_disliked_probe.js", import.meta.url),
  "utf8",
);

function createElement() {
  return {
    style: {},
    dataset: {},
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    prepend(child) {
      this.children.unshift(child);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    contains() {
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    setAttribute() {},
  };
}

function createIntervals() {
  const intervals = [];
  return {
    intervals,
    setInterval(callback) {
      const entry = { callback, cleared: false };
      intervals.push(entry);
      return entry;
    },
    clearInterval(entry) {
      if (entry) entry.cleared = true;
    },
  };
}

function createPlaybackContext() {
  const intervals = createIntervals();
  let media = createMedia();
  const storage = new Map();
  const registered = {};
  const context = {
    document: {
      documentElement: createElement(),
      createElement,
      querySelector() {
        return null;
      },
    },
    localStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    __ytmFeatures: {
      media() {
        return media;
      },
      register(name, feature) {
        registered[name] = feature;
      },
    },
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  };
  context.window = context;
  vm.runInNewContext(playbackSource, context);
  return {
    context,
    registered,
    intervals: intervals.intervals,
    replaceMedia(next) {
      media = next;
    },
  };
}

function createMedia() {
  const listeners = new Map();
  return {
    playbackRate: 1,
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
    emit(name) {
      listeners.get(name)?.();
    },
    hasListener(name) {
      return listeners.has(name);
    },
  };
}

test("playback speed follows a replacement media element", () => {
  const env = createPlaybackContext();
  const first = env.context.__ytmFeatures.media();
  env.registered.playback_speed.start({ playback_rate: 1.5 });
  assert.equal(first.playbackRate, 1.5);
  assert.equal(first.hasListener("ratechange"), true);

  const second = createMedia();
  env.replaceMedia(second);
  env.intervals.find((entry) => !entry.cleared).callback();

  assert.equal(second.playbackRate, 1.5);
  assert.equal(first.hasListener("ratechange"), false);
  assert.equal(second.hasListener("ratechange"), true);
  env.registered.playback_speed.stop();
});

test("disable autoplay follows a replacement media element", () => {
  const intervals = createIntervals();
  let media = createMedia();
  let paused = 0;
  const context = {
    document: {
      querySelector() {
        return { pauseVideo() { paused += 1; } };
      },
    },
    __ytmFeatures: {
      media() {
        return media;
      },
      register(name, feature) {
        context.feature = feature;
      },
    },
    MutationObserver: class {},
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  };
  context.window = context;
  vm.runInNewContext(autoplaySource, context);
  context.feature.start();

  const second = createMedia();
  media = second;
  intervals.intervals.find((entry) => !entry.cleared).callback();
  second.emit("ended");

  assert.equal(paused, 1);
  context.feature.stop();
});

test("skip disliked follows a replacement like button", () => {
  const intervals = createIntervals();
  let button = null;
  let nextClicks = 0;
  const context = {
    document: {
      querySelector(selector) {
        if (selector === "#like-button-renderer") return button;
        return { click() { nextClicks += 1; } };
      },
    },
    MutationObserver: class {
      observe(target) {
        this.target = target;
      }
      disconnect() {}
    },
    __ytmFeatures: {
      register(name, feature) {
        context.feature = feature;
      },
    },
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  };
  context.window = context;
  vm.runInNewContext(dislikedSource, context);
  context.feature.start();

  button = {
    getAttribute() {
      return "DISLIKE";
    },
  };
  intervals.intervals.find((entry) => !entry.cleared).callback();

  // The observer is only used for attribute changes; the initial state is
  // checked when the replacement button is bound.
  assert.equal(nextClicks, 1);
  context.feature.stop();
});
