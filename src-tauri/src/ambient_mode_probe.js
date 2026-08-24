(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const STYLE_ID = "ytm-tauri-ambient-mode-style";
  const BLUR_CLASS = "html5-blur-image";

  const css = `
    #song-video canvas.html5-blur-canvas,
    #song-image .html5-blur-image {
      filter: blur(100px);
      opacity: 1;
      width: 100%;
      height: 100%;
      pointer-events: none;
      position: absolute !important;
      left: 50% !important;
      top: 50% !important;
      transform: translate(-50%, -50%) !important;
      border-radius: 8px;
    }

    #song-image {
      position: relative !important;
    }

    #player:not([video-mode]):not(.video-mode):not([player-ui-state='MINIPLAYER']):not([is-mweb-modernization-enabled]) {
      width: 100%;
      margin: 0 auto !important;
      overflow: visible !important;
    }

    .song-button.ytmusic-av-toggle,
    .video-button.ytmusic-av-toggle {
      z-index: 1;
      background-color: transparent;
    }

    #side-panel.side-panel.ytmusic-player-page {
      z-index: 0;
    }
  `;

  let observer = null;
  let interval = null;
  let lastImageSource = null;
  let blurElement = null;

  function syncAmbient() {
    const layout = document.querySelector("#layout, ytmusic-app-layout");
    const isPageOpen = layout?.hasAttribute("player-page-open");
    const songImage = document.querySelector("#song-image");
    const image = songImage?.querySelector("yt-img-shadow > img");

    if (!isPageOpen || !songImage || !image || !image.src || image.src.startsWith("data:")) {
      if (blurElement) {
        blurElement.remove();
        blurElement = null;
        lastImageSource = null;
      }
      return;
    }

    if (blurElement && lastImageSource === image.src) return;

    if (!blurElement) {
      blurElement = document.createElement("img");
      blurElement.className = BLUR_CLASS;
      songImage.prepend(blurElement);
    }
    blurElement.src = image.src;
    lastImageSource = image.src;
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

    syncAmbient();
    observer?.disconnect();
    const playerPage = document.querySelector("#player-page") || document.documentElement;
    if (playerPage) {
      observer = new MutationObserver(syncAmbient);
      observer.observe(playerPage, { attributes: true, childList: true, subtree: true });
    }
    if (interval) clearInterval(interval);
    interval = setInterval(syncAmbient, 1000);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (interval) clearInterval(interval);
    interval = null;
    if (blurElement) {
      blurElement.remove();
      blurElement = null;
    }
    lastImageSource = null;
    document.getElementById(STYLE_ID)?.remove();
  }

  runtime.register("ambient_mode", { start, stop });
})();
