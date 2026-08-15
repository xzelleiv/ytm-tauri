(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let active = false;

  function onVideoEnded() {
    if (!active) return;
    const player = document.querySelector("#movie_player, .html5-video-player, ytmusic-player");
    if (typeof player?.pauseVideo === "function") {
      player.pauseVideo();
    }
  }

  function start() {
    active = true;
    const media = runtime.media();
    if (media) media.addEventListener("ended", onVideoEnded);
  }

  function stop() {
    active = false;
    const media = runtime.media();
    if (media) media.removeEventListener("ended", onVideoEnded);
  }

  runtime.register("disable_autoplay", { start, stop });
})();
