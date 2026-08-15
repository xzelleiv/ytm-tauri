(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const STYLE_ID = "ytm-tauri-video-toggle-style";
  let observer = null;

  const css = `
    .ytm-audio-mode-forced #song-video.ytmusic-player {
      display: none !important;
    }
    .ytm-audio-mode-forced #song-image {
      display: block !important;
    }
    .ytm-audio-mode-forced ytmusic-player {
      margin: auto 0px !important;
    }
  `;

  function forceThumbnails() {
    const img = document.querySelector("#song-image #img.style-scope.yt-img-shadow");
    if (!img) return;
    const player = document.querySelector("#movie_player, ytmusic-player");
    const thumbnails = player?.getPlayerResponse?.()?.videoDetails?.thumbnail?.thumbnails;
    if (Array.isArray(thumbnails) && thumbnails.length) {
      const best = thumbnails[thumbnails.length - 1]?.url?.split("?")[0];
      if (best && img.src !== best) {
        img.src = best;
      }
    }
  }

  function start() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      const target = document.head || document.documentElement || document.body;
      if (target) target.appendChild(style);
    }
    document.body.classList.add("ytm-audio-mode-forced");
    forceThumbnails();

    observer = new MutationObserver(forceThumbnails);
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    document.body.classList.remove("ytm-audio-mode-forced");
    document.getElementById(STYLE_ID)?.remove();
  }

  runtime.register("video_toggle", { start, stop });
})();
