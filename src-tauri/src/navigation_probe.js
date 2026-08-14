(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime || location.origin !== "https://music.youtube.com") return;

  let container = null;
  let timer = 0;

  function iconButton(label, glyph, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.textContent = glyph;
    button.style.cssText = "width:40px;height:40px;border:0;border-radius:20px;background:transparent;color:var(--ytmusic-text-primary,#fff);font:300 32px/36px Segoe UI,sans-serif;cursor:pointer";
    button.addEventListener("mouseenter", () => { button.style.background = "rgba(255,255,255,.1)"; });
    button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
    button.addEventListener("click", handler);
    return button;
  }

  function attach() {
    const target = document.querySelector("#right-content");
    if (!target) {
      timer = window.setTimeout(attach, 250);
      return;
    }
    if (!container) {
      container = document.createElement("div");
      container.id = "ytm-tauri-navigation";
      container.style.cssText = "display:flex;align-items:center";
      container.append(
        iconButton("Back", "‹", () => history.back()),
        iconButton("Forward", "›", () => history.forward()),
      );
    }
    if (!target.contains(container)) target.prepend(container);
  }

  function stop() {
    window.clearTimeout(timer);
    timer = 0;
    container?.remove();
  }

  runtime.register("navigation_controls", { start: attach, stop });
})();
