(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const COLOR_KEY = "--ytmusic-album-color";
  const DARK_KEY = "--ytmusic-album-color-dark";
  const RATIO_KEY = "--ytmusic-album-color-ratio";
  const original = new Map();
  let observer = null;
  let lastArtwork = "";

  const variables = {
    "--ytmusic-color-black1": "#212121",
    "--ytmusic-color-black2": "#181818",
    "--ytmusic-color-black3": "#030303",
    "--ytmusic-color-black4": "#030303",
    "--ytmusic-color-blackpure": "#000",
    "--dark-theme-background-color": "#212121",
    "--yt-spec-base-background": "#0f0f0f",
    "--yt-spec-raised-background": "#212121",
    "--yt-spec-menu-background": "#282828",
    "--yt-spec-static-brand-black": "#212121",
    "--yt-spec-static-overlay-background-solid": "#000",
    "--yt-spec-static-overlay-background-heavy": "rgba(0,0,0,.8)",
    "--yt-spec-static-overlay-background-medium": "rgba(0,0,0,.6)",
    "--yt-spec-static-overlay-background-medium-light": "rgba(0,0,0,.3)",
    "--yt-spec-static-overlay-background-light": "rgba(0,0,0,.1)",
    "--yt-spec-general-background-a": "#181818",
    "--yt-spec-general-background-b": "#0f0f0f",
    "--yt-spec-general-background-c": "#030303",
    "--yt-spec-snackbar-background": "#030303",
    "--yt-spec-filled-button-text": "#030303",
    "--yt-spec-black-1": "#282828",
    "--yt-spec-black-2": "#1f1f1f",
    "--yt-spec-black-3": "#161616",
    "--yt-spec-black-4": "#0d0d0d",
    "--yt-spec-black-pure": "#000",
    "--paper-toast-background-color": "#323232",
    "--ytmusic-search-background": "#030303",
    "--paper-slider-knob-color": "#f03",
    "--paper-dialog-background-color": "#212121",
    "--paper-progress-active-color-1": "#f03",
    "--paper-progress-active-color-2": "#ff2791",
    "--yt-spec-inverted-background": "#f3f3f3",
    "background": "rgb(3,3,3)",
    "--ytmusic-background": "rgb(3,3,3)",
  };

  function artwork() {
    const items = navigator.mediaSession?.metadata?.artwork;
    if (!Array.isArray(items)) return "";
    return items.slice().sort((a, b) => size(b.sizes) - size(a.sizes))[0]?.src || "";
  }

  function size(value) {
    return Number.parseInt(String(value || "0").split("x")[0], 10) || 0;
  }

  async function averageColor(url) {
    if (!url) return null;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 32, 32);
    const data = context.getImageData(0, 0, 32, 32).data;
    let red = 0, green = 0, blue = 0, count = 0;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3] < 32) continue;
      red += data[i]; green += data[i + 1]; blue += data[i + 2]; count++;
    }
    if (!count) return null;
    return darken([red / count, green / count, blue / count], 0.15);
  }

  function darken(color, amount) {
    let next = color.map((value) => Math.max(0, value * (1 - amount)));
    while (luminance(next) > 0.5) next = next.map((value) => value * 0.95);
    return next.map(Math.round);
  }

  function luminance([red, green, blue]) {
    const channels = [red, green, blue].map((value) => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  function remember(variable) {
    if (!original.has(variable)) original.set(variable, document.documentElement.style.getPropertyValue(variable));
  }

  function applyVariables(color) {
    const dark = darken(color, 0.18);
    remember(COLOR_KEY); remember(DARK_KEY); remember(RATIO_KEY);
    document.documentElement.style.setProperty(COLOR_KEY, color.join(", "));
    document.documentElement.style.setProperty(DARK_KEY, dark.join(", "));
    document.documentElement.style.setProperty(RATIO_KEY, "50%");

    for (const [variable, base] of Object.entries(variables)) {
      remember(variable);
      const key = variable === "background" || variable === "--ytmusic-background" ? DARK_KEY : COLOR_KEY;
      const ratio = ["--paper-progress-active-color-1", "--paper-progress-active-color-2", "--yt-spec-inverted-background"].includes(variable) ? "87.5%" : "50%";
      document.documentElement.style.setProperty(variable, `color-mix(in srgb, ${base} ${100 - Number.parseFloat(ratio)}%, rgba(var(${key}),1) ${ratio})`, "important");
    }
    document.body.classList.add("ytm-tauri-seekbar-theme");
    installSeekbarStyle();
  }

  function installSeekbarStyle() {
    if (document.getElementById("ytm-tauri-album-theme-style")) return;
    const style = document.createElement("style");
    style.id = "ytm-tauri-album-theme-style";
    style.textContent = `.ytm-tauri-seekbar-theme ytmusic-player-bar tp-yt-paper-slider { --paper-slider-knob-color: rgb(var(${COLOR_KEY})) !important; --paper-slider-active-color: rgb(var(${COLOR_KEY})) !important; }`;
    const target = document.head || document.documentElement || document.body;
    if (target) target.appendChild(style);
  }

  async function refresh() {
    const url = artwork();
    if (!url || url === lastArtwork) return;
    lastArtwork = url;
    try {
      const color = await averageColor(url);
      if (color) applyVariables(color);
    } catch {
      applyVariables([0, 0, 0]);
    }
  }

  function start() {
    refresh();
    observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    document.addEventListener("yt-navigate-finish", refresh, true);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("yt-navigate-finish", refresh, true);
    for (const [variable, value] of original) {
      if (value) document.documentElement.style.setProperty(variable, value);
      else document.documentElement.style.removeProperty(variable);
    }
    original.clear();
    document.body.classList.remove("ytm-tauri-seekbar-theme");
    document.getElementById("ytm-tauri-album-theme-style")?.remove();
    lastArtwork = "";
  }

  runtime.register("album_color_theme", { start, stop });
})();
