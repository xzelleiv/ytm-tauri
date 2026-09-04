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
    setTimeout(fn, ms) {
      return setTimeout(fn, ms);
    },
    clearTimeout(id) {
      clearTimeout(id);
    },
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

test("crossfade integrates with audioEngine fader when available", () => {
  const { registered, listeners, media, context } = createCrossfadeEnv();

  let faderCalls = [];
  context.__ytmFeatures.audioEngine = {
    setFaderGain(target, duration, curve) {
      faderCalls.push({ target, duration, curve });
    },
  };

  registered.crossfade.start({ crossfade_seconds: 6.0, crossfade_curve: "equal-power" });

  // trigger fade out
  media.currentTime = 175;
  media.duration = 180;
  if (listeners["timeupdate"]) {
    listeners["timeupdate"]();
  }

  assert.ok(faderCalls.length > 0);
  assert.equal(faderCalls[0].target, 0);
  assert.equal(faderCalls[0].duration, 6000);
  assert.equal(faderCalls[0].curve, "equal-power");
});

test("crossfade updates configuration dynamically without restart", () => {
  const { registered, listeners, media, context } = createCrossfadeEnv();

  let faderCalls = [];
  context.__ytmFeatures.audioEngine = {
    setFaderGain(target, duration, curve) {
      faderCalls.push({ target, duration, curve });
    },
  };

  registered.crossfade.start({ crossfade_seconds: 4.0, crossfade_curve: "equal-power" });

  // dynamically update config
  registered.crossfade.update({ crossfade_seconds: 8.0, crossfade_curve: "logarithmic" });

  media.currentTime = 173;
  media.duration = 180;
  if (listeners["timeupdate"]) {
    listeners["timeupdate"]();
  }

  assert.ok(faderCalls.length > 0);
  assert.equal(faderCalls[0].target, 0);
  assert.equal(faderCalls[0].duration, 8000);
  assert.equal(faderCalls[0].curve, "logarithmic");
});

test("crossfade restores volume when paused during fade", () => {
  const { registered, listeners, media, context } = createCrossfadeEnv();

  let faderCalls = [];
  context.__ytmFeatures.audioEngine = {
    setFaderGain(target, duration, curve) {
      faderCalls.push({ target, duration, curve });
    },
  };

  registered.crossfade.start({ crossfade_seconds: 4.0 });

  // trigger fade out
  media.currentTime = 177;
  media.duration = 180;
  if (listeners["timeupdate"]) {
    listeners["timeupdate"]();
  }

  // pause during fade
  if (listeners["pause"]) {
    listeners["pause"]();
  }

  const lastCall = faderCalls[faderCalls.length - 1];
  assert.equal(lastCall.target, 1);
  assert.equal(lastCall.duration, 0);
});

test("crossfade does not mutate media volume when audioEngine is available", () => {
  const { registered, listeners, media, context } = createCrossfadeEnv();

  context.__ytmFeatures.audioEngine = {
    setFaderGain() {},
  };

  media.volume = 0.8;
  registered.crossfade.start({ crossfade_seconds: 4.0 });

  // trigger fade out
  media.currentTime = 177;
  media.duration = 180;
  if (listeners["timeupdate"]) {
    listeners["timeupdate"]();
  }

  // media volume untouched
  assert.equal(media.volume, 0.8);
});

test("manual skip uses fast anti-pop ramp", () => {
  const { registered, listeners, media, context } = createCrossfadeEnv();

  let faderCalls = [];
  context.__ytmFeatures.audioEngine = {
    setFaderGain(target, duration, curve) {
      faderCalls.push({ target, duration, curve });
    },
  };

  registered.crossfade.start({ crossfade_seconds: 6.0 });

  // simulate manual skip
  media.currentTime = 0.2;
  if (listeners["ytm-track-change"]) {
    listeners["ytm-track-change"]({ detail: { videoId: "next-track-123" } });
  }

  assert.ok(faderCalls.length > 0);
  const rampCall = faderCalls[faderCalls.length - 1];
  assert.equal(rampCall.target, 1);
  assert.equal(rampCall.duration, 80);
});
