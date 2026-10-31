(() => {
  if (typeof location !== "object" || location.hostname !== "music.youtube.com") return;
  if (window.__ytmShortcutHelp) return;

  const OVERLAY_ID = "ytm-shortcut-help";
  const STYLE_ID = "ytm-shortcut-help-style";
  const DEFAULT_SHORTCUTS = [
    ["Ctrl+Alt+A", "Previous track"],
    ["Ctrl+Alt+S", "Play or pause"],
    ["Ctrl+Alt+D", "Next track"],
    ["Ctrl+R / F5", "Reload YouTube Music"],
    ["Ctrl+=", "Zoom in"],
    ["Ctrl+-", "Zoom out"],
    ["Ctrl+0", "Reset zoom"],
    ["Ctrl+Wheel", "Zoom with the mouse wheel"],
    ["Ctrl+Shift+Delete", "Reset the YouTube Music session"],
    ["F12", "Open developer tools"],
    ["Ctrl+Shift+I", "Open developer tools"],
    ["Ctrl+H", "Show keyboard shortcuts"],
  ];
  const shortcuts = new Map(DEFAULT_SHORTCUTS.map(([key, label]) => [key, { key, label }]));
  let overlay = null;
  let previousFocus = null;

  function isTextEntry(target) {
    const element = target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']");
    return !!element;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; background: rgba(0,0,0,.58); font: 14px system-ui,sans-serif; color: #fff; }
#${OVERLAY_ID} .ytm-shortcut-panel { width: min(520px, calc(100vw - 32px)); max-height: min(680px, calc(100vh - 32px)); overflow: auto; padding: 24px; border-radius: 16px; background: #242424; box-shadow: 0 18px 70px rgba(0,0,0,.55); }
#${OVERLAY_ID} h2 { margin: 0 0 16px; font-size: 20px; }
#${OVERLAY_ID} ul { display: grid; gap: 10px; list-style: none; padding: 0; margin: 0; }
#${OVERLAY_ID} li { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
#${OVERLAY_ID} kbd { padding: 3px 7px; border: 1px solid #666; border-bottom-width: 2px; border-radius: 5px; background: #171717; color: #eee; white-space: nowrap; }
#${OVERLAY_ID} button { margin-top: 20px; padding: 8px 14px; border: 0; border-radius: 8px; background: #fff; color: #161616; cursor: pointer; }
`;
    (document.head || document.documentElement || document.body)?.appendChild?.(style);
  }

  function hide() {
    if (!overlay) return;
    overlay.remove?.();
    overlay = null;
    const focus = previousFocus;
    previousFocus = null;
    focus?.focus?.();
  }

  function show() {
    if (overlay) return;
    installStyle();
    previousFocus = document.activeElement;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "presentation");
    const panel = document.createElement("section");
    panel.className = "ytm-shortcut-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", `${OVERLAY_ID}-title`);
    panel.addEventListener("click", (event) => event.stopPropagation());
    const title = document.createElement("h2");
    title.id = `${OVERLAY_ID}-title`;
    title.textContent = "Keyboard shortcuts";
    panel.appendChild(title);
    const list = document.createElement("ul");
    for (const { key, label } of shortcuts.values()) {
      const row = document.createElement("li");
      const description = document.createElement("span");
      description.textContent = label;
      const code = document.createElement("kbd");
      code.textContent = key;
      row.append(description, code);
      list.appendChild(row);
    }
    panel.appendChild(list);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", hide);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        close.focus();
      }
    });
    panel.appendChild(close);
    overlay.appendChild(panel);
    overlay.addEventListener("click", hide);
    (document.body || document.documentElement)?.appendChild?.(overlay);
    close.focus?.();
  }

  function toggle() {
    if (overlay) hide();
    else show();
  }

  function register(key, label) {
    const normalizedKey = String(key || "").trim();
    const normalizedLabel = String(label || "").trim();
    if (!normalizedKey || !normalizedLabel || normalizedKey.length > 40 || normalizedLabel.length > 120) {
      throw new Error("shortcut key and label are required");
    }
    shortcuts.set(normalizedKey, { key: normalizedKey, label: normalizedLabel });
    if (overlay) {
      hide();
      show();
    }
  }

  function appAction(event) {
    const code = String(event.code || "");
    const key = String(event.key || "").toLowerCase();
    const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
    if (key === "f12" && bare) return "open_devtools";
    if (key === "f5" && bare) return "reload";
    if (!event.ctrlKey || event.altKey || event.metaKey) return null;
    if (event.shiftKey) {
      if (key === "i") return "open_devtools";
      if (key === "delete") return "reset_session";
      if (key === "+" || code === "Equal") return "zoom_in";
      return null;
    }
    if (key === "r" || key === "f5") return "reload";
    if (key === "=" || key === "+" || code === "Equal" || code === "NumpadAdd") return "zoom_in";
    if (key === "-" || code === "Minus" || code === "NumpadSubtract") return "zoom_out";
    if (key === "0" || code === "Digit0" || code === "Numpad0") return "zoom_reset";
    return null;
  }

  const ZOOM_ACTIONS = new Set(["zoom_in", "zoom_out", "zoom_reset"]);

  function runAppAction(action) {
    window.__ytmFeatures?.triggerAction?.(action)?.catch?.(() => {});
  }

  const onAppShortcut = (event) => {
    const action = appAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && !ZOOM_ACTIONS.has(action)) return;
    runAppAction(action);
  };
  document.addEventListener("keydown", onAppShortcut, true);

  let wheelZoomAt = 0;
  const onWheel = (event) => {
    if (!event.ctrlKey || !event.deltaY) return;
    event.preventDefault();
    const now = Date.now();
    if (now - wheelZoomAt < 120) return;
    wheelZoomAt = now;
    runAppAction(event.deltaY < 0 ? "zoom_in" : "zoom_out");
  };
  window.addEventListener?.("wheel", onWheel, { capture: true, passive: false });

  const onKeyDown = (event) => {
    if (event.defaultPrevented || isTextEntry(event.target)) return;
    const key = String(event.key || "").toLowerCase();
    if (event.ctrlKey && !event.altKey && !event.shiftKey && key === "h") {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    } else if (event.key === "Escape" && overlay) {
      event.preventDefault();
      hide();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);

  window.__ytmShortcutHelp = {
    show,
    hide,
    toggle,
    register,
    list: () => Array.from(shortcuts.values()).map(({ key, label }) => ({ key, label })),
  };
})();
