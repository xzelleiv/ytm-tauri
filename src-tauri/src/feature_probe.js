(() => {
  if (window.__ytmFeatures || location.origin !== "https://music.youtube.com") return;

  const features = new Map();
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
