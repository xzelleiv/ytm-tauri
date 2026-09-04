(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime || runtime.audioEngine) return;

  const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  let context = null;
  let media = null;
  let source = null;
  let eqFilters = [];
  let limiter = null;
  let faderGain = null;

  function buildGraph() {
    eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
      const filter = context.createBiquadFilter();
      filter.frequency.value = freq;
      filter.gain.value = 0;
      if (idx === 0) {
        filter.type = "lowshelf";
      } else if (idx === EQ_FREQUENCIES.length - 1) {
        filter.type = "highshelf";
      } else {
        filter.type = "peaking";
        filter.Q.value = 1.4142;
      }
      return filter;
    });

    limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -0.5;
    limiter.knee.value = 3;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    faderGain = context.createGain();
    faderGain.gain.value = 1;

    let node = source;
    for (const filter of eqFilters) {
      node.connect(filter);
      node = filter;
    }
    node.connect(limiter);
    limiter.connect(faderGain);
    faderGain.connect(context.destination);
  }

  function ensure() {
    const current = runtime.media();
    if (!current) return null;

    if (!context) {
      context = new AudioContext();
      if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener(
          "click",
          () => {
            if (context?.state === "suspended") context.resume();
          },
          { once: true, passive: true },
        );
      }
    }

    if (media === current && source) {
      return { context, media, source, faderGain, eqFilters, limiter };
    }

    // handle media switch
    if (source && media !== current) {
      try {
        source.disconnect();
      } catch {}
      source = null;
    }

    media = current;
    if (!media.__ytmMediaSource) {
      media.__ytmMediaSource = context.createMediaElementSource(media);
    }
    source = media.__ytmMediaSource;

    if (!eqFilters.length) {
      buildGraph();
    } else {
      source.connect(eqFilters[0]);
    }

    media.addEventListener(
      "play",
      () => {
        if (context?.state === "suspended") context.resume();
      },
      { passive: true },
    );
    if (!media.paused && context?.state === "suspended") context.resume();
    return { context, media, source, faderGain, eqFilters, limiter };
  }

  function setEqualizerGains(gains) {
    const engine = ensure();
    if (!engine || !eqFilters.length) return false;
    const now = context.currentTime;
    const list = Array.isArray(gains) ? gains : [];
    eqFilters.forEach((filter, idx) => {
      const val = typeof list[idx] === "number" ? Math.max(-12, Math.min(12, list[idx])) : 0;
      filter.gain.setTargetAtTime(val, now, 0.015);
    });
    return true;
  }

  function reconnectEqualizer(configs) {
    const engine = ensure();
    if (!engine) return false;
    if (!configs || configs.length === 0) {
      return setEqualizerGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
    const gains = new Array(EQ_FREQUENCIES.length).fill(0);
    configs.forEach((cfg) => {
      let closest = 0;
      let minDiff = Infinity;
      EQ_FREQUENCIES.forEach((freq, idx) => {
        const diff = Math.abs(freq - (cfg.frequency || 0));
        if (diff < minDiff) {
          minDiff = diff;
          closest = idx;
        }
      });
      gains[closest] = cfg.gain || 0;
    });
    return setEqualizerGains(gains);
  }

  function setFaderGain(target, durationMs, curveType = "equal-power") {
    const engine = ensure();
    if (!engine || !faderGain) return false;
    const now = context.currentTime;
    const clampedTarget = Math.max(0, Math.min(1, target));

    faderGain.gain.cancelScheduledValues(now);

    if (!durationMs || durationMs <= 0) {
      faderGain.gain.setValueAtTime(clampedTarget, now);
      return true;
    }

    const durationSec = durationMs / 1000;
    const currentVal = faderGain.gain.value;
    const steps = 64;
    const curve = new Float32Array(steps);

    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      if (curveType === "linear") {
        curve[i] = currentVal + (clampedTarget - currentVal) * t;
      } else if (curveType === "logarithmic") {
        if (clampedTarget > currentVal) {
          const norm = Math.pow(t, 2);
          curve[i] = currentVal + (clampedTarget - currentVal) * norm;
        } else {
          const norm = 1 - Math.pow(1 - t, 0.5);
          curve[i] = currentVal + (clampedTarget - currentVal) * norm;
        }
      } else {
        // equal power curve
        if (clampedTarget > currentVal) {
          const factor = Math.sin((t * Math.PI) / 2);
          curve[i] = currentVal + (clampedTarget - currentVal) * factor;
        } else {
          const factor = Math.cos((t * Math.PI) / 2);
          curve[i] = clampedTarget + (currentVal - clampedTarget) * factor;
        }
      }
    }

    faderGain.gain.setValueCurveAtTime(curve, now, durationSec);
    return true;
  }

  function getFaderGain() {
    return faderGain ? faderGain.gain.value : 1;
  }

  function setOutput(sinkId) {
    const engine = ensure();
    if (!engine || typeof context.setSinkId !== "function") return Promise.resolve(false);
    return context.setSinkId(sinkId || "default").then(() => true, () => false);
  }

  function devices() {
    return navigator.mediaDevices?.enumerateDevices?.().then((items) =>
      items.filter((item) => item.kind === "audiooutput").map((item) => ({
        id: item.deviceId,
        label: item.label || item.deviceId || "Audio output",
      })),
    ) || Promise.resolve([]);
  }

  runtime.audioEngine = {
    ensure,
    reconnectEqualizer,
    setEqualizerGains,
    setFaderGain,
    getFaderGain,
    setOutput,
    devices,
    EQ_FREQUENCIES,
  };
})();

