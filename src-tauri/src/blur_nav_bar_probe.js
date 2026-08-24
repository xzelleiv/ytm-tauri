(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const STYLE_ID = "ytm-tauri-blur-nav-bar-style";
  const css = `
    ytmusic-player-bar {
      background: transparent !important;
    }

    #nav-bar-background,
    #player-bar-background,
    #layout #nav-bar-background,
    #layout #player-bar-background,
    #header.ytmusic-item-section-renderer {
      background: rgba(18, 18, 18, 0.65) !important;
      backdrop-filter: blur(24px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
    }

    ytmusic-tabs,
    ytmusic-tabs.stuck,
    #search-page #tabs.stuck {
      background: rgba(18, 18, 18, 0.65) !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
    }

    ytmusic-menu-popup-renderer {
      background: rgba(24, 24, 24, 0.8) !important;
      backdrop-filter: blur(24px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
      border-radius: 12px !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
    }

    #mini-guide-background,
    #guide #guide-wrapper {
      background: rgba(18, 18, 18, 0.4) !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
    }

    #nav-bar-divider {
      display: none !important;
    }
  `;

  function start() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      const target = document.head || document.documentElement || document.body;
      if (target) {
        target.appendChild(style);
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          const t = document.head || document.documentElement || document.body;
          if (t && !document.getElementById(STYLE_ID)) t.appendChild(style);
        }, { once: true });
      }
    }
  }

  function stop() {
    document.getElementById(STYLE_ID)?.remove();
  }

  runtime.register("blur_nav_bar", { start, stop });
})();
