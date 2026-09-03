(() => {
  if (typeof location === "object" && location.hostname && location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytmFeatures) return;

  const features = new Map();
  const requests = new Map();
  const queue = [];
  let requestId = 0;
  let sending = false;
  let config = window.__ytmFeatureConfig && typeof window.__ytmFeatureConfig === "object" ? { ...window.__ytmFeatureConfig } : {};

  function releaseTitle(item) {
    if (document.title === item.title) {
      document.title = item.previousTitle;
    }
  }

  function flushQueue() {
    if (sending || !queue.length) return;
    sending = true;
    const item = queue.shift();
    item.timeout = setTimeout(() => {
      requests.delete(item.id);
      releaseTitle(item);
      sending = false;
      flushQueue();
      item.reject(new Error("feature request timed out"));
    }, 15_000);
    requests.set(item.id, item);
    item.message.ts = Date.now();
    item.previousTitle = document.title.startsWith("YTMFEATURE:") ? "YouTube Music" : document.title;
    item.title = `YTMFEATURE:${JSON.stringify(item.message)}`;
    document.title = item.title;
  }

  const api = {
    get config() {
      return config;
    },
    media() {
      return document.querySelector("video, audio");
    },
    app() {
      return document.querySelector("ytmusic-app");
    },
    register(name, feature) {
      features.set(name, { ...feature, active: false });
      apply(name);
    },
    configure(next) {
      config = next && typeof next === "object" ? { ...next } : {};
      for (const name of features.keys()) apply(name);
      try {
        window.dispatchEvent(new CustomEvent("ytm-settings-changed", { detail: { ...config } }));
      } catch {}
    },
    getSettings() {
      const id = ++requestId;
      const message = { id, kind: "get_settings" };
      return new Promise((resolve, reject) => {
        queue.push({ id, message, resolve, reject });
        flushQueue();
      });
    },
    setSetting(key, value) {
      const hadPrevious = Object.prototype.hasOwnProperty.call(config, key);
      const previousValue = config[key];
      config[key] = value;
      for (const name of features.keys()) apply(name);
      try {
        window.dispatchEvent(new CustomEvent("ytm-settings-changed", { detail: { ...config } }));
      } catch {}

      const id = ++requestId;
      const message = { id, kind: "set_setting", key, value };
      const pending = new Promise((resolve, reject) => {
        queue.push({ id, message, resolve, reject });
        flushQueue();
      });
      return pending.then(
        (response) => {
          if (response?.settings) api.configure(response.settings);
          return response;
        },
        (error) => {
          if (hadPrevious) config[key] = previousValue;
          else delete config[key];
          for (const name of features.keys()) apply(name);
          try {
            window.dispatchEvent(new CustomEvent("ytm-settings-changed", { detail: { ...config } }));
          } catch {}
          throw error;
        },
      );
    },
    triggerAction(action) {
      const id = ++requestId;
      const message = { id, kind: "action", action };
      return new Promise((resolve, reject) => {
        queue.push({ id, message, resolve, reject });
        flushQueue();
      });
    },
    request(url, init = {}) {
      const id = ++requestId;
      const message = {
        id,
        kind: "http",
        url,
        method: String(init.method || "GET").toUpperCase(),
        body: typeof init.body === "string" ? init.body : null,
        headers: init.headers && typeof init.headers === "object" ? init.headers : {},
      };

      return new Promise((resolve, reject) => {
        queue.push({ id, message, resolve, reject });
        flushQueue();
      });
    },
    receive(id, response) {
      const pending = requests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      requests.delete(id);
      releaseTitle(pending);
      if (response?.error) pending.reject(new Error(response.error));
      else pending.resolve(response);
      sending = false;
      if (queue.length) {
        setTimeout(flushQueue, 10);
      }
    },
  };

  function apply(name) {
    const feature = features.get(name);
    if (!feature) return;

    const enabled = Boolean(config[name]);
    if (enabled === feature.active) {
      try {
        feature.update?.(config, api);
      } catch {}
      return;
    }

    if (enabled) {
      if (!document.documentElement && document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => apply(name), { once: true });
        return;
      }
      try {
        feature.start?.(config, api);
        feature.active = true;
      } catch {}
    } else {
      try {
        feature.stop?.(api);
      } catch {}
      feature.active = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    for (const name of features.keys()) apply(name);
  }, { once: true });

  // block context menu
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }, true);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }, true);
    document.addEventListener("selectstart", (e) => {
      const tag = e.target?.tagName?.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      e.preventDefault();
      return false;
    }, true);
  }

  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const guardStyle = document.createElement("style");
    guardStyle.id = "ytm-guard-style";
    guardStyle.textContent = `
      *, *::before, *::after {
        -webkit-user-select: none !important;
        -moz-user-select: none !important;
        -ms-user-select: none !important;
        user-select: none !important;
      }
      input, textarea, [contenteditable="true"], [contenteditable=""] {
        -webkit-user-select: text !important;
        -moz-user-select: text !important;
        -ms-user-select: text !important;
        user-select: text !important;
      }
    `;
    const injectGuard = () => {
      const target = document.head || document.documentElement || document.body;
      if (target && typeof target.appendChild === "function") {
        if (!document.getElementById?.("ytm-guard-style")) target.appendChild(guardStyle);
      } else {
        setTimeout(injectGuard, 50);
      }
    };
    injectGuard();
  }

  window.__ytmFeatures = api;
  api.configure(window.__ytmFeatureConfig || {});
})();
