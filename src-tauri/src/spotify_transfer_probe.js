(() => {
  if (typeof location === "object" && location.hostname && location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytmSpotify) return;

  const requests = new Map();
  const queue = [];
  const debugLogs = [];
  const matchingLogs = [];
  let requestId = 0;
  let sending = false;
  let currentJob = null;
  let activeView = "home";
  let activeHomeTab = "link";
  let librarySearchQuery = "";
  let isConnected = false;
  let connectedUser = null;
  let authStatus = null;
  let userPlaylists = [];
  let modalRoot = null;
  let reviewPage = 0;
  let reviewSortOrder = "review";
  const REVIEW_PAGE_SIZE = 50;
  let isMatchingActive = false;
  let isTransferActive = false;
  let authEpoch = 0;
  let libraryEpoch = 0;
  let workflowEpoch = 0;

  function logDebug(msg, data = null) {
    const time = new Date().toTimeString().split(" ")[0] + "." + String(Date.now() % 1000).padStart(3, "0");
    const entry = `[${time}] ${msg}` + (data !== null ? ` ${typeof data === "object" ? JSON.stringify(data) : data}` : "");
    debugLogs.push(entry);
    if (debugLogs.length > 300) debugLogs.shift();
    console.log(`[YTM_SPOTIFY_DEBUG] ${entry}`);
    const el = document.getElementById("ytm-spot-debug-output");
    if (el) {
      el.textContent = debugLogs.join("\n");
      el.scrollTop = el.scrollHeight;
    }
  }

  function appendMatchingLog(line) {
    matchingLogs.push(line);
    if (matchingLogs.length > 250) matchingLogs.shift();
    const term = document.getElementById("ytm-matching-terminal");
    if (term) {
      const lineEl = document.createElement("div");
      lineEl.className = "ytm-spot-terminal-line";
      lineEl.textContent = line;
      term.appendChild(lineEl);
      term.scrollTop = term.scrollHeight;
    }
  }

  function releaseTitle(item) {
    if (document.title === item.title) {
      document.title = item.previousTitle;
    }
  }

  function flushQueue() {
    if (sending || !queue.length) return;
    sending = true;
    const item = queue.shift();
    logDebug(`send id=${item.id} action=${item.message.action}`);
    item.timeout = setTimeout(() => {
      requests.delete(item.id);
      requests.delete(String(item.id));
      requests.delete(Number(item.id));
      releaseTitle(item);
      sending = false;
      logDebug(`timeout id=${item.id} action=${item.message.action}`);
      item.reject(new Error("spotify bridge timeout"));
      flushQueue();
    }, 10_000);

    requests.set(item.id, item);
    item.message.ts = Date.now();
    item.previousTitle = document.title.startsWith("YTMSPOTIFY:") ? "YouTube Music" : document.title;
    item.title = `YTMSPOTIFY:${JSON.stringify(item.message)}`;
    document.title = item.title;
  }

  const bridge = {
    send(message) {
      const id = ++requestId;
      const fullMessage = { id, ...message };
      return new Promise((resolve, reject) => {
        queue.push({ id, message: fullMessage, resolve, reject });
        flushQueue();
      });
    },

    receive(id, payload) {
      logDebug(`receive id=${id} ok=${payload?.ok}`, payload?.error || (payload?.tracks ? `${payload.tracks.length} tracks` : null));
      const numId = Number(id);
      const item = requests.get(numId) || requests.get(id) || requests.get(String(id));
      if (!item) {
        logDebug(`receive unhandled id=${id}`);
        return;
      }
      clearTimeout(item.timeout);
      requests.delete(numId);
      requests.delete(id);
      requests.delete(String(id));
      releaseTitle(item);
      sending = false;
      flushQueue();

      if (payload && payload.ok) {
        item.resolve(payload);
      } else {
        item.reject(new Error(payload?.error || "bridge error"));
      }
    },

    emit(event, payload) {
      logDebug(`emit event=${event}`, payload);
      if (event === "session_connected") {
        authEpoch += 1;
        isConnected = true;
        connectedUser = payload?.user_name || "Spotify User";
        authStatus = null;
        updateNavButtonText();
        if (activeView === "home") {
          loadLibrary(authEpoch);
        }
      } else if (event === "session_error") {
        authStatus = payload?.error || "Spotify authentication failed";
        renderView();
      }
    },
    getSortedReviewTracks,
  };

  window.__ytmSpotify = bridge;

  function injectStyles() {
    if (document.getElementById("ytm-spotify-transfer-styles")) return;
    const style = document.createElement("style");
    style.id = "ytm-spotify-transfer-styles";
    style.textContent = `
      .ytm-spot-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 18px;
        padding: 6px 14px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        user-select: none;
        margin-right: 8px;
      }
      .ytm-spot-btn:hover {
        background: rgba(255, 255, 255, 0.16);
        border-color: rgba(255, 255, 255, 0.3);
        transform: translateY(-1px);
      }
      .ytm-spot-btn:active {
        transform: translateY(0);
      }
      .ytm-spot-btn-green {
        background: #1db954 !important;
        color: #000 !important;
        border: none !important;
        font-weight: 600 !important;
      }
      .ytm-spot-btn-green:hover {
        background: #1ed760 !important;
        box-shadow: 0 4px 12px rgba(29, 185, 84, 0.35);
      }
      .ytm-spot-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(12px);
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
      }
      .ytm-spot-modal-backdrop.open {
        opacity: 1;
        pointer-events: auto;
      }
      .ytm-spot-tabs {
        display: flex;
        gap: 6px;
        margin-bottom: 18px;
        background: rgba(255, 255, 255, 0.04);
        padding: 4px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .ytm-spot-tab-btn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        background: transparent;
        color: #999;
        border: none;
        border-radius: 8px;
        padding: 9px 12px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .ytm-spot-tab-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.04);
      }
      .ytm-spot-tab-btn.active {
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
        font-weight: 600;
      }
      .ytm-spot-hero-card {
        background: linear-gradient(135deg, rgba(29, 185, 84, 0.08), rgba(255, 255, 255, 0.02));
        border: 1px solid rgba(29, 185, 84, 0.2);
        border-radius: 12px;
        padding: 18px;
        margin-bottom: 14px;
      }
      .ytm-spot-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 14px;
        padding: 4px 10px;
        font-size: 11px;
        color: #bbb;
      }
      .ytm-spot-modal-card {
        width: 860px;
        max-width: 94vw;
        height: 84vh;
        max-height: 720px;
        background: #121214;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.8);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        color: #f1f1f1;
        font-family: Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ytm-spot-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .ytm-spot-modal-header h2 {
        margin: 0;
        font-size: 17px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .ytm-spot-modal-body {
        padding: 20px 24px;
        overflow-y: auto;
        flex: 1;
        display: flex;
        flex-direction: column;
      }
      .ytm-spot-section {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 14px;
      }
      .ytm-spot-input {
        width: 100%;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 10px 14px;
        color: #fff;
        font-size: 14px;
        box-sizing: border-box;
        outline: none;
      }
      .ytm-spot-input:focus {
        border-color: #1db954;
        background: rgba(255, 255, 255, 0.09);
      }
      .ytm-spot-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 10px;
        margin-top: 10px;
        max-height: 220px;
        overflow-y: auto;
      }
      .ytm-spot-card {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 12px;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        flex-direction: row;
        gap: 10px;
      }
      .ytm-spot-card:hover {
        background: rgba(255, 255, 255, 0.09);
        border-color: rgba(29, 185, 84, 0.5);
      }
      .ytm-spot-card.liked-special {
        background: linear-gradient(135deg, rgba(74, 20, 140, 0.35), rgba(29, 185, 84, 0.2));
        border-color: rgba(186, 104, 200, 0.5);
      }
      .ytm-spot-card-art {
        width: 44px;
        height: 44px;
        flex: 0 0 44px;
        border-radius: 7px;
        object-fit: cover;
        background: linear-gradient(135deg, #4527a0, #1db954);
        display: grid;
        place-items: center;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
      }
      .ytm-spot-card-copy {
        min-width: 0;
        flex: 1;
      }
      .ytm-spot-card-title {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ytm-spot-card-sub {
        font-size: 11px;
        color: #aaa;
      }
      .ytm-spot-progress-bar {
        height: 8px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        overflow: hidden;
        margin: 16px 0 8px;
      }
      .ytm-spot-progress-fill {
        height: 100%;
        background: #1db954;
        width: 0%;
        transition: width 0.2s ease;
      }
      .ytm-spot-terminal {
        background: #000000;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        padding: 12px 14px;
        font-family: Consolas, Menlo, Monaco, "Liberation Mono", monospace;
        font-size: 12px;
        line-height: 1.5;
        color: #ffffff;
        text-align: left;
        width: 100%;
        max-width: 760px;
        box-sizing: border-box;
        margin: 14px auto 0 auto;
        flex: 1;
        min-height: 220px;
        max-height: 380px;
        overflow-y: auto;
        box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.8);
        user-select: text;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ytm-spot-terminal-line {
        color: #ffffff;
        font-family: inherit;
      }
      .ytm-spot-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .ytm-spot-table th {
        text-align: left;
        padding: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        color: #888;
        font-weight: 500;
        position: sticky;
        top: 0;
        background: #18181b;
        z-index: 1;
      }
      .ytm-spot-table td {
        padding: 8px 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        vertical-align: middle;
      }
      .ytm-spot-pill {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 600;
      }
      .ytm-spot-pill-high { background: rgba(46, 204, 113, 0.2); color: #2ecc71; }
      .ytm-spot-pill-review { background: rgba(241, 196, 15, 0.2); color: #f1c40f; }
      .ytm-spot-pill-low { background: rgba(231, 76, 60, 0.2); color: #e74c3c; }
    `;
    document.head.appendChild(style);
  }

  function updateNavButtonText() {
    const btn = document.getElementById("ytm-spotify-transfer-btn");
    if (!btn) return;

    if (isMatchingActive && currentJob) {
      const p = currentJob.progress;
      const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
      btn.innerHTML = `<span>Matching (${pct}%)</span>`;
    } else if (isTransferActive && currentJob) {
      const added = currentJob.transferred_count || 0;
      const total = currentJob.progress.total || 1;
      const pct = Math.round((added / total) * 100);
      btn.innerHTML = `<span>Transferring (${pct}%)</span>`;
    } else {
      btn.innerHTML = `<span>Transfer</span>`;
    }
  }

  function initHeaderButton() {
    injectStyles();
    const tryInsert = () => {
      if (document.getElementById("ytm-spotify-transfer-btn")) return;
      const navBar =
        document.querySelector("ytmusic-nav-bar .right-content") ||
        document.querySelector("ytmusic-nav-bar") ||
        document.querySelector("#nav-bar-background");

      if (navBar) {
        const btn = document.createElement("button");
        btn.id = "ytm-spotify-transfer-btn";
        btn.className = "ytm-spot-btn";
        btn.innerHTML = `<span>Transfer</span>`;
        btn.onclick = () => openModal();

        const insertTarget = navBar.querySelector("ytmusic-settings-button") || navBar.firstChild;
        if (insertTarget && insertTarget.parentNode === navBar) {
          navBar.insertBefore(btn, insertTarget);
        } else {
          navBar.appendChild(btn);
        }
      }
    };

    tryInsert();
    if (typeof MutationObserver !== "function" || !document.documentElement) return;
    let insertScheduled = false;
    const scheduleInsert = () => {
      if (insertScheduled) return;
      insertScheduled = true;
      const schedule = window.requestAnimationFrame || ((callback) => setTimeout(callback, 16));
      schedule(() => {
        insertScheduled = false;
        tryInsert();
      });
    };
    const observer = new MutationObserver(scheduleInsert);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function createModal() {
    if (modalRoot) return;
    injectStyles();

    modalRoot = document.createElement("div");
    modalRoot.className = "ytm-spot-modal-backdrop";
    modalRoot.innerHTML = `
      <div class="ytm-spot-modal-card">
        <div class="ytm-spot-modal-header">
          <h2>Spotify to YouTube Music Transfer</h2>
          <div style="display:flex; gap:6px; align-items:center;">
            <!-- devmode only
            <button id="ytm-spot-devtools-btn" class="ytm-spot-btn" title="Open Developer Tools" style="font-size:12px; padding:4px 8px;">DevTools</button>
            <button id="ytm-spot-debug-toggle-btn" class="ytm-spot-btn" title="Toggle Live Debug Logs" style="font-size:12px; padding:4px 8px;">Debug</button>
            -->
            <button id="ytm-spot-close-btn" class="ytm-spot-btn">Close</button>
          </div>
        </div>
        <div id="ytm-spot-modal-content" class="ytm-spot-modal-body"></div>
        <div id="ytm-spot-debug-panel" style="display:none; border-top:1px solid rgba(255,255,255,0.1); padding:12px; background:rgba(0,0,0,0.5);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div style="font-size:12px; font-weight:600; color:#1db954;">Live Diagnostic Console</div>
            <div style="display:flex; gap:6px;">
              <button id="ytm-spot-copy-debug-btn" class="ytm-spot-btn" style="font-size:11px; padding:2px 8px;">Copy Logs</button>
              <button id="ytm-spot-clear-debug-btn" class="ytm-spot-btn" style="font-size:11px; padding:2px 8px;">Clear</button>
            </div>
          </div>
          <pre id="ytm-spot-debug-output" style="max-height:140px; overflow-y:auto; font-size:11px; color:#aaa; margin:0; white-space:pre-wrap; word-break:break-all; font-family:monospace; background:rgba(0,0,0,0.4); padding:8px; border-radius:4px;"></pre>
        </div>
      </div>
    `;

    document.body.appendChild(modalRoot);
    document.getElementById("ytm-spot-close-btn").onclick = closeModal;
    const devtoolsBtn = document.getElementById("ytm-spot-devtools-btn");
    if (devtoolsBtn) {
      devtoolsBtn.onclick = () => {
        logDebug("opening devtools");
        bridge.send({ action: "open_devtools" }).catch(() => {
          window.__ytmFeatures?.triggerAction?.("open_devtools");
        });
      };
    }
    const debugToggleBtn = document.getElementById("ytm-spot-debug-toggle-btn");
    if (debugToggleBtn) {
      debugToggleBtn.onclick = () => {
        const panel = document.getElementById("ytm-spot-debug-panel");
        if (panel) {
          panel.style.display = panel.style.display === "none" ? "block" : "none";
          const out = document.getElementById("ytm-spot-debug-output");
          if (out) {
            out.textContent = debugLogs.join("\n") || "no logs yet";
            out.scrollTop = out.scrollHeight;
          }
        }
      };
    }
    document.getElementById("ytm-spot-copy-debug-btn").onclick = () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(debugLogs.join("\n")).then(() => {
          alert("Debug logs copied to clipboard");
        });
      }
    };
    document.getElementById("ytm-spot-clear-debug-btn").onclick = () => {
      debugLogs.length = 0;
      const out = document.getElementById("ytm-spot-debug-output");
      if (out) out.textContent = "";
    };
    modalRoot.onclick = (e) => {
      if (e.target === modalRoot) closeModal();
    };
  }

  function openModal() {
    createModal();
    modalRoot.classList.add("open");
    if (!currentJob) {
      checkStatus();
    } else {
      renderView();
    }
  }

  function closeModal() {
    if (modalRoot) {
      modalRoot.classList.remove("open");
      updateNavButtonText();
    }
  }

  async function checkStatus() {
    const epoch = ++authEpoch;
    try {
      const res = await bridge.send({ action: "get_status" });
      if (epoch !== authEpoch) return;
      isConnected = !!res.is_authenticated;
      connectedUser = res.user_name;
    } catch {}
    if (epoch !== authEpoch) return;
    renderView();
    if (isConnected && (!userPlaylists.length || libraryError)) {
      loadLibrary(epoch);
    }
  }

  let isLoadingLibrary = false;
  let libraryError = null;

  async function loadLibrary(expectedAuthEpoch = authEpoch) {
    if (!isConnected || expectedAuthEpoch !== authEpoch) return;
    const requestEpoch = ++libraryEpoch;
    isLoadingLibrary = true;
    libraryError = null;
    renderView();
    try {
      const res = await bridge.send({ action: "list_playlists" });
      if (requestEpoch !== libraryEpoch || expectedAuthEpoch !== authEpoch || !isConnected) return;
      if (res.ok) {
        userPlaylists = res.playlists || [];
        libraryError = null;
      } else {
        libraryError = res.error || "Failed to load playlists";
      }
    } catch (err) {
      if (requestEpoch !== libraryEpoch || expectedAuthEpoch !== authEpoch || !isConnected) return;
      libraryError = String(err);
    } finally {
      if (requestEpoch !== libraryEpoch || expectedAuthEpoch !== authEpoch || !isConnected) return;
      isLoadingLibrary = false;
      renderView();
    }
  }

  function renderView() {
    const container = document.getElementById("ytm-spot-modal-content");
    if (!container) return;

    if (activeView === "home") {
      renderHome(container);
    } else if (activeView === "matching") {
      renderMatching(container);
    } else if (activeView === "review") {
      renderReview(container);
    } else if (activeView === "transferring") {
      renderTransferring(container);
    } else if (activeView === "complete") {
      renderComplete(container);
    }
  }

  function renderHome(container) {
    let tabContentHtml = "";

    if (activeHomeTab === "link") {
      tabContentHtml = `
        <div class="ytm-spot-hero-card">
          <div style="font-weight:600; font-size:15px; margin-bottom:4px; color:#fff;">Paste Spotify URL</div>
          <div style="font-size:12px; color:#aaa; margin-bottom:14px; line-height:1.4;">
            Transfer any public playlist, album, or track. Zero login or account connection needed.
          </div>
          <div style="display:flex; gap:8px;">
            <input id="ytm-spot-link-input" class="ytm-spot-input" placeholder="https://open.spotify.com/playlist/... or album/..." />
            <button id="ytm-spot-fetch-btn" class="ytm-spot-btn ytm-spot-btn-green" style="white-space:nowrap; padding:8px 18px;">Analyze</button>
          </div>
          <!-- devmode only
          <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:12px;">
            <span class="ytm-spot-pill">Public Playlists</span>
            <span class="ytm-spot-pill">Albums</span>
            <span class="ytm-spot-pill">Tracks</span>
            <span class="ytm-spot-pill">Fast SSR Engine</span>
          </div>
          -->
        </div>
      `;
    } else if (activeHomeTab === "library") {
      if (isConnected) {
        const query = (librarySearchQuery || "").toLowerCase();
        const filtered = userPlaylists.filter((p) => !query || (p.name && p.name.toLowerCase().includes(query)));
        tabContentHtml = `
          <div class="ytm-spot-section" style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px;">
            <div style="font-size:13px; color:#1db954; font-weight:500;">
              Connected as <strong>${escapeHtml(connectedUser || "User")}</strong>
            </div>
            <button id="ytm-spot-logout" class="ytm-spot-btn" style="padding:4px 10px; font-size:12px;">Log out</button>
          </div>

          <div class="ytm-spot-section">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
              <div style="font-weight:600; font-size:14px;">Your Spotify Playlists (${userPlaylists.length})</div>
              <div style="display:flex; gap:6px; align-items:center;">
                <input id="ytm-spot-lib-search" class="ytm-spot-input" style="max-width:180px; padding:4px 10px; font-size:12px;" placeholder="Filter playlists..." value="${escapeHtml(librarySearchQuery)}" />
                <button id="ytm-spot-reload-lib-btn" class="ytm-spot-btn" style="padding:4px 10px; font-size:12px;">Refresh</button>
              </div>
            </div>
            ${
              isLoadingLibrary
                ? `<div style="padding:28px 0; text-align:center; color:#aaa; font-size:13px;">Loading your Spotify playlists and Liked Songs...</div>`
                : libraryError
                ? `<div style="padding:20px 0; text-align:center; color:#ff6b6b; font-size:13px;">
                    <div style="margin-bottom:6px;">${escapeHtml(libraryError)}</div>
                    <button id="ytm-spot-retry-lib-btn" class="ytm-spot-btn" style="padding:6px 14px; font-size:12px;">Retry</button>
                  </div>`
                : `<div class="ytm-spot-grid">
                    ${
                      filtered.length
                        ? filtered
                            .map((p) => {
                              const imageUrl = safeSpotifyImageUrl(p.image_url);
                              return `
                      <div class="ytm-spot-card ${p.is_liked_songs ? "liked-special" : ""}" data-pid="${escapeHtml(p.id)}">
                        ${imageUrl ? `<img class="ytm-spot-card-art" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<div class="ytm-spot-card-art">${p.is_liked_songs ? "LS" : "SP"}</div>`}
                        <div class="ytm-spot-card-copy">
                          <div class="ytm-spot-card-title">${escapeHtml(p.name)}</div>
                          <div class="ytm-spot-card-sub">${p.track_count} tracks${p.owner_name ? " - " + escapeHtml(p.owner_name) : ""}</div>
                        </div>
                      </div>
                    `;
                            })
                            .join("")
                        : `<div style="grid-column:1/-1; font-size:13px; color:#888; text-align:center; padding:20px 0;">No matching playlists found</div>`
                    }
                  </div>`
            }
          </div>
        `;
      } else {
        tabContentHtml = `
          <div class="ytm-spot-hero-card">
            <div style="font-weight:600; font-size:15px; margin-bottom:4px; color:#fff;">Connect Your Spotify Account</div>
            <div style="font-size:12px; color:#aaa; margin-bottom:14px; line-height:1.4;">
              Link your Spotify account to import Liked Songs and private playlists. The app never exposes your session credential to the YouTube page.
            </div>
            <div style="display:flex; flex-direction:column; gap:12px;">
              <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                <button id="ytm-spot-browser-login" class="ytm-spot-btn ytm-spot-btn-green" style="padding:10px 20px; font-size:13px;">Sign in with Spotify</button>
                <button id="ytm-spot-check-status-btn" class="ytm-spot-btn" style="padding:10px 16px; font-size:13px;">Check Login</button>
              </div>
              ${authStatus ? `<div style="font-size:12px; color:#ff8a80; line-height:1.4;">${escapeHtml(authStatus)}</div>` : ""}
            </div>
          </div>
        `;
      }
    } else if (activeHomeTab === "file") {
      tabContentHtml = `
        <div class="ytm-spot-hero-card">
          <div style="font-weight:600; font-size:15px; margin-bottom:4px; color:#fff;">Import File or Text</div>
          <div style="font-size:12px; color:#aaa; margin-bottom:12px;">
            Paste CSV (Exportify format), JSON track list, or plain text lines like "Artist - Song Title".
          </div>
          <textarea id="ytm-spot-text-input" class="ytm-spot-input" rows="6" placeholder="Paste track lines or CSV here..." style="font-family:monospace; font-size:12px; resize:vertical;"></textarea>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
            <div style="display:flex; gap:6px;">
              <span class="ytm-spot-pill">CSV</span>
              <span class="ytm-spot-pill">JSON</span>
              <span class="ytm-spot-pill">Text Lines</span>
            </div>
            <button id="ytm-spot-parse-text-btn" class="ytm-spot-btn ytm-spot-btn-green" style="padding:6px 16px;">Parse Input</button>
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="ytm-spot-tabs">
        <button class="ytm-spot-tab-btn ${activeHomeTab === "link" ? "active" : ""}" data-tab="link">Paste Link</button>
        <button class="ytm-spot-tab-btn ${activeHomeTab === "library" ? "active" : ""}" data-tab="library">Spotify Library${isConnected ? " (Connected)" : ""}</button>
        <button class="ytm-spot-tab-btn ${activeHomeTab === "file" ? "active" : ""}" data-tab="file">Import File / Text</button>
      </div>
      ${tabContentHtml}
    `;

    container.querySelectorAll(".ytm-spot-tab-btn[data-tab]").forEach((btn) => {
      btn.onclick = () => {
        const tab = btn.getAttribute("data-tab");
        if (tab && tab !== activeHomeTab) {
          activeHomeTab = tab;
          renderView();
        }
      };
    });

    const reloadLibBtn = document.getElementById("ytm-spot-reload-lib-btn");
    if (reloadLibBtn) {
      reloadLibBtn.onclick = () => loadLibrary();
    }

    const retryLibBtn = document.getElementById("ytm-spot-retry-lib-btn");
    if (retryLibBtn) {
      retryLibBtn.onclick = () => loadLibrary();
    }

    const checkStatusBtn = document.getElementById("ytm-spot-check-status-btn");
    if (checkStatusBtn) {
      checkStatusBtn.onclick = () => checkStatus();
    }

    const browserLoginBtn = document.getElementById("ytm-spot-browser-login");
    if (browserLoginBtn) {
      browserLoginBtn.onclick = async () => {
        const epoch = ++authEpoch;
        libraryEpoch += 1;
        authStatus = null;
        browserLoginBtn.disabled = true;
        browserLoginBtn.textContent = "Opening browser...";
        try {
          const response = await bridge.send({ action: "open_browser_login" });
          if (epoch !== authEpoch) return;
          authStatus = response.auth_mode === "oauth_pkce"
            ? "Complete Spotify authorization in your browser."
            : "The browser helper is ready for a web access token or sp_dc cookie.";
          renderView();
        } catch (error) {
          if (epoch !== authEpoch) return;
          authStatus = error.message;
          renderView();
        }
      };
    }

    const logoutBtn = document.getElementById("ytm-spot-logout");
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        const epoch = ++authEpoch;
        libraryEpoch += 1;
        isConnected = false;
        connectedUser = null;
        userPlaylists = [];
        isLoadingLibrary = false;
        libraryError = null;
        renderView();
        try {
          await bridge.send({ action: "logout" });
        } catch (error) {
          if (epoch === authEpoch) {
            authStatus = error.message;
            renderView();
          }
        }
      };
    }

    const libSearchInput = document.getElementById("ytm-spot-lib-search");
    if (libSearchInput) {
      libSearchInput.oninput = (e) => {
        librarySearchQuery = e.target.value;
        renderView();
        const nextInput = document.getElementById("ytm-spot-lib-search");
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
        }
      };
    }

    const fetchBtn = document.getElementById("ytm-spot-fetch-btn");
    if (fetchBtn) {
      fetchBtn.onclick = () => {
        const link = document.getElementById("ytm-spot-link-input")?.value?.trim();
        if (link) handleStartLink(link);
      };
    }

    const parseTextBtn = document.getElementById("ytm-spot-parse-text-btn");
    if (parseTextBtn) {
      parseTextBtn.onclick = () => {
        const text = document.getElementById("ytm-spot-text-input")?.value?.trim();
        if (text) handleStartRawText(text);
      };
    }

    container.querySelectorAll(".ytm-spot-card[data-pid]").forEach((card) => {
      card.onclick = () => {
        const pid = card.getAttribute("data-pid");
        if (pid) handleStartLink(pid);
      };
    });
  }

  async function fetchEmbedViaFeatures(link) {
    let parsed = null;
    if (link.includes("/playlist/")) {
      const match = link.match(/playlist\/([a-zA-Z0-9]+)/);
      if (match) parsed = { kind: "playlist", id: match[1] };
    } else if (link.includes("/album/")) {
      const match = link.match(/album\/([a-zA-Z0-9]+)/);
      if (match) parsed = { kind: "album", id: match[1] };
    } else if (link.includes("/track/")) {
      const match = link.match(/track\/([a-zA-Z0-9]+)/);
      if (match) parsed = { kind: "track", id: match[1] };
    } else if (/^[a-zA-Z0-9]{22}$/.test(link)) {
      parsed = { kind: "playlist", id: link };
    }
    if (!parsed) throw new Error("unsupported link format");

    const embedUrl = `https://open.spotify.com/embed/${parsed.kind}/${parsed.id}`;
    logDebug("fallback embed fetch", embedUrl);
    if (!window.__ytmFeatures?.request) {
      throw new Error("feature bridge unavailable");
    }

    const res = await window.__ytmFeatures.request(embedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res || !res.body) {
      throw new Error(`embed http status ${res?.status || "unknown"}`);
    }

    const match = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error("no embed data");

    const nextData = JSON.parse(match[1]);
    const entity =
      nextData?.props?.pageProps?.state?.data?.entity || nextData?.props?.pageProps?.data?.entity;
    if (!entity) throw new Error("no embed entity");

    const playlist = {
      id: entity.id || parsed.id,
      name: entity.name || entity.title || "Spotify Playlist",
      description: entity.description || entity.subtitle || "",
      track_count: entity.trackList?.length || entity.tracks?.length || 0,
      image_url: entity.coverArt?.sources?.[0]?.url || entity.visualIdentity?.image?.[0]?.url || null,
      owner_name: entity.owner?.name || "Spotify",
      is_liked_songs: false,
      is_collaborative: false,
      is_owner: false,
      snapshot_id: null,
    };

    const rawList = entity.trackList || entity.tracks || [];
    const tracks = [];
    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      const title = item.title || item.name;
      if (!title) continue;

      let artists = [];
      if (Array.isArray(item.artists)) {
        artists = item.artists.map((a) => (typeof a === "string" ? a : a.name)).filter(Boolean);
      } else if (item.subtitle) {
        artists = item.subtitle.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (!artists.length) artists = ["Unknown Artist"];

      tracks.push({
        id: item.id || `track_${i}`,
        title: title,
        artists: artists,
        album: item.album?.name || null,
        duration_ms: item.duration || item.duration_ms || 0,
        isrc: item.isrc || null,
        uri: item.uri || null,
        track_number: i + 1,
        disc_number: 1,
      });
    }

    logDebug(`fallback parsed ${tracks.length} tracks`);
    return { playlist, tracks };
  }

  async function handleStartLink(link) {
    const epoch = ++workflowEpoch;
    isMatchingActive = false;
    logDebug("start link parse", link);
    const container = document.getElementById("ytm-spot-modal-content");
    if (container) {
      container.innerHTML = `
        <div style="text-align:center; padding:40px 20px;">
          <div class="ytm-spot-spinner" style="margin:0 auto 16px auto;"></div>
          <div style="font-size:16px; font-weight:600; margin-bottom:8px;">Fetching metadata from Spotify...</div>
          <div id="ytm-spot-progress-text" style="font-size:12px; color:#aaa; margin-bottom:20px;">Connecting to bridge...</div>
          <div style="display:flex; justify-content:center; gap:8px;">
            <button id="ytm-spot-cancel-fetch" class="ytm-spot-btn">Cancel</button>
            <button id="ytm-spot-open-devtools-inline" class="ytm-spot-btn">DevTools</button>
          </div>
        </div>
      `;
      const cancelBtn = document.getElementById("ytm-spot-cancel-fetch");
      if (cancelBtn) {
        cancelBtn.onclick = () => {
          if (epoch !== workflowEpoch) return;
          workflowEpoch += 1;
          activeView = "home";
          renderView();
        };
      }
      const devtoolsBtn = document.getElementById("ytm-spot-open-devtools-inline");
      if (devtoolsBtn) {
        devtoolsBtn.onclick = () => {
          window.__ytmFeatures?.triggerAction?.("open_devtools");
        };
      }
    }

    let tracks = [];
    let playlist = null;

    try {
      const progress = document.getElementById("ytm-spot-progress-text");
      if (progress) progress.textContent = "Querying native backend bridge...";

      const res = await bridge.send({ action: "parse_link", link });
      if (epoch !== workflowEpoch) return;
      tracks = res.tracks || [];
      playlist = res.playlist;
    } catch (bridgeErr) {
      logDebug("primary bridge failed", bridgeErr.message);
      const progress = document.getElementById("ytm-spot-progress-text");
      if (progress) progress.textContent = "Attempting feature bridge fallback...";

      try {
        const fallbackRes = await fetchEmbedViaFeatures(link);
        if (epoch !== workflowEpoch) return;
        tracks = fallbackRes.tracks || [];
        playlist = fallbackRes.playlist;
      } catch (fallbackErr) {
        if (epoch !== workflowEpoch) return;
        logDebug("fallback failed", fallbackErr.message);
        if (container) {
          container.innerHTML = `
            <div style="text-align:center; padding:36px 20px;">
              <div style="font-size:18px; color:#e74c3c; margin-bottom:10px; font-weight:700;">Error</div>
              <div style="font-size:16px; font-weight:600; color:#e74c3c; margin-bottom:6px;">Failed to fetch Spotify metadata</div>
              <div style="font-size:12px; color:#aaa; margin-bottom:14px; max-width:480px; margin-left:auto; margin-right:auto; word-break:break-word;">
                Primary error: <code>${escapeHtml(bridgeErr.message)}</code><br>
                Fallback error: <code>${escapeHtml(fallbackErr.message)}</code>
              </div>
              <div style="display:flex; justify-content:center; gap:8px; margin-bottom:16px;">
                <button id="ytm-spot-err-retry" class="ytm-spot-btn ytm-spot-btn-green">Retry</button>
                <button id="ytm-spot-err-devtools" class="ytm-spot-btn">Open DevTools</button>
                <button id="ytm-spot-err-debug" class="ytm-spot-btn">Show Logs</button>
                <button id="ytm-spot-err-back" class="ytm-spot-btn">Back</button>
              </div>
              <div style="font-size:12px; color:#888;">Or paste tracks directly under "Import File or Text".</div>
            </div>
          `;
          const retryBtn = document.getElementById("ytm-spot-err-retry");
          if (retryBtn) retryBtn.onclick = () => handleStartLink(link);
          const dtBtn = document.getElementById("ytm-spot-err-devtools");
          if (dtBtn) dtBtn.onclick = () => window.__ytmFeatures?.triggerAction?.("open_devtools");
          const dbgBtn = document.getElementById("ytm-spot-err-debug");
          if (dbgBtn) {
            dbgBtn.onclick = () => {
              const panel = document.getElementById("ytm-spot-debug-panel");
              if (panel) panel.style.display = "block";
            };
          }
          const backBtn = document.getElementById("ytm-spot-err-back");
          if (backBtn) {
            backBtn.onclick = () => {
              activeView = "home";
              renderView();
            };
          }
        }
        return;
      }
    }

    if (!tracks.length) {
      alert("No tracks found in playlist.");
      activeView = "home";
      renderView();
      return;
    }

    logDebug(`proceeding with ${tracks.length} tracks`);
    const sourceTracks = tracks.map((t, idx) => ({
      index: idx,
      id: t.id,
      title: t.title,
      artists: t.artists,
      album: t.album,
      duration_ms: t.duration_ms,
      is_explicit: t.is_explicit,
    }));

    if (epoch !== workflowEpoch) return;
    startMatchingJob(playlist?.name || "Spotify Playlist", playlist?.description, sourceTracks, epoch);
  }

  async function handleStartRawText(raw_text) {
    const epoch = ++workflowEpoch;
    isMatchingActive = false;
    try {
      const res = await bridge.send({ action: "parse_raw_text", raw_text });
      if (epoch !== workflowEpoch) return;
      const sourceTracks = res.source_tracks || [];
      if (!sourceTracks.length) {
        alert("No tracks found in text.");
        return;
      }
      startMatchingJob(res.playlist?.name || "Imported Playlist", res.playlist?.description, sourceTracks, epoch);
    } catch (err) {
      if (epoch !== workflowEpoch) return;
      alert(`Error parsing input: ${err.message}`);
    }
  }

  function scoreCandidate(source, candidate, rank) {
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const srcTitle = norm(source.title);
    const candTitle = norm(candidate.title);

    let titleScore = 0;
    if (srcTitle === candTitle) {
      titleScore = 1.0;
    } else if (srcTitle.includes(candTitle) || candTitle.includes(srcTitle)) {
      titleScore = 0.85;
    } else {
      const srcWords = (source.title || "")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const matchedWords = srcWords.filter((w) =>
        (candidate.title || "").toLowerCase().includes(w)
      );
      titleScore = srcWords.length ? matchedWords.length / srcWords.length : 0.4;
    }

    let artistScore = 0.3;
    const srcArtists = (source.artists || []).map((a) => norm(a));
    const candArtists = (candidate.artists || []).map((a) => norm(a));
    for (const sa of srcArtists) {
      if (candArtists.some((ca) => ca.includes(sa) || sa.includes(ca))) {
        artistScore = 1.0;
        break;
      }
    }

    let durationScore = 0.5;
    if (source.duration_ms && candidate.duration_seconds) {
      const srcSecs = source.duration_ms / 1000;
      const diff = Math.abs(srcSecs - candidate.duration_seconds);
      if (diff <= 3) durationScore = 1.0;
      else if (diff <= 10) durationScore = 0.85;
      else if (diff <= 25) durationScore = 0.6;
      else durationScore = 0.2;
    }

    const rankBonus = rank === 0 ? 1.0 : rank === 1 ? 0.8 : 0.6;
    const total =
      titleScore * 0.45 + artistScore * 0.35 + durationScore * 0.15 + rankBonus * 0.05;
    const finalScore = Math.min(1.0, Math.max(0.0, total));
    candidate.score = finalScore;
    candidate.confidence =
      finalScore >= 0.82 ? "high" : finalScore >= 0.6 ? "review" : "low";
    return candidate;
  }

  function startMatchingJob(playlistTitle, playlistDesc, sourceTracks, epoch = ++workflowEpoch) {
    if (epoch !== workflowEpoch) return;
    logDebug("starting in-memory matching job", {
      title: playlistTitle,
      tracks: sourceTracks.length,
    });

    matchingLogs.length = 0;
    appendMatchingLog(`Ready. Matching ${sourceTracks.length} tracks against YouTube Music...`);

    currentJob = {
      id: "job_" + Date.now(),
      playlist_title: playlistTitle,
      playlist_description: playlistDesc,
      tracks: sourceTracks.map((t, idx) => ({
        index: idx,
        originalIndex: idx,
        source: t,
        selected_candidate: null,
        match_type: "unmatched",
        candidates: [],
        status: "pending",
      })),
      progress: {
        total: sourceTracks.length,
        current: 0,
        matched: 0,
        needs_review: 0,
        unmatched: sourceTracks.length,
      },
    };

    activeView = "matching";
    reviewPage = 0;
    reviewSortOrder = "review";
    isMatchingActive = true;
    updateNavButtonText();
    renderView();
    runMatchingPipeline(epoch, currentJob);
  }

  async function runMatchingPipeline(epoch, job) {
    if (!job || currentJob !== job || epoch !== workflowEpoch || !window.__ytmTransferAdapter) return;
    const tracks = job.tracks || [];

    for (let i = 0; i < tracks.length; i++) {
      if (!isMatchingActive || currentJob !== job || epoch !== workflowEpoch) return;
      const t = tracks[i].source;
      const artistStr = (t.artists || []).join(", ") || "Unknown Artist";
      appendMatchingLog(`[${i + 1}/${tracks.length}] ${artistStr} - ${t.title}`);

      let rawCandidates = [];
      try {
        rawCandidates = await window.__ytmTransferAdapter.searchSongs(t.title, t.artists);
      } catch (e) {
        logDebug(`search error on track ${i}`, e.message);
      }
      if (!isMatchingActive || currentJob !== job || epoch !== workflowEpoch) return;

      const scored = (rawCandidates || []).map((c, r) => scoreCandidate(t, c, r));
      scored.sort((a, b) => (b.score || 0) - (a.score || 0));

      tracks[i].candidates = scored;
      if (scored.length && scored[0].confidence === "high") {
        tracks[i].selected_candidate = scored[0];
        tracks[i].match_type = "high";
        const candArtist = (scored[0].artists || []).join(", ") || "Unknown";
        appendMatchingLog(`  -> Matched: ${candArtist} - ${scored[0].title} (${Math.round(scored[0].score * 100)}%)`);
      } else if (scored.length && scored[0].confidence === "review") {
        tracks[i].selected_candidate = scored[0];
        tracks[i].match_type = "review";
        const candArtist = (scored[0].artists || []).join(", ") || "Unknown";
        appendMatchingLog(`  -> Review: ${candArtist} - ${scored[0].title} (${Math.round(scored[0].score * 100)}%)`);
      } else {
        tracks[i].selected_candidate = scored[0] || null;
        tracks[i].match_type = "unmatched";
        appendMatchingLog(`  -> No match found`);
      }

      job.progress.current = i + 1;
      job.progress.matched = tracks.filter((x) => x.match_type === "high").length;
      job.progress.needs_review = tracks.filter((x) => x.match_type === "review").length;
      job.progress.unmatched = tracks.filter((x) => x.match_type === "unmatched").length;

      updateMatchingProgress();
      updateNavButtonText();
    }

    if (isMatchingActive && currentJob === job && epoch === workflowEpoch) {
      appendMatchingLog(`Matching complete. Transitioning to review...`);
      isMatchingActive = false;
      activeView = "review";
      updateNavButtonText();
      renderView();
    }
  }

  function updateMatchingProgress() {
    const fill = document.getElementById("ytm-matching-fill");
    const label = document.getElementById("ytm-matching-label");
    const counts = document.getElementById("ytm-matching-counts");
    if (!currentJob) return;

    const { total, current, matched, needs_review, unmatched } = currentJob.progress;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;

    if (fill) fill.style.width = `${pct}%`;
    if (label) label.textContent = `Analyzing & Matching: ${current} of ${total} (${pct}%)`;
    if (counts) {
      counts.innerHTML = `
        <span style="color:#2ecc71;">● ${matched} High</span> &nbsp;
        <span style="color:#f1c40f;">● ${needs_review} Review</span> &nbsp;
        <span style="color:#e74c3c;">● ${unmatched} Unmatched</span>
      `;
    }
  }

  function renderMatching(container) {
    container.innerHTML = `
      <div style="text-align:center; padding:10px 0; display:flex; flex-direction:column; flex:1; min-height:0; box-sizing:border-box; width:100%;">
        <h3 style="margin-top:0; margin-bottom:6px;">Finding Best Matches on YouTube Music</h3>
        <div id="ytm-matching-label" style="font-size:14px; color:#aaa; margin-bottom:8px;">Starting search...</div>
        <div class="ytm-spot-progress-bar" style="width:100%; max-width:760px; margin:8px auto 0 auto;">
          <div id="ytm-matching-fill" class="ytm-spot-progress-fill"></div>
        </div>
        <div id="ytm-matching-counts" style="margin-top:10px; font-size:13px;"></div>
        <div id="ytm-matching-terminal" class="ytm-spot-terminal">
          ${matchingLogs.map((l) => `<div class="ytm-spot-terminal-line">${escapeHtml(l)}</div>`).join("")}
        </div>
        <div style="margin-top:16px;">
          <button id="ytm-spot-cancel-match" class="ytm-spot-btn">Cancel</button>
        </div>
      </div>
    `;

    updateMatchingProgress();

    const term = document.getElementById("ytm-matching-terminal");
    if (term) {
      term.scrollTop = term.scrollHeight;
    }

    document.getElementById("ytm-spot-cancel-match").onclick = () => {
      workflowEpoch += 1;
      isMatchingActive = false;
      activeView = "home";
      currentJob = null;
      updateNavButtonText();
      renderView();
    };
  }

  function getSortedReviewTracks(tracks, sortOrder) {
    const list = (tracks || []).slice();
    if (sortOrder === "confident") {
      return list.sort((a, b) => {
        const confRank = (t) => {
          if (t.match_type === "high" || t.selected_candidate?.confidence === "high") return 0;
          if (t.match_type === "review" || t.selected_candidate?.confidence === "review") return 1;
          return 2;
        };
        const rankDiff = confRank(a) - confRank(b);
        if (rankDiff !== 0) return rankDiff;
        const scoreA = a.selected_candidate?.score || 0;
        const scoreB = b.selected_candidate?.score || 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return (a.originalIndex ?? 0) - (b.originalIndex ?? 0);
      });
    }

    if (sortOrder === "original") {
      return list.sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));
    }

    return list.sort((a, b) => {
      const reviewRank = (t) => {
        if (t.match_type === "unmatched" || !t.selected_candidate) return 0;
        if (t.match_type === "review" || t.selected_candidate?.confidence === "review") return 1;
        return 2;
      };
      const rankDiff = reviewRank(a) - reviewRank(b);
      if (rankDiff !== 0) return rankDiff;
      const scoreA = a.selected_candidate?.score || 0;
      const scoreB = b.selected_candidate?.score || 0;
      if (scoreA !== scoreB) return scoreA - scoreB;
      return (a.originalIndex ?? 0) - (b.originalIndex ?? 0);
    });
  }

  function renderReview(container) {
    if (!currentJob) return;

    const existingTitle = document.getElementById("ytm-dest-title")?.value;
    if (existingTitle !== undefined) currentJob.playlist_title = existingTitle;
    const existingPrivacy = document.getElementById("ytm-dest-privacy")?.value;
    if (existingPrivacy !== undefined) currentJob.privacy = existingPrivacy;

    const allTracks = getSortedReviewTracks(currentJob.tracks || [], reviewSortOrder);
    const total = allTracks.length;
    const maxPages = Math.ceil(total / REVIEW_PAGE_SIZE) || 1;
    const startIndex = reviewPage * REVIEW_PAGE_SIZE;
    const pageTracks = allTracks.slice(startIndex, startIndex + REVIEW_PAGE_SIZE);

    const rowsHtml = pageTracks
      .map((t) => {
        const origIdx = t.originalIndex ?? 0;
        const s = t.source;
        const cand = t.selected_candidate;
        let pillClass = "ytm-spot-pill-low";
        let pillText = "No Match";

        if (cand) {
          const pct = Math.round(cand.score * 100);
          if (cand.confidence === "high") {
            pillClass = "ytm-spot-pill-high";
            pillText = `${pct}% Match`;
          } else {
            pillClass = "ytm-spot-pill-review";
            pillText = `${pct}% Review`;
          }
        }

        const isSkipped = t.status === "skipped";

        return `
          <tr style="${isSkipped ? "opacity:0.35;" : ""}">
            <td>${origIdx + 1}</td>
            <td>
              <strong>${escapeHtml(s.title)}</strong><br/>
              <span style="color:#888; font-size:12px;">${escapeHtml((s.artists || []).join(", "))}</span>
            </td>
            <td>
              ${
                cand
                  ? `<span>${escapeHtml(cand.title)}</span><br/><span style="color:#888; font-size:12px;">${escapeHtml(
                      (cand.artists || []).join(", ")
                    )} (${cand.duration_seconds}s)</span>`
                  : `<span style="color:#e74c3c;">No match found</span>`
              }
            </td>
            <td>
              <span class="ytm-spot-pill ${pillClass}">${pillText}</span>
            </td>
            <td>
              <button class="ytm-spot-btn ytm-spot-skip-btn" data-idx="${origIdx}" style="padding:3px 8px; font-size:11px;">
                ${isSkipped ? "Include" : "Skip"}
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    const activePrivacy = currentJob.privacy || "PRIVATE";

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div>
          <h3 style="margin:0;">Review Matches</h3>
          <div style="color:#aaa; font-size:12px;">${total} tracks matched against YouTube Music catalog</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button id="ytm-spot-back-home" class="ytm-spot-btn">Back</button>
          <button id="ytm-spot-start-transfer" class="ytm-spot-btn ytm-spot-btn-green">Transfer to YouTube Music</button>
        </div>
      </div>

      <div class="ytm-spot-section" style="display:flex; gap:12px; align-items:center; padding:10px 14px; margin-bottom:10px;">
        <input id="ytm-dest-title" class="ytm-spot-input" value="${escapeHtml(currentJob.playlist_title)}" placeholder="Destination Playlist Title" style="flex:1;" />
        <select id="ytm-review-sort" class="ytm-spot-input" style="width:180px;">
          <option value="review" ${reviewSortOrder === "review" ? "selected" : ""}>Needs Review First</option>
          <option value="confident" ${reviewSortOrder === "confident" ? "selected" : ""}>Confident Matches First</option>
          <option value="original" ${reviewSortOrder === "original" ? "selected" : ""}>Original Track Order</option>
        </select>
        <select id="ytm-dest-privacy" class="ytm-spot-input" style="width:130px;">
          <option value="PRIVATE" ${activePrivacy === "PRIVATE" ? "selected" : ""}>Private</option>
          <option value="UNLISTED" ${activePrivacy === "UNLISTED" ? "selected" : ""}>Unlisted</option>
          <option value="PUBLIC" ${activePrivacy === "PUBLIC" ? "selected" : ""}>Public</option>
        </select>
      </div>

      <div style="flex:1; overflow-y:auto; border:1px solid rgba(255,255,255,0.08); border-radius:8px; margin-bottom:8px;">
        <table class="ytm-spot-table">
          <thead>
            <tr>
              <th style="width:36px;">#</th>
              <th>Spotify Source</th>
              <th>Matched Candidate</th>
              <th style="width:110px;">Confidence</th>
              <th style="width:70px;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>

      ${
        maxPages > 1
          ? `
        <div style="display:flex; justify-content:space-between; align-items:center; padding-top:4px;">
          <div style="font-size:12px; color:#aaa;">Showing ${startIndex + 1} - ${Math.min(
              startIndex + REVIEW_PAGE_SIZE,
              total
            )} of ${total}</div>
          <div style="display:flex; gap:6px;">
            <button id="ytm-prev-page" class="ytm-spot-btn" style="padding:3px 10px; font-size:12px;" ${
              reviewPage === 0 ? "disabled style='opacity:0.4; cursor:default;'" : ""
            }>Previous</button>
            <span style="font-size:12px; align-self:center;">Page ${reviewPage + 1} of ${maxPages}</span>
            <button id="ytm-next-page" class="ytm-spot-btn" style="padding:3px 10px; font-size:12px;" ${
              reviewPage >= maxPages - 1 ? "disabled style='opacity:0.4; cursor:default;'" : ""
            }>Next</button>
          </div>
        </div>
      `
          : ""
      }
    `;

    document.getElementById("ytm-spot-back-home").onclick = () => {
      activeView = "home";
      renderView();
    };

    document.getElementById("ytm-spot-start-transfer").onclick = () => {
      const title = document.getElementById("ytm-dest-title")?.value?.trim() || currentJob.playlist_title;
      const privacy = document.getElementById("ytm-dest-privacy")?.value || "PRIVATE";
      executeTransfer(title, privacy);
    };

    const sortEl = document.getElementById("ytm-review-sort");
    if (sortEl) {
      sortEl.onchange = (e) => {
        reviewSortOrder = e.target.value;
        reviewPage = 0;
        renderReview(container);
      };
    }

    const prevBtn = document.getElementById("ytm-prev-page");
    if (prevBtn && reviewPage > 0) {
      prevBtn.onclick = () => {
        reviewPage -= 1;
        renderReview(container);
      };
    }

    const nextBtn = document.getElementById("ytm-next-page");
    if (nextBtn && reviewPage < maxPages - 1) {
      nextBtn.onclick = () => {
        reviewPage += 1;
        renderReview(container);
      };
    }

    container.querySelectorAll(".ytm-spot-skip-btn[data-idx]").forEach((btn) => {
      btn.onclick = () => {
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        if (currentJob.tracks[idx]) {
          currentJob.tracks[idx].status = currentJob.tracks[idx].status === "skipped" ? "included" : "skipped";
          renderReview(container);
        }
      };
    });
  }

  async function executeTransfer(playlistTitle, privacy) {
    if (!currentJob || isTransferActive) return;
    const epoch = ++workflowEpoch;
    const job = currentJob;
    activeView = "transferring";
    isTransferActive = true;
    updateNavButtonText();
    renderView();

    try {
      const validTracks = (job.tracks || [])
        .slice()
        .sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0))
        .filter((t) => t.status !== "skipped" && t.selected_candidate?.video_id);
      const videoIds = validTracks.map((t) => t.selected_candidate.video_id);

      if (!videoIds.length) {
        alert("No valid tracks to transfer.");
        activeView = "review";
        isTransferActive = false;
        updateNavButtonText();
        renderView();
        return;
      }

      logDebug(`creating destination playlist "${playlistTitle}" on YouTube Music`);
      const initialBatch = videoIds.slice(0, 50);
      const remainingBatch = videoIds.slice(50);

      const playlistId = await window.__ytmTransferAdapter.createPlaylist(
        playlistTitle,
        job.playlist_description || "Transferred via YouTube Music Desktop",
        privacy,
        initialBatch
      );
      if (epoch !== workflowEpoch || currentJob !== job) return;

      job.created_playlist_id = playlistId;
      logDebug(
        `playlist created id=${playlistId}, initial=${initialBatch.length}, remaining=${remainingBatch.length}`
      );

      let added = initialBatch.length;
      let failed = 0;

      if (remainingBatch.length) {
        const res = await window.__ytmTransferAdapter.addPlaylistItems(
          playlistId,
          remainingBatch,
          (current, total) => {
            if (epoch !== workflowEpoch || currentJob !== job) return;
            const totalDone = added + current;
            job.transferred_count = totalDone;
            const fill = document.getElementById("ytm-transfer-fill");
            const label = document.getElementById("ytm-transfer-label");
            const pct = Math.round((totalDone / videoIds.length) * 100);
            if (fill) fill.style.width = `${pct}%`;
            if (label)
              label.textContent = `Adding tracks: ${totalDone} of ${videoIds.length} (${pct}%)`;
            updateNavButtonText();
          }
        );
        if (epoch !== workflowEpoch || currentJob !== job) return;
        added += res.added;
        failed += res.failed;
      }

      job.transferred_count = added;
      job.failed_count = failed;
      logDebug(`transfer complete: ${added} added, ${failed} failed`);

      isTransferActive = false;
      activeView = "complete";
      updateNavButtonText();
      renderView();
    } catch (err) {
      if (epoch !== workflowEpoch || currentJob !== job) return;
      logDebug("transfer execution failed", err.message);
      alert(`Transfer failed: ${err.message}`);
      isTransferActive = false;
      activeView = "review";
      updateNavButtonText();
      renderView();
    }
  }

  function renderTransferring(container) {
    container.innerHTML = `
      <div style="text-align:center; padding:50px 20px;">
        <h3 style="margin-top:0;">Creating YouTube Music Playlist</h3>
        <div id="ytm-transfer-label" style="font-size:14px; color:#aaa; margin-bottom:8px;">Preparing batches...</div>
        <div class="ytm-spot-progress-bar">
          <div id="ytm-transfer-fill" class="ytm-spot-progress-fill"></div>
        </div>
        <div style="font-size:12px; color:#777; margin-top:14px;">Adding songs in safe batches of 25 to preserve order...</div>
      </div>
    `;
  }

  function renderComplete(container) {
    const pid = currentJob?.created_playlist_id;
    const added = currentJob?.transferred_count || 0;
    const failed = currentJob?.failed_count || 0;

    container.innerHTML = `
      <div style="text-align:center; padding:40px 20px;">
        <div style="font-size:18px; color:#2ecc71; margin-bottom:12px; font-weight:700;">Done</div>
        <h2 style="margin:0 0 8px 0; color:#2ecc71;">Transfer Complete!</h2>
        <div style="font-size:14px; color:#ccc; margin-bottom:24px;">
          Successfully added <strong>${added}</strong> songs to your YouTube Music library.
          ${failed > 0 ? `<br/><span style="color:#f1c40f;">(${failed} items could not be added)</span>` : ""}
        </div>

        <div style="display:flex; justify-content:center; gap:12px;">
          ${
            pid
              ? `<button id="ytm-spot-open-pl" class="ytm-spot-btn ytm-spot-btn-green">Open in YouTube Music</button>`
              : ""
          }
          <button id="ytm-spot-done-btn" class="ytm-spot-btn">Done</button>
        </div>
      </div>
    `;

    const openBtn = document.getElementById("ytm-spot-open-pl");
    if (openBtn && pid) {
      openBtn.onclick = () => {
        closeModal();
        location.href = `https://music.youtube.com/playlist?list=${pid}`;
      };
    }

    const doneBtn = document.getElementById("ytm-spot-done-btn");
    if (doneBtn) {
      doneBtn.onclick = () => {
        closeModal();
        activeView = "home";
        currentJob = null;
      };
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function safeSpotifyImageUrl(value) {
    if (!value) return "";
    try {
      const parsed = new URL(String(value));
      if (parsed.protocol !== "https:") return "";
      const host = parsed.hostname.toLowerCase();
      if (host === "scdn.co" || host.endsWith(".scdn.co") || host === "spotifycdn.com" || host.endsWith(".spotifycdn.com")) {
        return parsed.href;
      }
    } catch {}
    return "";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHeaderButton);
  } else {
    initHeaderButton();
  }
})();
