(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime?.audioEngine || location.origin !== "https://music.youtube.com") return;

  const STORAGE_KEY = "ytm-tauri-output-device";
  let dialog = null;

  async function apply(config) {
    const saved = localStorage.getItem(STORAGE_KEY);
    const sinkId = saved || config.output_device || "default";
    await runtime.audioEngine.setOutput(sinkId);
  }

  async function choose() {
    const devices = await runtime.audioEngine.devices();
    closeDialog();

    dialog = document.createElement("div");
    dialog.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:rgba(0,0,0,.5);font:14px Segoe UI,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "width:min(480px,calc(100vw - 40px));padding:20px;border-radius:12px;background:#202124;color:#fff;box-shadow:0 20px 60px rgba(0,0,0,.45)";
    const title = document.createElement("div");
    title.textContent = "Audio output";
    title.style.cssText = "font-size:18px;font-weight:600;margin-bottom:14px";
    const select = document.createElement("select");
    select.style.cssText = "width:100%;box-sizing:border-box;padding:9px;border-radius:6px;background:#303134;color:#fff;border:1px solid #5f6368";
    const fallback = [{ id: "default", label: "Default output" }];
    const list = devices.length ? devices : fallback;
    for (const device of list) {
      const option = document.createElement("option");
      option.value = device.id || "default";
      option.textContent = device.id === "default" ? "Default output" : device.label;
      select.appendChild(option);
    }
    const current = localStorage.getItem(STORAGE_KEY) || runtime.config.output_device || "default";
    if ([...select.options].some((item) => item.value === current)) select.value = current;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px";
    const cancel = button("Cancel", closeDialog);
    const save = button("Use device", async () => {
      localStorage.setItem(STORAGE_KEY, select.value || "default");
      await runtime.audioEngine.setOutput(select.value || "default");
      closeDialog();
    });
    actions.append(cancel, save);
    card.append(title, select, actions);
    dialog.appendChild(card);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog();
    });
    document.body.appendChild(dialog);
  }

  function button(label, handler) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.style.cssText = "border:0;border-radius:18px;padding:8px 14px;background:#3c4043;color:#fff;cursor:pointer";
    node.addEventListener("click", handler);
    return node;
  }

  function closeDialog() {
    dialog?.remove();
    dialog = null;
  }

  function start(config) {
    apply(config).then(() => {
      if (!localStorage.getItem(STORAGE_KEY) && (config.output_device || "default") === "default") choose();
    });
  }

  function stop() {
    closeDialog();
    runtime.audioEngine.setOutput("default");
  }

  runtime.outputDevice = { choose };
  runtime.register("custom_output_device", { start, update: apply, stop });
})();
