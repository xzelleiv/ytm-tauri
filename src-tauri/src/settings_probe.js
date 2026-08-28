(() => {
  if (typeof location === "object" && location.hostname && location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytmSettingsModalInstalled) return;
  window.__ytmSettingsModalInstalled = true;

  const MODAL_ID = "ytm-settings-modal";
  const ONBOARDING_ID = "ytm-settings-onboarding";
  const HEADER_BTN_ID = "ytm-header-settings-btn";
  const ONBOARDING_KEY = "ytm_settings_onboarded_v5";

  let isOpen = false;
  let activeTab = "general";

  let ttPolicy = null;
  try {
    if (window.trustedTypes) {
      if (window.trustedTypes.defaultPolicy) {
        ttPolicy = window.trustedTypes.defaultPolicy;
      } else if (window.trustedTypes.createPolicy) {
        try {
          ttPolicy = window.trustedTypes.createPolicy("default", { createHTML: (s) => s });
        } catch {
          ttPolicy = window.trustedTypes.createPolicy("ytm-settings-policy", { createHTML: (s) => s });
        }
      }
    }
  } catch {}

  function setHTML(el, html) {
    if (!el) return;
    if (ttPolicy) {
      el.innerHTML = ttPolicy.createHTML(html);
    } else {
      try {
        el.innerHTML = html;
      } catch {
        const range = document.createRange();
        const fragment = range.createContextualFragment(html);
        el.textContent = "";
        el.appendChild(fragment);
      }
    }
  }

  const GEAR_ICON_SVG = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
    </svg>
  `;

  const GITHUB_ICON_SVG = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  `;

  const STYLES = `
    /* header settings button */
    #${HEADER_BTN_ID} {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 40px !important;
      height: 40px !important;
      border-radius: 50% !important;
      background: transparent !important;
      border: none !important;
      color: rgba(255, 255, 255, 0.7) !important;
      cursor: pointer !important;
      margin-right: 6px !important;
      margin-left: 2px !important;
      padding: 0 !important;
      outline: none !important;
      transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease !important;
      z-index: 100 !important;
      flex-shrink: 0 !important;
    }
    #${HEADER_BTN_ID}:hover {
      background: rgba(255, 255, 255, 0.1) !important;
      color: #fff !important;
    }
    #${HEADER_BTN_ID}:active {
      background: rgba(255, 255, 255, 0.16) !important;
      transform: scale(0.96) !important;
    }

    /* onboarding pulse highlight on button */
    #${HEADER_BTN_ID}.ytm-onboarding-target {
      box-shadow: 0 0 0 2px #ff0033, 0 0 12px rgba(255, 0, 51, 0.5) !important;
      animation: ytmTargetPulse 2s infinite ease-in-out !important;
    }
    @keyframes ytmTargetPulse {
      0%, 100% { box-shadow: 0 0 0 2px #ff0033, 0 0 8px rgba(255, 0, 51, 0.4); }
      50% { box-shadow: 0 0 0 2px #ff3b5c, 0 0 16px rgba(255, 0, 51, 0.8); }
    }

    /* onboarding chat bubble */
    #${ONBOARDING_ID} {
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(22, 22, 22, 0.96);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 20px;
      padding: 6px 12px 6px 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.8), 0 0 12px rgba(255, 0, 51, 0.2);
      z-index: 2147483640;
      color: #fff;
      font-family: "YouTube Sans", "Roboto", system-ui, sans-serif;
      cursor: pointer;
      user-select: none;
      animation: ytmBubbleFloat 2s infinite ease-in-out;
    }
    .ytm-bubble-arrow {
      position: absolute;
      top: -5px;
      left: 50%;
      transform: translateX(-50%) rotate(45deg);
      width: 9px;
      height: 9px;
      background: rgba(22, 22, 22, 0.96);
      border-top: 1px solid rgba(255, 255, 255, 0.16);
      border-left: 1px solid rgba(255, 255, 255, 0.16);
    }
    @keyframes ytmBubbleFloat {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-3px); }
    }
    .ytm-bubble-cursor {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ytm-bubble-cursor svg {
      width: 15px;
      height: 15px;
      fill: #ff0033;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6));
    }
    .ytm-bubble-text {
      font-size: 12px;
      font-weight: 500;
      color: #fff;
      white-space: nowrap;
    }
    .ytm-bubble-text strong {
      font-weight: 700;
      color: #ff3b5c;
    }
    .ytm-bubble-close {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.4);
      font-size: 12px;
      cursor: pointer;
      padding: 2px 4px;
      margin-left: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s ease;
    }
    .ytm-bubble-close:hover {
      color: #fff;
    }

    /* full overlay backdrop */
    #${MODAL_ID} {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      z-index: 2147483647;
      display: none;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 24px;
      font-family: "YouTube Sans", "Roboto", system-ui, sans-serif;
      animation: ytmFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    #${MODAL_ID}.open {
      display: flex !important;
    }
    @keyframes ytmFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* center modal box */
    .ytm-modal-box {
      width: 100%;
      max-width: 1040px;
      height: 84vh;
      max-height: 820px;
      background: #121212;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.85);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }

    /* modal header bar */
    .ytm-modal-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 60px;
      padding: 0 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.02);
      flex-shrink: 0;
    }
    .ytm-modal-heading {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ytm-modal-heading span {
      font-size: 12px;
      font-weight: 400;
      color: rgba(255, 255, 255, 0.5);
    }
    .ytm-modal-close {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.8);
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ytm-modal-close:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
    }

    /* modal body */
    .ytm-modal-body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .ytm-modal-tabs {
      width: 220px;
      flex-shrink: 0;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(0, 0, 0, 0.15);
    }
    .ytm-tab-button {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: left;
    }
    .ytm-tab-button:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
    }
    .ytm-tab-button.active {
      background: rgba(255, 0, 51, 0.14);
      color: #ff3b5c;
      font-weight: 600;
    }
    .ytm-tab-button svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }

    .ytm-modal-main {
      flex: 1;
      overflow-y: auto;
      padding: 24px 32px;
    }
    .ytm-modal-main::-webkit-scrollbar {
      width: 8px;
    }
    .ytm-modal-main::-webkit-scrollbar-track {
      background: transparent;
    }
    .ytm-modal-main::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.14);
      border-radius: 4px;
    }

    /* settings card items */
    .ytm-card-group {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 24px;
    }
    .ytm-settings-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 10px;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      transition: background 0.15s ease;
    }
    .ytm-settings-card:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .ytm-card-details {
      flex: 1;
    }
    .ytm-card-name {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin: 0 0 3px 0;
    }
    .ytm-card-summary {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.55);
      line-height: 1.4;
      margin: 0;
    }

    /* switch */
    .ytm-toggle {
      position: relative;
      display: inline-block;
      width: 40px;
      height: 22px;
      flex-shrink: 0;
    }
    .ytm-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .ytm-toggle-track {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: rgba(255, 255, 255, 0.18);
      border-radius: 22px;
      transition: 0.2s ease;
    }
    .ytm-toggle-track:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background: #fff;
      border-radius: 50%;
      transition: 0.2s ease;
    }
    .ytm-toggle input:checked + .ytm-toggle-track {
      background: #ff0033;
    }
    .ytm-toggle input:checked + .ytm-toggle-track:before {
      transform: translateX(18px);
    }

    /* select & buttons */
    .ytm-dropdown {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      outline: none;
      cursor: pointer;
    }
    .ytm-dropdown option {
      background: #181818;
      color: #fff;
    }

    .ytm-action-btn {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .ytm-action-btn:hover {
      background: rgba(255, 255, 255, 0.14);
    }
    .ytm-action-btn-primary {
      background: #ff0033;
      border-color: #ff0033;
    }
    .ytm-action-btn-primary:hover {
      background: #e6002e;
    }
  `;

  function injectStyles() {
    if (document.getElementById("ytm-settings-styles")) return;
    const styleEl = document.createElement("style");
    styleEl.id = "ytm-settings-styles";
    styleEl.textContent = STYLES;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function getConfig() {
    return window.__ytmFeatures?.config || window.__ytmFeatureConfig || {};
  }

  function setSetting(key, val) {
    if (window.__ytmFeatures?.setSetting) {
      window.__ytmFeatures.setSetting(key, val);
    } else {
      const cfg = getConfig();
      cfg[key] = val;
      if (window.__ytmFeatures?.configure) window.__ytmFeatures.configure(cfg);
    }
  }

  function triggerAction(action) {
    if (window.__ytmFeatures?.triggerAction) {
      window.__ytmFeatures.triggerAction(action);
    }
  }

  const RESTARTS_REQUIRED = [
    "spotify_spoof",
    "synced_lyrics",
    "equalizer",
    "custom_output_device",
    "crossfade",
  ];

  function showRestartDialog(isTurnedOn) {
    const existing = document.getElementById("ytm-restart-dialog");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "ytm-restart-dialog";
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const box = document.createElement("div");
    box.style.cssText = `
      background: #1e1e1e;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 12px;
      padding: 24px;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      gap: 16px;
      text-align: center;
    `;

    const title = document.createElement("div");
    title.style.cssText = "font-size: 16px; font-weight: 600; color: #fff;";
    title.textContent = "Restart Required";

    const msg = document.createElement("div");
    msg.style.cssText = "font-size: 14px; color: rgba(255, 255, 255, 0.8); line-height: 1.5;";
    msg.textContent = isTurnedOn
      ? "This feature requires restart after being turned on"
      : "This feature requires restart after being turned off";

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; justify-content: center; gap: 12px; margin-top: 8px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ytm-action-btn";
    cancelBtn.textContent = "Later";
    cancelBtn.addEventListener("click", () => overlay.remove());

    const okBtn = document.createElement("button");
    okBtn.className = "ytm-action-btn ytm-action-btn-primary";
    okBtn.style.cssText = "min-width: 80px;";
    okBtn.textContent = "Okay";
    okBtn.addEventListener("click", () => {
      triggerAction("force_close");
    });

    actions.append(cancelBtn, okBtn);
    box.append(title, msg, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  function createToggle(key, title, desc, defaultValue = true, requiresRestart = null) {
    const config = getConfig();
    const isChecked = config[key] !== undefined ? Boolean(config[key]) : defaultValue;
    const shouldRestart = requiresRestart !== null ? requiresRestart : RESTARTS_REQUIRED.includes(key);

    const card = document.createElement("div");
    card.className = "ytm-settings-card";
    setHTML(card, `
      <div class="ytm-card-details">
        <div class="ytm-card-name">${title}</div>
        <div class="ytm-card-summary">${desc}</div>
      </div>
      <label class="ytm-toggle">
        <input type="checkbox" data-key="${key}" ${isChecked ? "checked" : ""}>
        <span class="ytm-toggle-track"></span>
      </label>
    `);
    card.querySelector("input")?.addEventListener("change", (e) => {
      const nowChecked = e.target.checked;
      setSetting(key, nowChecked);
      if (shouldRestart) {
        showRestartDialog(nowChecked);
      }
    });
    return card;
  }

  function createSelect(key, title, desc, options, defaultValue) {
    const config = getConfig();
    const currentVal = config[key] || defaultValue;

    const card = document.createElement("div");
    card.className = "ytm-settings-card";

    const info = document.createElement("div");
    info.className = "ytm-card-details";
    setHTML(info, `
      <div class="ytm-card-name">${title}</div>
      <div class="ytm-card-summary">${desc}</div>
    `);

    const select = document.createElement("select");
    select.className = "ytm-dropdown";
    for (const opt of options) {
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === currentVal) el.selected = true;
      select.appendChild(el);
    }
    select.addEventListener("change", (e) => {
      setSetting(key, e.target.value);
    });

    card.appendChild(info);
    card.appendChild(select);
    return card;
  }

  function renderGeneral(container) {
    setHTML(container, `
      <h2 style="font-size:20px;margin:0 0 4px 0;color:#fff;">General Settings</h2>
      <p style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 20px 0;">Window controls, Discord presence, and scaling.</p>
    `);
    const group = document.createElement("div");
    group.className = "ytm-card-group";
    group.appendChild(createToggle("discord_rpc", "Discord Rich Presence", "Display current playing track, artist, album, and artwork on Discord profile.", true));
    group.appendChild(createToggle("close_to_tray", "Close to Tray", "Minimize YouTube Music to system notification tray instead of exiting.", false));
    group.appendChild(createToggle("launch_at_startup", "Launch at Startup", "Automatically start YouTube Music when logging into Windows.", false));
    group.appendChild(createToggle("start_minimized", "Start Minimized", "Launch app directly in background/tray without showing main window.", false));

    const zoomCard = document.createElement("div");
    zoomCard.className = "ytm-settings-card";
    setHTML(zoomCard, `
      <div class="ytm-card-details">
        <div class="ytm-card-name">Interface Zoom</div>
        <div class="ytm-card-summary">Scale web interface up or down for high-DPI displays.</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="ytm-action-btn" id="ytm-zoom-out">−</button>
        <button class="ytm-action-btn" id="ytm-zoom-reset">Reset</button>
        <button class="ytm-action-btn" id="ytm-zoom-in">+</button>
      </div>
    `);
    zoomCard.querySelector("#ytm-zoom-out")?.addEventListener("click", () => triggerAction("zoom_out"));
    zoomCard.querySelector("#ytm-zoom-reset")?.addEventListener("click", () => triggerAction("zoom_reset"));
    zoomCard.querySelector("#ytm-zoom-in")?.addEventListener("click", () => triggerAction("zoom_in"));
    group.appendChild(zoomCard);

    container.appendChild(group);
  }

  function renderLyrics(container) {
    setHTML(container, `
      <h2 style="font-size:20px;margin:0 0 4px 0;color:#fff;">Synced Lyrics</h2>
      <p style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 20px 0;">Multi-provider synchronized karaoke lyrics, line effects, and auto-sync.</p>
    `);
    const group = document.createElement("div");
    group.className = "ytm-card-group";
    group.appendChild(createToggle("synced_lyrics", "Enable Synced Lyrics", "Display synchronous multi-provider lyrics in the YouTube Music lyrics tab.", true));
    group.appendChild(createToggle("lyrics_auto_sync", "Auto Sync Lyrics after 3 Seconds", "Automatically resync viewport to current song position after 3s scroll inactivity.", true));
    group.appendChild(createToggle("lyrics_precise_timing", "Precise Timing (100ms)", "High-precision timer updates for smooth lyric tracking.", true));
    group.appendChild(createToggle("lyrics_romanization", "Romanization (Romaji)", "Provide Latin transliteration for Japanese, Korean, and Chinese lyrics.", false));
    group.appendChild(createToggle("lyrics_show_timecodes", "Show Timecodes", "Display millisecond timestamp markers beside lyric lines.", false));

    const effects = [
      { value: "fancy", label: "Fancy (Glow & Wobble)" },
      { value: "scale", label: "Scale (Active Focus)" },
      { value: "offset", label: "Offset (Indented)" },
      { value: "focus", label: "Focus (Clean Opacity)" },
    ];
    group.appendChild(createSelect("lyrics_line_effect", "Line Animation Effect", "Visual animation style applied to active and upcoming lyric lines.", effects, "fancy"));

    container.appendChild(group);
  }

  function renderAudio(container) {
    setHTML(container, `
      <h2 style="font-size:20px;margin:0 0 4px 0;color:#fff;">Audio & Equalizer</h2>
      <p style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 20px 0;">Equalizer DSP, volume curves, variable speed, and output routing.</p>
    `);
    const group = document.createElement("div");
    group.className = "ytm-card-group";
    group.appendChild(createToggle("equalizer", "Equalizer DSP", "Enable graphic equalizer and frequency shaping.", false));
    const presets = [
      { value: "bass-booster", label: "Bass Booster" },
      { value: "vocal-booster", label: "Vocal Booster" },
      { value: "rock", label: "Rock" },
      { value: "electronic", label: "Electronic / Dance" },
      { value: "acoustic", label: "Acoustic" },
      { value: "flat", label: "Flat / Neutral" },
    ];
    group.appendChild(createSelect("equalizer_preset", "Equalizer Preset", "Frequency profile applied when Equalizer is active.", presets, "bass-booster"));
    group.appendChild(createToggle("precise_volume", "Precise Volume Steps", "Granular 1% mouse-wheel volume increments.", false));
    group.appendChild(createToggle("exponential_volume", "Exponential Volume Curve", "Logarithmic volume curve matching human ear perception.", false));
    group.appendChild(createToggle("playback_speed", "Playback Speed Controls", "Add dedicated variable speed slider to the player bar.", false));
    group.appendChild(createToggle("crossfade", "Crossfade Audio", "Smooth volume transition between consecutive tracks.", false));
    group.appendChild(createToggle("custom_output_device", "Custom Output Device", "Route YouTube Music playback to a dedicated sound output.", false));

    container.appendChild(group);
  }

  function renderTweaks(container) {
    setHTML(container, `
      <h2 style="font-size:20px;margin:0 0 4px 0;color:#fff;">Tweaks & Visuals</h2>
      <p style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 20px 0;">Native ad blocking, SponsorBlock, ambient glow, and auto-skip.</p>
    `);
    const group = document.createElement("div");
    group.className = "ytm-card-group";
    group.appendChild(createToggle("ad_block", "Native Ad Blocking", "Block audio/video ads, promotional banners, and tracking domains.", true));
    group.appendChild(createToggle("sponsorblock", "SponsorBlock", "Automatically skip sponsor segments, intros, and non-music interludes.", true));
    group.appendChild(createToggle("spotify_spoof", "Spotify Spoof", "Display Discord presence as Spotify with artwork and Play on Spotify button.", false));
    group.appendChild(createToggle("ambient_mode", "Ambient Mode Glow", "Radiant album artwork ambient glow surrounding the video player.", true));
    group.appendChild(createToggle("blur_nav_bar", "Blur Navigation Bar", "Frosted glass backdrop filter on top navigation and player bars.", true));
    group.appendChild(createToggle("skip_disliked", "Skip Disliked Songs", "Automatically skip to next track when a disliked song is encountered.", false));
    group.appendChild(createToggle("video_toggle", "Video Mode Toggle", "Add single-click audio/video mode switch button to player bar.", false));
    group.appendChild(createToggle("disable_autoplay", "Disable Autoplay", "Prevent YouTube Music from automatically playing next recommended track.", false));

    container.appendChild(group);
  }

  function renderScrobble(container) {
    setHTML(container, `
      <h2 style="font-size:20px;margin:0 0 4px 0;color:#fff;">Music Scrobbling</h2>
      <p style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 20px 0;">Track listening history across Last.fm and ListenBrainz.</p>
    `);
    const group = document.createElement("div");
    group.className = "ytm-card-group";
    group.appendChild(createToggle("lastfm_scrobbling", "Last.fm Scrobbler", "Automatically log played songs to your Last.fm profile.", false));
    group.appendChild(createToggle("listenbrainz_scrobbling", "ListenBrainz Scrobbler", "Submit listens to open-source ListenBrainz music archive.", false));

    container.appendChild(group);
  }

  function renderSystem(container) {
    setHTML(container, `
      <h2 style="font-size:20px;margin:0 0 4px 0;color:#fff;">System</h2>
      <p style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 20px 0;">Repository source, updates, cache maintenance, and session reset.</p>
    `);
    const group = document.createElement("div");
    group.className = "ytm-card-group";

    // GitHub repository card
    const githubCard = document.createElement("div");
    githubCard.className = "ytm-settings-card";
    setHTML(githubCard, `
      <div class="ytm-card-details">
        <div class="ytm-card-name">GitHub Repository</div>
        <div class="ytm-card-summary">xzelleiv/ytm-tauri · Releases, issues, and open-source documentation.</div>
      </div>
      <button class="ytm-action-btn" id="ytm-act-github" title="Open GitHub Repository" aria-label="Open GitHub" style="display:inline-flex;align-items:center;justify-content:center;padding:7px 12px;">
        ${GITHUB_ICON_SVG}
      </button>
    `);
    githubCard.querySelector("#ytm-act-github")?.addEventListener("click", () => {
      triggerAction("open_github");
    });
    group.appendChild(githubCard);

    // check updates
    const updateCard = document.createElement("div");
    updateCard.className = "ytm-settings-card";
    setHTML(updateCard, `
      <div class="ytm-card-details">
        <div class="ytm-card-name">Check for Updates</div>
        <div class="ytm-card-summary">Query GitHub releases for the latest desktop build.</div>
      </div>
      <button class="ytm-action-btn ytm-action-btn-primary" id="ytm-act-update">Check Now</button>
    `);
    updateCard.querySelector("#ytm-act-update")?.addEventListener("click", () => triggerAction("check_updates"));
    group.appendChild(updateCard);

    // clear cache
    const cacheCard = document.createElement("div");
    cacheCard.className = "ytm-settings-card";
    setHTML(cacheCard, `
      <div class="ytm-card-details">
        <div class="ytm-card-name">Clear Cache and Reload</div>
        <div class="ytm-card-summary">Flush local WebView caches, lyrics cache, and reload.</div>
      </div>
      <button class="ytm-action-btn" id="ytm-act-cache">Clear Cache</button>
    `);
    cacheCard.querySelector("#ytm-act-cache")?.addEventListener("click", () => triggerAction("clear_cache"));
    group.appendChild(cacheCard);

    // reset session
    const resetCard = document.createElement("div");
    resetCard.className = "ytm-settings-card";
    setHTML(resetCard, `
      <div class="ytm-card-details">
        <div class="ytm-card-name">Reset Session Data</div>
        <div class="ytm-card-summary">Wipe stored cookies, site storage, and restart fresh.</div>
      </div>
      <button class="ytm-action-btn" id="ytm-act-reset">Reset Session</button>
    `);
    resetCard.querySelector("#ytm-act-reset")?.addEventListener("click", () => triggerAction("reset_session"));
    group.appendChild(resetCard);

    container.appendChild(group);
  }

  function renderModal() {
    let modal = document.getElementById(MODAL_ID);
    if (!modal) {
      modal = document.createElement("div");
      modal.id = MODAL_ID;
      document.body.appendChild(modal);
    }

    setHTML(modal, `
      <div class="ytm-modal-box">
        <div class="ytm-modal-topbar">
          <div class="ytm-modal-heading">
            YouTube Music Settings
            <span>v0.2.3 by xzelleiv</span>
          </div>
          <button class="ytm-modal-close" id="ytm-modal-close-btn" title="Close Settings">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="ytm-modal-body">
          <div class="ytm-modal-tabs">
            <button class="ytm-tab-button ${activeTab === "general" ? "active" : ""}" data-tab="general">
              <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
              General
            </button>
            <button class="ytm-tab-button ${activeTab === "lyrics" ? "active" : ""}" data-tab="lyrics">
              <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
              Synced Lyrics
            </button>
            <button class="ytm-tab-button ${activeTab === "audio" ? "active" : ""}" data-tab="audio">
              <svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
              Audio & Equalizer
            </button>
            <button class="ytm-tab-button ${activeTab === "tweaks" ? "active" : ""}" data-tab="tweaks">
              <svg viewBox="0 0 24 24"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
              Tweaks & Visuals
            </button>
            <button class="ytm-tab-button ${activeTab === "scrobble" ? "active" : ""}" data-tab="scrobble">
              <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>
              Scrobbling
            </button>
            <button class="ytm-tab-button ${activeTab === "system" ? "active" : ""}" data-tab="system">
              <svg viewBox="0 0 24 24"><path d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z"/></svg>
              System
            </button>
          </div>
          <div class="ytm-modal-main" id="ytm-modal-content-area"></div>
        </div>
      </div>
    `);

    modal.querySelector("#ytm-modal-close-btn")?.addEventListener("click", closeSettingsScreen);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeSettingsScreen();
    });

    modal.querySelectorAll(".ytm-tab-button").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        modal.querySelectorAll(".ytm-tab-button").forEach((b) => b.classList.toggle("active", b === btn));
        renderActiveContent();
      });
    });

    renderActiveContent();
  }

  function renderActiveContent() {
    const area = document.getElementById("ytm-modal-content-area");
    if (!area) return;
    area.textContent = "";

    switch (activeTab) {
      case "general": renderGeneral(area); break;
      case "lyrics": renderLyrics(area); break;
      case "audio": renderAudio(area); break;
      case "tweaks": renderTweaks(area); break;
      case "scrobble": renderScrobble(area); break;
      case "system": renderSystem(area); break;
      default: renderGeneral(area); break;
    }
  }

  function openSettingsScreen() {
    isOpen = true;
    renderModal();
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.classList.add("open");
  }

  function closeSettingsScreen() {
    isOpen = false;
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.classList.remove("open");
  }

  function toggleSettingsScreen() {
    if (isOpen) closeSettingsScreen();
    else openSettingsScreen();
  }

  function dismissOnboarding() {
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch {}
    const popover = document.getElementById(ONBOARDING_ID);
    if (popover) popover.remove();
    document.querySelectorAll(".ytm-onboarding-target").forEach((el) => {
      el.classList.remove("ytm-onboarding-target");
    });
  }

  function positionOnboarding(popover, targetBtn) {
    if (!popover || !targetBtn) return;
    const rect = targetBtn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const popoverWidth = popover.offsetWidth || 156;
    const top = rect.bottom + 9;
    const center = rect.left + rect.width / 2;
    const left = Math.max(12, center - popoverWidth / 2);
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function setupOnboarding(gearBtn) {
    let onboarded = false;
    try {
      onboarded = localStorage.getItem(ONBOARDING_KEY) === "true";
    } catch {}
    if (onboarded) return;

    gearBtn.classList.add("ytm-onboarding-target");

    if (document.getElementById(ONBOARDING_ID)) {
      positionOnboarding(document.getElementById(ONBOARDING_ID), gearBtn);
      return;
    }

    const popover = document.createElement("div");
    popover.id = ONBOARDING_ID;
    setHTML(popover, `
      <div class="ytm-bubble-arrow"></div>
      <div class="ytm-bubble-cursor">
        <svg viewBox="0 0 24 24"><path d="M5.5 2.5l13 8.5-6 1.5 3.5 7.5-2.5 1-3.5-7.5-4.5 4.5V2.5z"/></svg>
      </div>
      <span class="ytm-bubble-text">Click for <strong>Settings</strong></span>
      <button class="ytm-bubble-close" id="ytm-onboarding-dismiss" title="Dismiss">✕</button>
    `);

    popover.addEventListener("click", (e) => {
      if (e.target.closest("#ytm-onboarding-dismiss")) {
        e.preventDefault();
        e.stopPropagation();
        dismissOnboarding();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      dismissOnboarding();
      openSettingsScreen();
    });

    document.body.appendChild(popover);
    positionOnboarding(popover, gearBtn);
  }

  function installHeaderElements() {
    injectStyles();

    // Insert or acquire dedicated gear button in header
    const rightContent = document.querySelector("ytmusic-nav-bar #right-content, #nav-bar #right-content");
    if (rightContent) {
      let gearBtn = document.getElementById(HEADER_BTN_ID);
      if (!gearBtn) {
        gearBtn = document.createElement("button");
        gearBtn.id = HEADER_BTN_ID;
        gearBtn.setAttribute("title", "YouTube Music Settings");
        gearBtn.setAttribute("aria-label", "YouTube Music Settings");
        setHTML(gearBtn, GEAR_ICON_SVG);
        gearBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          dismissOnboarding();
          toggleSettingsScreen();
        });
        rightContent.insertBefore(gearBtn, rightContent.firstChild);
      }
      setupOnboarding(gearBtn);
    }
  }

  // document click listener for header button
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;

    const headerBtn = target.closest?.(`#${HEADER_BTN_ID}`);
    if (headerBtn) {
      e.preventDefault();
      e.stopPropagation();
      dismissOnboarding();
      toggleSettingsScreen();
    }
  }, true);

  // keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) {
      closeSettingsScreen();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      toggleSettingsScreen();
    }
  });

  // sync ui when settings change
  window.addEventListener("ytm-settings-changed", () => {
    if (isOpen) {
      renderActiveContent();
    }
  });

  const observer = new MutationObserver(() => {
    installHeaderElements();
  });

  const install = () => {
    if (!document.documentElement) {
      setTimeout(install, 50);
      return;
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    installHeaderElements();

    const interval = setInterval(installHeaderElements, 500);
    setTimeout(() => clearInterval(interval), 10_000);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
