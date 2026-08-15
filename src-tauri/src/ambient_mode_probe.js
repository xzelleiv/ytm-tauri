(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const STYLE_ID = "ytm-tauri-ambient-mode-style";
  const BLUR_IMG_ID = "ytm-tauri-ambient-blur-image";

  const css = `
    #song-image .ytm-ambient-glow {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 105%;
      height: 105%;
      filter: blur(80px);
      opacity: 0.8;
      pointer-events: none;
      z-index: 0;
      transition: opacity 0.5s ease;
      border-radius: 12px;
    }

    #player:not([player-ui-state='MINIPLAYER']) {
      overflow: visible !important;
    }

    #song-image {
      overflow: visible !important;
      position: relative !important;
    }

    #song-image > yt-img-shadow {
      position: relative;
      z-index: 1;
    }
  `;

  let observer = null;

  function syncAmbientArt() {
    const songImage = document.querySelector("#song-image");
    if (!songImage) return;

    const sourceImg = songImage.querySelector("yt-img-shadow > img");
    if (!sourceImg || !sourceImg.src || sourceImg.src.startsWith("data:")) return;

    let blurImg = document.getElementById(BLUR_IMG_ID);
    if (!blurImg) {
      blurImg = document.createElement("img");
      blurImg.id = BLUR_IMG_ID;
      blurImg.className = "ytm-ambient-glow";
      songImage.prepend(blurImg);
    }

    if (blurImg.src !== sourceImg.src) {
      blurImg.src = sourceImg.src;
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

    syncAmbientArt();
    observer = new MutationObserver(syncAmbientArt);
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    document.getElementById(BLUR_IMG_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  }

  runtime.register("ambient_mode", { start, stop });
})();
