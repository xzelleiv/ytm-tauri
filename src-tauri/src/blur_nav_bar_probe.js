(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const STYLE_ID = "ytm-tauri-blur-nav-bar-style";
  const css = `
    #nav-bar-background,
    #header.ytmusic-item-section-renderer {
      background: rgba(10, 10, 10, 0.45) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
    }

    ytmusic-tabs {
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
    }

    ytmusic-tabs.stuck {
      background: rgba(10, 10, 10, 0.45) !important;
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
