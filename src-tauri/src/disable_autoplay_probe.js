(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let active = false;
  let boundMedia = null;
  let mediaPollTimer = null;

  function onVideoEnded() {
    if (!active) return;
    const player = document.querySelector("#movie_player, .html5-video-player, ytmusic-player");
    if (typeof player?.pauseVideo === "function") {
      player.pauseVideo();
    }
  }

  function start() {
    active = true;
    bindMedia();
    if (mediaPollTimer) clearInterval(mediaPollTimer);
    mediaPollTimer = setInterval(bindMedia, 1000);
  }

  function stop() {
    active = false;
    if (mediaPollTimer) clearInterval(mediaPollTimer);
    mediaPollTimer = null;
    if (boundMedia) boundMedia.removeEventListener("ended", onVideoEnded);
    boundMedia = null;
  }

  function bindMedia() {
    const media = runtime.media();
    if (media === boundMedia) return;
    if (boundMedia) boundMedia.removeEventListener("ended", onVideoEnded);
    boundMedia = media || null;
    if (boundMedia) boundMedia.addEventListener("ended", onVideoEnded);
  }

  runtime.register("disable_autoplay", { start, stop });
})();
