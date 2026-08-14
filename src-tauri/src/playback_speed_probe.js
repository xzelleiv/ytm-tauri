(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime || location.origin !== "https://music.youtube.com") return;

  const MIN = 0.07;
  const MAX = 16;
  const STORAGE_KEY = "ytm-tauri-playback-rate";
  const container = document.createElement("div");
  container.id = "ytm-tauri-playback-speed";
  let speed = 1;
  let observer = null;
  let rateHandler = null;

  function clamp(value) {
    return Math.min(MAX, Math.max(MIN, Number.isFinite(value) ? value : 1));
  }

  function setSpeed(value) {
    speed = Math.round(clamp(value) * 100) / 100;
    localStorage.setItem(STORAGE_KEY, String(speed));
    const media = runtime.media();
    if (media && media.playbackRate !== speed) media.playbackRate = speed;
    updateLabel();
  }

  function updateLabel() {
    const label = container.querySelector("[data-speed-label]");
    const input = container.querySelector("input");
    if (label) label.textContent = `${speed.toFixed(2)}×`;
    if (input && Number(input.value) !== speed) input.value = String(speed);
  }

  function buildControl() {
    container.innerHTML = "";
    container.style.cssText = "padding:10px 16px 12px;color:var(--ytmusic-text-primary,#fff);font:500 14px Segoe UI,sans-serif;min-width:260px;box-sizing:border-box";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:7px";
    const title = document.createElement("span");
    title.textContent = "Playback speed";
    const label = document.createElement("span");
    label.dataset.speedLabel = "";
    row.append(title, label);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(MIN);
    input.max = String(MAX);
    input.step = "0.01";
    input.style.cssText = "width:100%;accent-color:#fff";
    input.addEventListener("input", () => setSpeed(Number(input.value)));
    input.addEventListener("wheel", (event) => {
      event.preventDefault();
      setSpeed(speed + (event.deltaY < 0 ? 0.01 : -0.01));
    }, { passive: false });
    container.append(row, input);
    updateLabel();
  }

  function playerMenu() {
    const popup = document.querySelector("ytmusic-popup-container");
    if (!popup) return null;
    const candidates = [...popup.querySelectorAll("tp-yt-paper-listbox, ytmusic-menu-popup-renderer")];
    return candidates.find((node) => node.offsetParent !== null) || null;
  }

  function attach() {
    const menu = playerMenu();
    if (menu && !menu.contains(container)) menu.prepend(container);
    forceRate();
  }

  function forceRate() {
    const media = runtime.media();
    if (media && media.playbackRate !== speed) media.playbackRate = speed;
  }

  function start(config) {
    speed = clamp(Number(localStorage.getItem(STORAGE_KEY)) || Number(config.playback_rate) || 1);
    buildControl();
    const popup = document.querySelector("ytmusic-popup-container") || document.documentElement;
    observer = new MutationObserver(attach);
    observer.observe(popup, { childList: true, subtree: true });
    rateHandler = forceRate;
    runtime.media()?.addEventListener("ratechange", rateHandler);
    attach();
  }

  function update(config) {
    if (!localStorage.getItem(STORAGE_KEY)) setSpeed(Number(config.playback_rate) || 1);
    else forceRate();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (rateHandler) runtime.media()?.removeEventListener("ratechange", rateHandler);
    rateHandler = null;
    container.remove();
    const media = runtime.media();
    if (media) media.playbackRate = 1;
  }

  runtime.playbackSpeed = { get: () => speed, set: setSpeed };
  runtime.register("playback_speed", { start, update, stop });
})();
