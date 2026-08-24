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
      config[key] = value;
      for (const name of features.keys()) apply(name);
      try {
        window.dispatchEvent(new CustomEvent("ytm-settings-changed", { detail: { ...config } }));
      } catch {}

      const id = ++requestId;
      const message = { id, kind: "set_setting", key, value };
      return new Promise((resolve, reject) => {
        queue.push({ id, message, resolve, reject });
        flushQueue();
      });
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
      if (pending) {
        clearTimeout(pending.timeout);
        requests.delete(id);
        releaseTitle(pending);
        if (response?.error) pending.reject(new Error(response.error));
        else pending.resolve(response);
      }
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

  window.__ytmFeatures = api;
  api.configure(window.__ytmFeatureConfig || {});
})();
