(() => {
  if (typeof location === "object" && location.hostname && location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytmUi) return;

  const STYLE_ID = "ytm-ui-theme";
  const TOAST_HOST_ID = "ytm-ui-toasts";
  const MAX_TOASTS = 3;

  const STYLES = `
:root {
  --ytmx-accent: #ff3b5c;
  --ytmx-accent-strong: #ff1f47;
  --ytmx-accent-soft: rgba(255, 59, 92, 0.14);
  --ytmx-accent-ring: rgba(255, 59, 92, 0.55);
  --ytmx-success: #3ddc84;
  --ytmx-warning: #f9ab00;
  --ytmx-danger: #ff6b6b;
  --ytmx-bg: #121212;
  --ytmx-surface: #1b1b1d;
  --ytmx-surface-2: #242427;
  --ytmx-surface-3: #2e2e32;
  --ytmx-border: rgba(255, 255, 255, 0.1);
  --ytmx-border-strong: rgba(255, 255, 255, 0.18);
  --ytmx-text: #f3f3f5;
  --ytmx-text-2: rgba(255, 255, 255, 0.68);
  --ytmx-text-3: rgba(255, 255, 255, 0.45);
  --ytmx-radius-sm: 6px;
  --ytmx-radius: 10px;
  --ytmx-radius-lg: 16px;
  --ytmx-shadow: 0 24px 72px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.35);
  --ytmx-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ytmx-font: Roboto, "Segoe UI", system-ui, sans-serif;
}
@keyframes ytmx-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ytmx-pop-in { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes ytmx-toast-in { from { opacity: 0; transform: translateY(12px) scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes ytmx-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@keyframes ytmx-spin { to { transform: rotate(360deg); } }
.ytmx-skeleton {
  display: block;
  border-radius: var(--ytmx-radius-sm);
  background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.11) 37%, rgba(255,255,255,0.05) 63%);
  background-size: 400% 100%;
  animation: ytmx-shimmer 1.4s ease infinite;
}
.ytmx-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255,255,255,0.25);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: ytmx-spin 0.8s linear infinite;
  vertical-align: -2px;
}
#${TOAST_HOST_ID} {
  position: fixed;
  left: 50%;
  bottom: 96px;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateX(-50%);
  pointer-events: none;
}
#${TOAST_HOST_ID} .ytmx-toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 10px 16px;
  border: 1px solid var(--ytmx-border-strong);
  border-radius: 999px;
  background: rgba(30, 30, 33, 0.94);
  backdrop-filter: blur(14px);
  box-shadow: 0 10px 32px rgba(0,0,0,0.5);
  color: var(--ytmx-text);
  font: 500 13px/1.35 var(--ytmx-font);
  animation: ytmx-toast-in 0.22s var(--ytmx-ease);
  transition: opacity 0.2s ease, transform 0.2s ease;
}
#${TOAST_HOST_ID} .ytmx-toast::before {
  content: "";
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--ytmx-text-3);
}
#${TOAST_HOST_ID} .ytmx-toast[data-kind=success]::before { background: var(--ytmx-success); }
#${TOAST_HOST_ID} .ytmx-toast[data-kind=error]::before { background: var(--ytmx-danger); }
#${TOAST_HOST_ID} .ytmx-toast[data-kind=info]::before { background: var(--ytmx-accent); }
#${TOAST_HOST_ID} .ytmx-toast.leaving { opacity: 0; transform: translateY(6px) scale(0.98); }
@media (prefers-reduced-motion: reduce) {
  .ytmx-skeleton, .ytmx-spinner, #${TOAST_HOST_ID} .ytmx-toast { animation: none !important; transition: none !important; }
}
`;

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return true;
    const target = document.head || document.documentElement;
    if (!target) return false;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLES;
    target.appendChild(style);
    return true;
  }

  function toastHost() {
    let host = document.getElementById(TOAST_HOST_ID);
    if (host) return host;
    if (!document.body) return null;
    host = document.createElement("div");
    host.id = TOAST_HOST_ID;
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }

  function dismiss(toastEl) {
    if (!toastEl || toastEl.classList.contains("leaving")) return;
    toastEl.classList.add("leaving");
    setTimeout(() => toastEl.remove(), 200);
  }

  // single-key toast reuse
  function toast(message, options = {}) {
    const text = String(message || "").trim();
    if (!text) return null;
    installStyle();
    const host = toastHost();
    if (!host) return null;
    const key = options.key ? String(options.key) : "";
    let toastEl = key ? host.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "ytmx-toast";
      if (key) toastEl.dataset.key = key;
      host.appendChild(toastEl);
      while (host.children.length > MAX_TOASTS) host.firstElementChild?.remove();
    } else {
      toastEl.classList.remove("leaving");
    }
    toastEl.dataset.kind = options.kind || "info";
    toastEl.textContent = text;
    clearTimeout(toastEl.__timer);
    toastEl.__timer = setTimeout(() => dismiss(toastEl), Math.max(1200, Number(options.duration) || 2600));
    return toastEl;
  }

  function skeletonRows(count, className = "") {
    return Array.from({ length: count }, () => `<div class="ytmx-skeleton-row ${className}"><span class="ytmx-skeleton" style="width:40px;height:40px"></span><span style="flex:1;display:grid;gap:6px"><span class="ytmx-skeleton" style="width:46%;height:12px"></span><span class="ytmx-skeleton" style="width:28%;height:10px"></span></span></div>`).join("");
  }

  if (!installStyle()) {
    document.addEventListener("DOMContentLoaded", installStyle, { once: true });
  }

  window.__ytmUi = { toast, dismiss, skeletonRows, installStyle };
})();
