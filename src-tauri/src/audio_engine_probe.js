(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime || runtime.audioEngine) return;

  let context = null;
  let media = null;
  let source = null;
  let filters = [];

  function ensure() {
    const current = runtime.media();
    if (!current) return null;
    if (media === current && context && source) return { context, media, source };
    if (source) return null;

    context = new AudioContext();
    media = current;
    source = context.createMediaElementSource(media);
    source.connect(context.destination);
    media.addEventListener("play", () => context?.resume(), { passive: true });
    if (!media.paused) context.resume();
    return { context, media, source };
  }

  function reconnectEqualizer(configs) {
    const engine = ensure();
    if (!engine) return false;
    for (const filter of filters) filter.disconnect();
    filters = [];
    source.disconnect();

    let previous = source;
    for (const item of configs || []) {
      const filter = context.createBiquadFilter();
      filter.type = item.type;
      filter.frequency.value = item.frequency;
      filter.Q.value = item.Q;
      filter.gain.value = item.gain;
      previous.connect(filter);
      previous = filter;
      filters.push(filter);
    }
    previous.connect(context.destination);
    return true;
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
    setOutput,
    devices,
  };
})();
