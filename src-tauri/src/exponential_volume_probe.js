(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime || location.origin !== "https://music.youtube.com") return;

  const exponent = 3;
  const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
  const stored = new WeakMap();
  let activeMedia = null;
  let installed = false;

  function start() {
    if (installed || !original?.get || !original?.set) return;
    activeMedia = runtime.media();
    const initial = activeMedia ? original.get.call(activeMedia) : null;

    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      configurable: original.configurable,
      enumerable: original.enumerable,
      get() {
        const low = Number(original.get.call(this)) || 0;
        const calculated = low ** (1 / exponent);
        const remembered = stored.get(this);
        return typeof remembered === "number" && Math.abs(remembered - calculated) < 0.01
          ? remembered
          : calculated;
      },
      set(value) {
        const normalized = Math.max(0, Math.min(1, Number(value) || 0));
        stored.set(this, normalized);
        original.set.call(this, normalized ** exponent);
      },
    });
    installed = true;
    if (activeMedia && typeof initial === "number") activeMedia.volume = initial;
  }

  function stop() {
    if (!installed) return;
    const media = runtime.media() || activeMedia;
    const apparent = media ? media.volume : null;
    Object.defineProperty(HTMLMediaElement.prototype, "volume", original);
    installed = false;
    if (media && typeof apparent === "number") original.set.call(media, apparent);
    activeMedia = null;
  }

  runtime.register("exponential_volume", { start, stop });
})();
