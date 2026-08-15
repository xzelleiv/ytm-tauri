(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let handler = null;
  let hudTimer = 0;

  function currentVolume() {
    const player = document.querySelector("#movie_player");
    if (typeof player?.getVolume === "function") return Number(player.getVolume()) || 0;
    return Math.round((runtime.media()?.volume || 0) * 100);
  }

  function setVolume(value) {
    const volume = Math.max(0, Math.min(100, value));
    const player = document.querySelector("#movie_player");
    const bar = document.querySelector("ytmusic-player-bar");
    if (typeof player?.setVolume === "function") player.setVolume(volume);
    else if (typeof bar?.updateVolume === "function") bar.updateVolume(volume);
    else if (runtime.media()) runtime.media().volume = volume / 100;
    showHud(volume);
  }

  function showHud(volume) {
    let hud = document.getElementById("ytm-tauri-volume-hud");
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "ytm-tauri-volume-hud";
      hud.style.cssText = "position:fixed;left:50%;bottom:100px;z-index:2147483645;transform:translateX(-50%);padding:9px 14px;border-radius:20px;background:rgba(20,20,20,.88);color:white;font:600 13px Segoe UI,sans-serif;pointer-events:none;transition:opacity .18s";
      const target = document.body || document.documentElement;
      if (target) target.appendChild(hud);
    }
    hud.textContent = `Volume ${Math.round(volume)}%`;
    hud.style.opacity = "1";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      hud.style.opacity = "0";
    }, 900);
  }

  function start() {
    handler = (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "")) return;
      event.preventDefault();
      const step = Math.max(0.1, Math.min(100, Number(runtime.config.volume_step) || 1));
      setVolume(currentVolume() + (event.key === "ArrowUp" ? step : -step));
    };
    document.addEventListener("keydown", handler, true);
  }

  function stop() {
    if (handler) document.removeEventListener("keydown", handler, true);
    handler = null;
    document.getElementById("ytm-tauri-volume-hud")?.remove();
  }

  runtime.preciseVolume = { get: currentVolume, set: setVolume };
  runtime.register("precise_volume", { start, stop });
})();
