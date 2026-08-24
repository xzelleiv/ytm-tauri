(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime?.audioEngine) return;

  const presets = {
    "bass-booster": [
      { type: "lowshelf", frequency: 80, Q: 0.7, gain: 10 },
      { type: "peaking", frequency: 250, Q: 1.0, gain: 4 },
    ],
    "vocal-booster": [
      { type: "highpass", frequency: 120, Q: 0.7, gain: 0 },
      { type: "peaking", frequency: 3000, Q: 1.0, gain: 6 },
      { type: "highshelf", frequency: 8000, Q: 0.7, gain: 3 },
    ],
    rock: [
      { type: "lowshelf", frequency: 100, Q: 0.7, gain: 6 },
      { type: "peaking", frequency: 1000, Q: 1.0, gain: -2 },
      { type: "highshelf", frequency: 4000, Q: 0.7, gain: 5 },
    ],
    electronic: [
      { type: "lowshelf", frequency: 60, Q: 0.7, gain: 8 },
      { type: "peaking", frequency: 500, Q: 1.0, gain: -2 },
      { type: "highshelf", frequency: 10000, Q: 0.7, gain: 6 },
    ],
    acoustic: [
      { type: "lowshelf", frequency: 120, Q: 0.7, gain: 4 },
      { type: "peaking", frequency: 2500, Q: 1.0, gain: 3 },
      { type: "highshelf", frequency: 12000, Q: 0.7, gain: 4 },
    ],
    flat: [],
  };

  function apply(config) {
    const selected = config?.equalizer_preset || "flat";
    runtime.audioEngine.reconnectEqualizer(presets[selected] || []);
  }

  function stop() {
    runtime.audioEngine.reconnectEqualizer([]);
  }

  runtime.register("equalizer", { start: apply, update: apply, stop });
})();
