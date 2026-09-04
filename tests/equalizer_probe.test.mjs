import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const audioSource = await readFile(
  new URL("../src-tauri/src/audio_engine_probe.js", import.meta.url),
  "utf8"
);

const eqSource = await readFile(
  new URL("../src-tauri/src/equalizer_probe.js", import.meta.url),
  "utf8"
);

function createMockAudioContext() {
  const nodes = [];
  return class MockAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = { name: "destination" };
    }
    createMediaElementSource(media) {
      return {
        type: "MediaElementSource",
        media,
        connect(target) {
          this.target = target;
        },
        disconnect() {},
      };
    }
    createBiquadFilter() {
      const filter = {
        type: "peaking",
        frequency: { value: 0 },
        Q: { value: 1 },
        gain: {
          value: 0,
          setTargetAtTime(val) {
            this.value = val;
          },
        },
        connect(target) {
          this.target = target;
        },
        disconnect() {},
      };
      nodes.push(filter);
      return filter;
    }
    createDynamicsCompressor() {
      return {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect(target) {
          this.target = target;
        },
      };
    }
    createGain() {
      return {
        gain: {
          value: 1,
          setValueAtTime(val) {
            this.value = val;
          },
          setValueCurveAtTime() {},
          cancelScheduledValues() {},
        },
        connect(target) {
          this.target = target;
        },
      };
    }
    resume() {
      return Promise.resolve();
    }
  };
}

function createEnv() {
  const registered = {};
  const media = {
    volume: 1,
    paused: false,
    addEventListener() {},
    removeEventListener() {},
  };

  const context = {
    AudioContext: createMockAudioContext(),
    Float32Array,
    Math,
    navigator: { mediaDevices: { enumerateDevices: () => Promise.resolve([]) } },
    __ytmFeatures: {
      media() {
        return media;
      },
      register(name, obj) {
        registered[name] = obj;
      },
    },
  };
  context.window = context;

  vm.runInNewContext(audioSource, context);
  vm.runInNewContext(eqSource, context);

  return { registered, context, media };
}

test("audio engine builds 10-band equalizer graph with limiter and fader", () => {
  const { context } = createEnv();
  const engine = context.__ytmFeatures.audioEngine.ensure();

  assert.ok(engine);
  assert.equal(engine.eqFilters.length, 10);
  assert.equal(engine.eqFilters[0].type, "lowshelf");
  assert.equal(engine.eqFilters[9].type, "highshelf");
  assert.equal(engine.limiter.ratio.value, 16);
  assert.ok(engine.faderGain);
});

test("equalizer probe applies calibrated presets accurately", () => {
  const { registered, context } = createEnv();
  const engine = context.__ytmFeatures.audioEngine.ensure();

  // bass booster preset
  registered.equalizer.start({ equalizer_preset: "bass-booster" });
  assert.equal(engine.eqFilters[0].gain.value, 6.0);
  assert.equal(engine.eqFilters[1].gain.value, 5.5);

  // rock preset
  registered.equalizer.update({ equalizer_preset: "rock" });
  assert.equal(engine.eqFilters[0].gain.value, 4.5);
  assert.equal(engine.eqFilters[9].gain.value, 5.0);

  // flat preset
  registered.equalizer.update({ equalizer_preset: "flat" });
  for (const filter of engine.eqFilters) {
    assert.equal(filter.gain.value, 0);
  }
});

test("equalizer handles custom gains string and clamps within bounds", () => {
  const { registered, context } = createEnv();
  const engine = context.__ytmFeatures.audioEngine.ensure();

  registered.equalizer.start({
    equalizer_preset: "custom",
    equalizer_custom_gains: "10,5,-5,20,-20,0,3,-2,1,8",
  });

  // check clamped bounds
  assert.equal(engine.eqFilters[0].gain.value, 10);
  assert.equal(engine.eqFilters[3].gain.value, 12);
  assert.equal(engine.eqFilters[4].gain.value, -12);
});

test("stopping equalizer zeroes all band gains", () => {
  const { registered, context } = createEnv();
  const engine = context.__ytmFeatures.audioEngine.ensure();

  registered.equalizer.start({ equalizer_preset: "bass-booster" });
  assert.equal(engine.eqFilters[0].gain.value, 6.0);

  registered.equalizer.stop();
  for (const filter of engine.eqFilters) {
    assert.equal(filter.gain.value, 0);
  }
});

test("audio engine reconnects when media element changes", () => {
  const { context, media } = createEnv();
  const firstEngine = context.__ytmFeatures.audioEngine.ensure();
  assert.equal(firstEngine.media, media);

  // simulate new media
  const newMedia = {
    volume: 1,
    paused: false,
    addEventListener() {},
    removeEventListener() {},
  };
  context.__ytmFeatures.media = () => newMedia;

  const secondEngine = context.__ytmFeatures.audioEngine.ensure();
  assert.ok(secondEngine);
  assert.equal(secondEngine.media, newMedia);
});
