(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let active = false;
  let boundMedia = null;
  let fadeTimer = null;
  let baseVolume = 1;
  let isFadingOut = false;

  const FADE_IN_DURATION = 1500;
  const FADE_OUT_DURATION = 3500;
  const SECONDS_BEFORE_END = 4;

  function onTimeUpdate() {
    if (!active || !boundMedia || boundMedia.paused || boundMedia.seeking) return;

    const current = boundMedia.currentTime;
    const duration = boundMedia.duration;

    if (!duration || duration <= 10) return;

    const remaining = duration - current;

    if (remaining <= SECONDS_BEFORE_END && !isFadingOut) {
      isFadingOut = true;
      fadeOut();
    }
  }

  function fadeOut() {
    if (!boundMedia) return;
    const startVol = boundMedia.volume;
    const startTime = Date.now();

    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = setInterval(() => {
      if (!boundMedia || boundMedia.paused || boundMedia.seeking) {
        clearInterval(fadeTimer);
        return;
      }
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / FADE_OUT_DURATION);
      boundMedia.volume = Math.max(0, startVol * (1 - progress));

      if (progress >= 1) {
        clearInterval(fadeTimer);
        fadeTimer = null;
      }
    }, 50);
  }

  function fadeIn() {
    if (!boundMedia) return;
    const targetVol = baseVolume;
    boundMedia.volume = 0;
    const startTime = Date.now();

    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = setInterval(() => {
      if (!boundMedia || boundMedia.paused || boundMedia.seeking) {
        clearInterval(fadeTimer);
        return;
      }
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / FADE_IN_DURATION);
      boundMedia.volume = Math.min(targetVol, targetVol * progress);

      if (progress >= 1) {
        boundMedia.volume = targetVol;
        clearInterval(fadeTimer);
        fadeTimer = null;
      }
    }, 50);
  }

  function onTrackStart() {
    isFadingOut = false;
    if (boundMedia) {
      baseVolume = boundMedia.volume || 1;
      fadeIn();
    }
  }

  function attachMedia() {
    const media = runtime.media();
    if (media && media !== boundMedia) {
      if (boundMedia) {
        boundMedia.removeEventListener("timeupdate", onTimeUpdate);
        boundMedia.removeEventListener("play", onTrackStart);
      }
      boundMedia = media;
      baseVolume = media.volume;
      boundMedia.addEventListener("timeupdate", onTimeUpdate);
      boundMedia.addEventListener("play", onTrackStart);
    }
  }

  function start() {
    active = true;
    attachMedia();
    setInterval(attachMedia, 1500);
  }

  function stop() {
    active = false;
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = null;
    if (boundMedia) {
      boundMedia.removeEventListener("timeupdate", onTimeUpdate);
      boundMedia.removeEventListener("play", onTrackStart);
      boundMedia.volume = baseVolume;
      boundMedia = null;
    }
  }

  runtime.register("crossfade", { start, stop });
})();
