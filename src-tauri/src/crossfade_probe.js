(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let active = false;
  let boundMedia = null;
  let fadeTimer = null;
  let masterVolume = 1;
  let isFadingOut = false;
  let isFadingIn = false;
  let lastTrackUrl = "";
  let trackChangeFired = false;

  const FADE_IN_DURATION = 1500;
  const FADE_OUT_DURATION = 3500;
  const SECONDS_BEFORE_END = 3.5;

  function getPlayer() {
    return document.querySelector("#movie_player");
  }

  function getTrueMasterVolume() {
    const player = getPlayer();
    if (typeof player?.getVolume === "function") {
      const vol = player.getVolume();
      if (typeof vol === "number" && !isNaN(vol) && vol > 0) {
        return Math.max(0.05, Math.min(1, vol / 100));
      }
    }
    return Math.max(0.05, Math.min(1, masterVolume));
  }

  function clearFadeTimer() {
    if (fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }

  function restoreVolume() {
    clearFadeTimer();
    isFadingOut = false;
    isFadingIn = false;
    if (boundMedia) {
      masterVolume = getTrueMasterVolume();
      boundMedia.volume = masterVolume;
    }
  }

  function onTimeUpdate() {
    if (!active || !boundMedia || boundMedia.paused || boundMedia.seeking) return;

    if (!isFadingOut && !isFadingIn) {
      masterVolume = getTrueMasterVolume();
    }

    const current = boundMedia.currentTime;
    const duration = boundMedia.duration;

    if (!duration || duration <= 10) return;

    const remaining = duration - current;

    if (remaining <= SECONDS_BEFORE_END && !isFadingOut) {
      isFadingOut = true;
      fadeOut();
    } else if (remaining > SECONDS_BEFORE_END && isFadingOut) {
      restoreVolume();
    }
  }

  function fadeOut() {
    if (!boundMedia) return;
    clearFadeTimer();
    const startVol = boundMedia.volume;
    const startTime = Date.now();

    fadeTimer = setInterval(() => {
      if (!boundMedia || boundMedia.paused || boundMedia.seeking || !active) {
        clearFadeTimer();
        return;
      }
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / FADE_OUT_DURATION);
      boundMedia.volume = Math.max(0, startVol * (1 - progress));

      if (progress >= 1) {
        clearFadeTimer();
      }
    }, 50);
  }

  function fadeIn() {
    if (!boundMedia || !active) return;
    clearFadeTimer();
    isFadingIn = true;
    isFadingOut = false;
    masterVolume = getTrueMasterVolume();
    const targetVol = masterVolume;
    boundMedia.volume = 0;
    const startTime = Date.now();

    fadeTimer = setInterval(() => {
      if (!boundMedia || boundMedia.paused || boundMedia.seeking || !active) {
        clearFadeTimer();
        isFadingIn = false;
        return;
      }
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / FADE_IN_DURATION);
      boundMedia.volume = Math.min(targetVol, targetVol * progress);

      if (progress >= 1) {
        boundMedia.volume = targetVol;
        isFadingIn = false;
        clearFadeTimer();
      }
    }, 50);
  }

  function extractTrackId(detail) {
    if (!detail) return null;
    if (detail.videoId) return detail.videoId;
    if (detail.title && detail.author) return `${detail.title}::${detail.author}`;
    if (detail.title) return detail.title;
    return null;
  }

  function onTrackChange(detail) {
    if (!active) return;
    const id = extractTrackId(detail);
    if (!id) return;
    if (id !== lastTrackUrl) {
      lastTrackUrl = id;
      trackChangeFired = true;
      if (boundMedia && boundMedia.currentTime < 1.5) {
        fadeIn();
      }
    }
  }

  function onPlay() {
    if (!active || !boundMedia) return;
    if (boundMedia.currentTime < 2 && (trackChangeFired || isFadingOut)) {
      trackChangeFired = false;
      fadeIn();
    } else if (!isFadingIn && !isFadingOut) {
      masterVolume = getTrueMasterVolume();
      boundMedia.volume = masterVolume;
    }
  }

  function onSeeking() {
    restoreVolume();
  }

  function attachMedia() {
    const media = runtime.media();
    if (media && media !== boundMedia) {
      if (boundMedia) {
        boundMedia.removeEventListener("timeupdate", onTimeUpdate);
        boundMedia.removeEventListener("play", onPlay);
        boundMedia.removeEventListener("seeking", onSeeking);
      }
      boundMedia = media;
      masterVolume = getTrueMasterVolume();
      boundMedia.addEventListener("timeupdate", onTimeUpdate);
      boundMedia.addEventListener("play", onPlay);
      boundMedia.addEventListener("seeking", onSeeking);
    }
  }

  let pollTimer = null;
  let trackChangeListener = null;

  function start() {
    active = true;
    masterVolume = getTrueMasterVolume();
    attachMedia();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(attachMedia, 1500);

    trackChangeListener = (e) => onTrackChange(e.detail);
    window.addEventListener("ytm-track-change", trackChangeListener);
  }

  function stop() {
    active = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    clearFadeTimer();
    if (trackChangeListener) {
      window.removeEventListener("ytm-track-change", trackChangeListener);
      trackChangeListener = null;
    }
    if (boundMedia) {
      boundMedia.removeEventListener("timeupdate", onTimeUpdate);
      boundMedia.removeEventListener("play", onPlay);
      boundMedia.removeEventListener("seeking", onSeeking);
      boundMedia.volume = getTrueMasterVolume();
      boundMedia = null;
    }
    isFadingOut = false;
    isFadingIn = false;
  }

  runtime.register("crossfade", { start, stop });
})();
