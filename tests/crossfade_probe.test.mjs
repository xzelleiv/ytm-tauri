import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../src-tauri/src/crossfade_probe.js", import.meta.url),
  "utf8",
);

function createCrossfadeEnv() {
  const registered = {};
  const listeners = {};
  const media = {
    volume: 1,
    currentTime: 30,
    duration: 180,
    paused: false,
    seeking: false,
    addEventListener(event, fn) {
      listeners[event] = fn;
    },
    removeEventListener(event) {
      delete listeners[event];
    },
  };

  const context = {
    Date,
    Math,
    setInterval(fn) {
      return 1;
    },
    clearInterval() {},
    location: { href: "https://music.youtube.com/" },
    document: {
      querySelector() {
        return null;
      },
    },
    window: {
      addEventListener(event, fn) {
        listeners[event] = fn;
      },
      removeEventListener(event) {
        delete listeners[event];
      },
    },
    __ytmFeatures: {
      media() {
        return media;
      },
      register(name, obj) {
        registered[name] = obj;
      },
    },
  };

  context.window.__ytmFeatures = context.__ytmFeatures;
  vm.runInNewContext(source, context);

  return { registered, listeners, media, context };
}

test("crossfade does not duck volume when navigating while playing", () => {
  const { registered, listeners, media, context } = createCrossfadeEnv();

  registered.crossfade.start();
  assert.equal(media.volume, 1);

  // simulate navigation while listening
  context.location.href = "https://music.youtube.com/explore";
  if (listeners["ytm-track-change"]) {
    listeners["ytm-track-change"]({ detail: null });
  }

  // volume must not duck
  assert.equal(media.volume, 1);

  // navigate to now playing
  context.location.href = "https://music.youtube.com/watch?v=abc";
  if (listeners["ytm-track-change"]) {
    listeners["ytm-track-change"]({ detail: null });
  }

  assert.equal(media.volume, 1);
});

test("crossfade triggers fade in only on new track starting at beginning", () => {
  const { registered, listeners, media } = createCrossfadeEnv();

  registered.crossfade.start();
  assert.equal(media.volume, 1);

  // new track starting at 0s
  media.currentTime = 0.2;
  if (listeners["ytm-track-change"]) {
    listeners["ytm-track-change"]({
      detail: { videoId: "song1", title: "Song 1", author: "Artist" },
    });
  }

  // fade in starts at 0
  assert.equal(media.volume, 0);
});
