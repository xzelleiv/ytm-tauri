(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let active = false;
  let audioContext = null;
  let analyser = null;
  let sourceNode = null;
  let boundMedia = null;
  let pollTimer = null;
  let isSilent = true;
  let hasAudioStarted = false;

  const THRESHOLD = -90;

  function getMaxVolume(analyserNode, bins) {
    let max = -Infinity;
    analyserNode.getFloatFrequencyData(bins);
    for (let i = 4; i < bins.length; i++) {
      if (bins[i] > max && bins[i] < 0) max = bins[i];
    }
    return max;
  }

  function checkSilence() {
    if (!active || !boundMedia || !analyser || boundMedia.paused || boundMedia.seeking || boundMedia.ended) return;
    const bins = new Float32Array(analyser.frequencyBinCount);
    const vol = getMaxVolume(analyser, bins);

    if (vol > THRESHOLD) {
      isSilent = false;
      hasAudioStarted = true;
    } else {
      if (!hasAudioStarted && boundMedia.currentTime < 10) {
        /* skip silence */
        boundMedia.currentTime = Math.min(boundMedia.duration || 10, boundMedia.currentTime + 0.15);
      }
    }
  }

  function setupAudio() {
    const media = runtime.media();
    if (!media) return;
    if (boundMedia !== media) {
      boundMedia = media;
      hasAudioStarted = false;
      isSilent = true;

      media.addEventListener("emptied", () => {
        hasAudioStarted = false;
        isSilent = true;
      });
    }

    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioContext = new AudioCtx();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.1;
        try {
          sourceNode = audioContext.createMediaElementSource(media);
          sourceNode.connect(analyser);
          analyser.connect(audioContext.destination);
        } catch {
          /* source hooked */
        }
      }
    }
  }

  function start() {
    active = true;
    setupAudio();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      setupAudio();
      checkSilence();
    }, 25);
  }

  function stop() {
    active = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    boundMedia = null;
  }

  runtime.register("skip_silences", { start, stop });
})();
