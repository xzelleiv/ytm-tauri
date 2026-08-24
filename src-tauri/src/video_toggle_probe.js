(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const STYLE_ID = "ytm-tauri-video-toggle-style";
  const CLASS_NAME = "video-toggle-force-hide";

  const css = `
    .video-toggle-force-hide #main-panel {
      display: none !important;
    }
    .video-toggle-force-hide .side-panel.ytmusic-player-page {
      max-width: 100% !important;
      width: 100% !important;
      margin: 0 !important;
    }
  `;

  function start() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      const target = document.head || document.documentElement || document.body;
      if (target) target.appendChild(style);
    }
    if (document.body) document.body.classList.add(CLASS_NAME);
  }

  function stop() {
    document.body?.classList.remove(CLASS_NAME);
    document.getElementById(STYLE_ID)?.remove();
  }

  runtime.register("video_toggle", { start, stop });
})();
