(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime?.audioEngine) return;

  const presets = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "bass-booster": [6.0, 5.5, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "bass-reducer": [-6.0, -5.0, -3.5, -1.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "treble-booster": [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.5, 4.5, 6.0, 7.0],
    "treble-reducer": [0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -2.5, -4.5, -6.0, -7.0],
    "vocal-booster": [-1.5, -2.0, -1.0, 1.5, 3.5, 4.0, 3.5, 1.5, 0.0, -1.0],
    rock: [4.5, 3.5, 2.0, -1.0, -2.0, -1.0, 1.5, 3.5, 4.5, 5.0],
    pop: [-1.5, 1.0, 2.5, 3.5, 4.0, 3.0, 1.5, 0.5, 1.5, 2.5],
    electronic: [5.5, 4.5, 2.0, 0.0, -1.5, 1.5, 2.0, 3.5, 4.5, 4.0],
    "hip-hop": [6.0, 5.0, 3.0, 1.0, -0.5, 1.0, -1.0, 2.0, 3.5, 4.0],
    acoustic: [3.0, 2.5, 1.5, 0.5, 1.0, 1.5, 2.5, 3.0, 3.5, 3.0],
    classical: [4.0, 3.0, 2.5, 2.0, -1.0, -1.5, 0.0, 2.0, 3.0, 3.5],
    deep: [5.5, 6.0, 3.5, -1.0, -2.0, 1.5, 2.5, 3.0, 3.5, 4.0],
    custom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };

  function parseCustomGains(raw) {
    if (Array.isArray(raw)) return raw.slice(0, 10).map((v) => Number(v) || 0);
    if (typeof raw === "string") {
      const parts = raw.split(",").map((v) => Number(v.trim()) || 0);
      while (parts.length < 10) parts.push(0);
      return parts.slice(0, 10);
    }
    return presets.flat;
  }

  function apply(config) {
    const selected = config?.equalizer_preset || "flat";
    let gains = presets[selected];
    if (selected === "custom") {
      gains = parseCustomGains(config?.equalizer_custom_gains);
    }
    if (!gains) gains = presets.flat;
    runtime.audioEngine.setEqualizerGains(gains);
  }

  function stop() {
    runtime.audioEngine.setEqualizerGains(presets.flat);
  }

  runtime.equalizer = {
    presets,
    parseCustomGains,
    applyGains(gains) {
      return runtime.audioEngine?.setEqualizerGains(gains);
    },
  };

  runtime.register("equalizer", { start: apply, update: apply, stop });
})();

