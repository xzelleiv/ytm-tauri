(() => {
  if (window.__ytmFeatures || location.origin !== "https://music.youtube.com") return;

  const features = new Map();
  const requests = new Map();
  let requestId = 0;
  let config = {};

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
      const previousTitle = document.title;
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
          reject(new Error("feature request timed out"));
        }, 10_000);
        requests.set(id, { resolve, reject, timeout });
        document.title = `YTMFEATURE:${JSON.stringify(message)}`;
        queueMicrotask(() => {
          if (document.title.startsWith("YTMFEATURE:")) document.title = previousTitle;
        });
      });
    },
    receive(id, response) {
      const pending = requests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      requests.delete(id);
      if (response?.error) pending.reject(new Error(response.error));
      else pending.resolve(response);
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
