(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime?.audioEngine) return;

  const presets = {
    "bass-booster": [{ type: "lowshelf", frequency: 80, Q: 100, gain: 12 }],
    flat: [],
  };

  function apply(config) {
    runtime.audioEngine.reconnectEqualizer(presets[config.equalizer_preset] || []);
  }

  function stop() {
    runtime.audioEngine.reconnectEqualizer([]);
  }

  runtime.register("equalizer", { start: apply, update: apply, stop });
})();
