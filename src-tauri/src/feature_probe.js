(() => {
  if (window.__ytmFeatures) return;

  if (window.trustedTypes && typeof window.trustedTypes.createPolicy === "function") {
    try {
      window.trustedTypes.createPolicy("default", {
        createHTML: (input) => input,
        createScriptURL: (input) => input,
        createScript: (input) => input,
      });
    } catch {}
  }

  const features = new Map();
  const requests = new Map();
  const queue = [];
  let requestId = 0;
  let sending = false;
  let config = window.__ytmFeatureConfig && typeof window.__ytmFeatureConfig === "object" ? { ...window.__ytmFeatureConfig } : {};

  function flushQueue() {
    if (sending || !queue.length) return;
    sending = true;
    const item = queue.shift();
    requests.set(item.id, item);
    document.title = `YTMFEATURE:${JSON.stringify(item.message)}`;
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
        const timeout = setTimeout(() => {
          requests.delete(id);
          sending = false;
          flushQueue();
          reject(new Error("feature request timed out"));
        }, 10_000);
        queue.push({ id, message, resolve, reject, timeout });
        flushQueue();
      });
    },
    receive(id, response) {
      const pending = requests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        requests.delete(id);
        if (response?.error) pending.reject(new Error(response.error));
        else pending.resolve(response);
      }
      sending = false;
      if (queue.length) {
        setTimeout(flushQueue, 15);
      }
    },
  };

  function apply(name) {
    const feature = features.get(name);
    if (!feature) return;

    const enabled = Boolean(config[name]);
    if (enabled === feature.active) {
      feature.update?.(config, api);
      return;
    }

    if (enabled) {
      feature.start?.(config, api);
      feature.active = true;
    } else {
      feature.stop?.(api);
      feature.active = false;
    }
  }

  window.__ytmFeatures = api;
  api.configure(window.__ytmFeatureConfig || {});
})();
