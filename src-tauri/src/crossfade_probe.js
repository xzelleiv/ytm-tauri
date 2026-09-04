(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let active = false;
  let boundMedia = null;
  let fadeAnimation = null;
  let nextTimer = null;
  let masterVolume = 1;
  let isFadingOut = false;
  let isFadingIn = false;
  let lastTrackUrl = "";
  let trackChangeFired = false;
  let nextTriggered = false;

  let crossfadeSeconds = 4.0;
  let crossfadeCurve = "equal-power";

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

  function cancelFader() {
    if (fadeAnimation) {
      clearInterval(fadeAnimation);
      fadeAnimation = null;
    }
    if (nextTimer) {
      if (typeof clearTimeout === "function") {
        clearTimeout(nextTimer);
      }
      nextTimer = null;
    }
  }

  function setGainOrVolume(targetFraction) {
    const clamped = Math.max(0, Math.min(1, targetFraction));
    if (runtime.audioEngine?.setFaderGain) {
      runtime.audioEngine.setFaderGain(clamped, 0);
    } else if (boundMedia) {
      boundMedia.volume = masterVolume * clamped;
    }
  }

  function restoreVolume() {
    cancelFader();
    isFadingOut = false;
    isFadingIn = false;
    nextTriggered = false;
    masterVolume = getTrueMasterVolume();
    if (runtime.audioEngine?.setFaderGain) {
      runtime.audioEngine.setFaderGain(1, 0);
    }
    if (boundMedia && !runtime.audioEngine?.setFaderGain) {
      boundMedia.volume = masterVolume;
    }
  }

  function computeCurve(progress, isFadeIn, curveType) {
    const t = Math.max(0, Math.min(1, progress));
    if (curveType === "linear") {
      return isFadeIn ? t : 1 - t;
    }
    if (curveType === "logarithmic") {
      return isFadeIn ? Math.pow(t, 2) : 1 - Math.sqrt(t);
    }
    // equal power curve
    return isFadeIn ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
  }

  function fadeOut() {
    if (!boundMedia) return;
    cancelFader();
    isFadingOut = true;
    isFadingIn = false;
    nextTriggered = false;
    masterVolume = getTrueMasterVolume();

    const durationMs = Math.max(1000, crossfadeSeconds * 1000);

    if (runtime.audioEngine?.setFaderGain) {
      runtime.audioEngine.setFaderGain(0, durationMs, crossfadeCurve);
    }

    // trigger next track
    const triggerDelay = Math.max(200, durationMs * 0.85);
    if (typeof setTimeout === "function") {
      nextTimer = setTimeout(() => {
        if (isFadingOut && !nextTriggered) {
          nextTriggered = true;
          triggerNextTrack();
        }
      }, triggerDelay);
    }

    const startTime = Date.now();
    const tick = () => {
      if (!boundMedia || boundMedia.paused || boundMedia.seeking || !active) {
        cancelFader();
        return;
      }
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / durationMs);

      // fallback volume ramp
      if (!runtime.audioEngine?.setFaderGain && boundMedia) {
        const fraction = computeCurve(progress, false, crossfadeCurve);
        boundMedia.volume = Math.max(0, masterVolume * fraction);
      }

      if (progress >= 1) {
        cancelFader();
        setGainOrVolume(0);
      }
    };

    fadeAnimation = setInterval(tick, 25);
  }

  function fadeIn(isNaturalTransition = false) {
    if (!boundMedia || !active) return;
    cancelFader();
    isFadingIn = true;
    isFadingOut = false;
    nextTriggered = false;
    masterVolume = getTrueMasterVolume();

    const durationMs = isNaturalTransition
      ? Math.max(800, (crossfadeSeconds * 1000) / 2)
      : 80;

    setGainOrVolume(0);

    if (runtime.audioEngine?.setFaderGain) {
      runtime.audioEngine.setFaderGain(1, durationMs, crossfadeCurve);
    }

    const startTime = Date.now();
    const tick = () => {
      if (!boundMedia || boundMedia.paused || boundMedia.seeking || !active) {
        cancelFader();
        isFadingIn = false;
        return;
      }
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / durationMs);

      // fallback volume ramp
      if (!runtime.audioEngine?.setFaderGain && boundMedia) {
        const fraction = computeCurve(progress, true, crossfadeCurve);
        boundMedia.volume = Math.min(masterVolume, masterVolume * fraction);
      }

      if (progress >= 1) {
        cancelFader();
        isFadingIn = false;
        setGainOrVolume(1);
      }
    };

    fadeAnimation = setInterval(tick, 25);
  }

  function triggerNextTrack() {
    const player = getPlayer();
    if (typeof player?.nextVideo === "function") {
      player.nextVideo();
      return;
    }
    const nextBtn = document.querySelector(".next-button, #movie_player .ytp-next-button");
    if (nextBtn) {
      nextBtn.click();
    }
  }

  function onTimeUpdate() {
    if (!active || !boundMedia || boundMedia.paused || boundMedia.seeking) return;

    if (!isFadingOut && !isFadingIn) {
      masterVolume = getTrueMasterVolume();
    }

    const current = boundMedia.currentTime;
    const duration = boundMedia.duration;

    if (!duration || duration <= crossfadeSeconds * 2) return;

    const remaining = duration - current;

    if (remaining <= crossfadeSeconds && !isFadingOut) {
      fadeOut();
    } else if (remaining > crossfadeSeconds + 1 && isFadingOut) {
      restoreVolume();
    }
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
      const wasFadingOut = isFadingOut || nextTriggered;
      trackChangeFired = true;
      nextTriggered = false;
      if (boundMedia && boundMedia.currentTime < 1.5) {
        fadeIn(wasFadingOut);
      }
    }
  }

  function onPlay() {
    if (!active || !boundMedia) return;
    if (boundMedia.currentTime < 2 && (trackChangeFired || isFadingOut)) {
      const wasFadingOut = isFadingOut;
      trackChangeFired = false;
      fadeIn(wasFadingOut);
    } else if (!isFadingIn && !isFadingOut) {
      masterVolume = getTrueMasterVolume();
      setGainOrVolume(1);
    }
  }

  function onPause() {
    restoreVolume();
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
        boundMedia.removeEventListener("pause", onPause);
        boundMedia.removeEventListener("seeking", onSeeking);
      }
      boundMedia = media;
      masterVolume = getTrueMasterVolume();
      boundMedia.addEventListener("timeupdate", onTimeUpdate);
      boundMedia.addEventListener("play", onPlay);
      boundMedia.addEventListener("pause", onPause);
      boundMedia.addEventListener("seeking", onSeeking);
    }
  }

  let pollTimer = null;
  let trackChangeListener = null;

  function updateConfig(config) {
    if (typeof config?.crossfade_seconds === "number" && config.crossfade_seconds > 0) {
      crossfadeSeconds = Math.max(1, Math.min(15, config.crossfade_seconds));
    }
    if (typeof config?.crossfade_curve === "string") {
      crossfadeCurve = config.crossfade_curve;
    }
  }

  function start(config) {
    active = true;
    updateConfig(config);
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
    cancelFader();
    if (trackChangeListener) {
      window.removeEventListener("ytm-track-change", trackChangeListener);
      trackChangeListener = null;
    }
    if (boundMedia) {
      boundMedia.removeEventListener("timeupdate", onTimeUpdate);
      boundMedia.removeEventListener("play", onPlay);
      boundMedia.removeEventListener("pause", onPause);
      boundMedia.removeEventListener("seeking", onSeeking);
      if (!runtime.audioEngine?.setFaderGain) {
        boundMedia.volume = getTrueMasterVolume();
      }
      boundMedia = null;
    }
    if (runtime.audioEngine?.setFaderGain) {
      runtime.audioEngine.setFaderGain(1, 0);
    }
    isFadingOut = false;
    isFadingIn = false;
    nextTriggered = false;
  }

  runtime.register("crossfade", { start, update: updateConfig, stop });
})();

