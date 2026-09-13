(() => {
  if (typeof location !== "object" || location.hostname !== "music.youtube.com") return;
  if (window.__ytmShortcutHelp) return;

  const OVERLAY_ID = "ytm-shortcut-help";
  const STYLE_ID = "ytm-shortcut-help-style";
  const DEFAULT_SHORTCUTS = [
    ["Ctrl+Alt+A", "Previous track"],
    ["Ctrl+Alt+S", "Play or pause"],
    ["Ctrl+Alt+D", "Next track"],
    ["Ctrl+R", "Reload YouTube Music"],
    ["Ctrl+=", "Zoom in"],
    ["Ctrl+-", "Zoom out"],
    ["Ctrl+0", "Reset zoom"],
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
