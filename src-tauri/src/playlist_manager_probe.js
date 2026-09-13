(() => {
  // playlist manager interface
  if (typeof location === "object" && location.hostname && location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytmPlaylistManager) return;

  const ROW_PAGE_SIZE = 80;
  const BUTTON_ID = "ytm-playlist-manager-button";
  const DIALOG_ID = "ytm-playlist-manager-dialog";
  const STYLE_ID = "ytm-playlist-manager-style";
  const SORT_OPTIONS = [
    ["original-asc", "Original order"],
    ["original-desc", "Original order (reverse)"],
    ["title-asc", "Title (A–Z)"],
    ["title-desc", "Title (Z–A)"],
    ["artist-asc", "Artist (A–Z)"],
    ["artist-desc", "Artist (Z–A)"],
    ["album-asc", "Album (A–Z)"],
    ["album-desc", "Album (Z–A)"],
    ["duration-asc", "Duration (shortest)"],
    ["duration-desc", "Duration (longest)"],
  ];

  const state = {
    playlistId: "",
    playlistTitle: "",
    tracks: [],
    selected: new Set(),
    duplicates: new Set(),
    unavailable: new Set(),
    duplicateCandidates: new Set(),
    unavailableCandidates: new Set(),
    plan: null,
    planning: false,
    planNonce: 0,
    query: "",
    filter: "all",
    anchorIndex: null,
    orderCache: null,
    position: 1,
    sort: "original-asc",
    operation: "remove",
    destination: "",
    page: 0,
    total: 0,
    loaded: 0,
    busy: false,
    snapshotFingerprint: "",
    sourceItems: [],
    sourceEditable: false,
    generation: 0,
    dialog: null,
    previousFocus: null,
    destinationTimer: null,
    loadController: null,
    planController: null,
    mutationController: null,
    destinationController: null,
    destinations: [],
    destinationLoading: false,
    confirmationPlan: null,
    destinationCache: new Map(),
  };

  function isPlaylistPage(url = location) {
    let parsed = url;
    try {
      if (!parsed?.searchParams) parsed = new URL(parsed?.href || String(parsed), location.href);
    } catch { return false; }
    return parsed?.hostname === "music.youtube.com" && parsed?.pathname === "/playlist" && Boolean(parsed?.searchParams?.get("list"));
  }

  function text(value) {
    return value == null ? "" : String(value).trim();
  }

  function firstText(...values) {
    return values.map(text).find(Boolean) || "";
  }

  function playlistIdFromInput(value) {
    const input = text(value);
    if (!input) return "";
    try {
      const parsed = new URL(input, "https://music.youtube.com/");
      if (parsed.hostname === "music.youtube.com" && parsed.pathname === "/playlist") {
        return text(parsed.searchParams.get("list"));
      }
    } catch { /* fall through to the plain-id check */ }
    return /^[A-Za-z0-9_-]{1,128}$/.test(input.replace(/^VL/, "")) ? input.replace(/^VL/, "") : "";
  }

  function sortFieldForData(field) {
    if (field === "artist") return "artists";
    if (field === "original") return "originalIndex";
    if (field === "duration") return "durationSeconds";
    return field;
  }

  function artistsText(value) {
    if (Array.isArray(value)) {
      return value.map((item) => typeof item === "string" ? item : firstText(item?.name, item?.title)).filter(Boolean).join(", ");
    }
    return text(value);
  }

  function trackVideoId(track) {
    return firstText(track?.videoId, track?.video_id, track?.video?.videoId, track?.id);
  }

  // missing metadata remains available
  function isExplicitlyUnavailable(track) {
    if (track?.isUnavailable === true || track?.is_unavailable === true || track?.unavailable === true) return true;
    if (track?.isAvailable === false || track?.is_available === false || track?.available === false) return true;
    if (track?.isPlayable === false || track?.is_playable === false || track?.playable === false) return true;
    const status = firstText(track?.status, track?.availability).toUpperCase().replace(/[\s-]+/g, "_");
    return ["UNAVAILABLE", "NOT_PLAYABLE", "REMOVED", "PRIVATE"].includes(status);
  }

  function durationSeconds(track) {
    const value = Number(track?.durationSeconds ?? track?.duration_seconds ?? track?.duration ?? 0);
    if (Number.isFinite(value) && value > 0) return value;
    const ms = Number(track?.durationMs ?? track?.duration_ms ?? 0);
    return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  }

  function normalizeTrack(raw, index) {
    const track = raw && typeof raw === "object" ? raw : {};
    return {
      raw,
      originalIndex: index,
      occurrenceId: firstText(track.occurrenceId, track.occurrence_id),
      videoId: trackVideoId(track),
      setVideoId: firstText(track.setVideoId, track.set_video_id, track.entryId, track.entry_id),
      title: firstText(track.title, track.name, track.video?.title) || "Untitled video",
      artist: artistsText(track.artist ?? track.artists ?? track.author),
      album: firstText(track.album, track.albumTitle),
      thumbnail: /^https:\/\//i.test(track.thumbnail || "") ? track.thumbnail : "",
      durationSeconds: durationSeconds(track),
      unavailable: isExplicitlyUnavailable(track),
    };
  }

  function compareValue(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base", numeric: true });
  }

  function sortTracks(tracks, sort = "original-asc") {
    const [field, direction] = String(sort).split("-");
    const sign = direction === "desc" ? -1 : 1;
    return tracks.slice().sort((left, right) => {
      let result = 0;
      if (field === "title") result = compareValue(left.title, right.title);
      else if (field === "artist") result = compareValue(left.artist, right.artist);
      else if (field === "album") result = compareValue(left.album, right.album);
      else if (field === "duration") result = left.durationSeconds - right.durationSeconds;
      else result = left.originalIndex - right.originalIndex;
      return result !== 0 ? result * sign : left.originalIndex - right.originalIndex;
    });
  }

  function duplicateOccurrences(tracks) {
    const first = new Map();
    const duplicates = new Set();
    tracks.forEach((track, index) => {
      if (!track.videoId) return;
      if (first.has(track.videoId)) duplicates.add(index);
      else first.set(track.videoId, index);
    });
    return duplicates;
  }

  function summarizeSelection(tracks, selected, duplicates, unavailable) {
    const indices = new Set(selected);
    duplicates.forEach((index) => indices.add(index));
    unavailable.forEach((index) => indices.add(index));
    const ids = [...indices].map((index) => tracks[index]?.videoId).filter(Boolean);
    return {
      occurrenceCount: indices.size,
      videoCount: new Set(ids).size,
      duplicateCount: duplicates.size,
      unavailableCount: unavailable.size,
      videoIds: [...new Set(ids)],
    };
  }

  const publicApi = {
    isPlaylistPage,
    playlistIdFromInput,
    isExplicitlyUnavailable,
    normalizeTrack,
    sortTracks,
    duplicateOccurrences,
    summarizeSelection,
  };
  window.__ytmPlaylistManager = publicApi;

  function adapter() {
    return window.__ytmPlaylistManagerData || null;
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[character]));
  }

  function formatDuration(seconds) {
    if (!seconds) return "—";
    const rounded = Math.max(0, Math.round(seconds));
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
  }

  const ICONS = {
    music: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3z",
    manage: "M3 5h12v2H3zm0 6h8v2H3zm0 6h8v2H3zm15-7 3 3-7 7h-3v-3zm1.4-1.4 1-1a1 1 0 0 1 1.4 0l1.2 1.2a1 1 0 0 1 0 1.4l-1 1z",
    search: "M10 3a7 7 0 1 0 4.9 12L21 21l1-1-6.1-6.1A7 7 0 0 0 10 3m0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10",
    close: "m6 5 6 6 6-6 1 1-6 6 6 6-1 1-6-6-6 6-1-1 6-6-6-6z",
    refresh: "M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h8V3z",
    check: "m9 16-5-5-1.4 1.4L9 18.8 22 5.8 20.6 4.4z",
    chevronLeft: "m15 6-6 6 6 6-1.4 1.4L6.2 12l7.4-7.4z",
    chevronRight: "m9 6 6 6-6 6 1.4 1.4 7.4-7.4-7.4-7.4z",
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="${ICONS[name] || ICONS.manage}"/></svg>`;
  }

  function addStyles() {
    if (!document.head || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ytm-pm-entry-host { display:flex !important; align-items:center; justify-content:flex-start; flex-wrap:wrap; gap:12px; }
      #${BUTTON_ID} { display:inline-flex; align-items:center; gap:8px; flex:none; height:36px; padding:0 16px; border:1px solid #ffffff30; border-radius:24px; background:#ffffff12; color:#fff; font:500 14px Roboto,Arial,sans-serif; cursor:pointer; }
      #${BUTTON_ID}:hover { background:#ffffff25; }
      #${DIALOG_ID}, #${DIALOG_ID} * { box-sizing:border-box; }
      body.ytm-playlist-manager-open { overflow:hidden !important; }
      #${DIALOG_ID} { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; padding:24px; background:rgba(0,0,0,.65); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); color:#f1f1f1; font:400 14px/1.45 Roboto,Arial,sans-serif; color-scheme:dark; }
      #${DIALOG_ID} .ytm-pm-card { width:min(1080px,100%); height:min(900px,calc(100dvh - 48px)); display:flex; flex-direction:column; overflow:hidden; border:1px solid #ffffff25; border-radius:16px; background:var(--ytmusic-dialog-background-color,#181818); box-shadow:0 24px 80px #0009; }
      #${DIALOG_ID} .ytm-pm-content { display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
      #${DIALOG_ID} .ytm-pm-content > :not(.ytm-pm-list), #${DIALOG_ID} .ytm-pm-header, #${DIALOG_ID} .ytm-pm-footer { flex-shrink:0; }
      #${DIALOG_ID} .ytm-pm-header { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:20px 24px 16px; }
      #${DIALOG_ID} .ytm-pm-title { min-width:0; }
      #${DIALOG_ID} .ytm-pm-title strong { display:block; font-size:22px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #${DIALOG_ID} .ytm-pm-muted { color:#aaa; font-size:12px; }
      #${DIALOG_ID} button { font:500 13px Roboto,Arial,sans-serif; cursor:pointer; }
      #${DIALOG_ID} .ytm-pm-close { width:36px; height:36px; border:0; border-radius:50%; background:transparent; color:#eee; font-size:24px; }
      #${DIALOG_ID} .ytm-pm-secondary { min-height:34px; padding:0 12px; border:1px solid #ffffff25; border-radius:20px; background:transparent; color:#eee; }
      #${DIALOG_ID} button:hover:not(:disabled) { background:#ffffff20; }
      #${DIALOG_ID} .ytm-pm-toolbar { display:flex; align-items:flex-end; gap:12px; padding:0 24px 14px; }
      #${DIALOG_ID} .ytm-pm-input, #${DIALOG_ID} select { min-height:40px; min-width:0; padding:0 12px; border:1px solid #ffffff28; border-radius:8px; background:#282828; color:#f1f1f1; color-scheme:dark; font:inherit; }
      #${DIALOG_ID} option { background:#282828; color:#f1f1f1; }
      #${DIALOG_ID} .ytm-pm-search { flex:1; }
      #${DIALOG_ID} .ytm-pm-selection { display:flex; align-items:center; flex-wrap:wrap; gap:8px 16px; padding:12px 24px; border-top:1px solid #ffffff15; border-bottom:1px solid #ffffff15; background:#202020; }
      #${DIALOG_ID} .ytm-pm-selection label { display:flex; align-items:center; gap:6px; cursor:pointer; }
      #${DIALOG_ID} input[type=checkbox] { width:17px; height:17px; accent-color:#fff; flex:none; }
      #${DIALOG_ID} .ytm-pm-status:empty { display:none; }
      #${DIALOG_ID} .ytm-pm-status { padding:10px 24px; min-height:38px; color:#aaa; font-size:12px; }
      #${DIALOG_ID} .ytm-pm-list { flex:1; min-height:100px; overflow:auto; padding:0 24px; overscroll-behavior:contain; }
      #${DIALOG_ID} .ytm-pm-row { display:grid; grid-template-columns:20px 30px minmax(0,1fr) minmax(100px,.55fr) 48px 80px; align-items:center; gap:12px; min-height:60px; padding:6px 8px; border-radius:6px; cursor:pointer; }
      #${DIALOG_ID} .ytm-pm-row:hover { background:#ffffff0a; }
      #${DIALOG_ID} .ytm-pm-row:has(input:checked) { background:#ffffff16; }
      #${DIALOG_ID} .ytm-pm-row-title { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-weight:500; }
      #${DIALOG_ID} .ytm-pm-row-sub { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:#aaa; font-size:12px; }
      #${DIALOG_ID} .ytm-pm-warning { color:#f9ab00; }
      #${DIALOG_ID} .ytm-pm-pages { display:flex; align-items:center; justify-content:center; gap:16px; padding:10px 24px; }
      #${DIALOG_ID} .ytm-pm-workflow { border-top:1px solid #ffffff20; padding:16px 24px; background:#202020; }
      #${DIALOG_ID} .ytm-pm-action-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
      #${DIALOG_ID} .ytm-pm-action-row label { display:flex; align-items:center; gap:10px; color:#aaa; }
      #${DIALOG_ID} .ytm-pm-destination { display:flex; flex:1; min-width:200px; gap:8px; }
      #${DIALOG_ID} [data-role=destination] { flex:1; width:100%; }
      #${DIALOG_ID} .ytm-pm-preview { padding:12px 0 0; color:#aaa; font-size:13px; }
      #${DIALOG_ID} .ytm-pm-preview strong { color:#fff; }
      #${DIALOG_ID} .ytm-pm-footer { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 24px; border-top:1px solid #ffffff15; }
      #${DIALOG_ID} .ytm-pm-actions { display:flex; gap:10px; margin-left:auto; }
      #${DIALOG_ID} .ytm-pm-primary { min-height:38px; border:0; border-radius:24px; background:#f1f1f1; color:#111; padding:0 20px; }
      #${DIALOG_ID} .ytm-pm-primary:hover:not(:disabled) { background:#ddd; }
      #${DIALOG_ID} button:disabled { opacity:.4; cursor:default; }
      #${DIALOG_ID} .ytm-pm-search-field { min-width:0; display:flex; flex:1; align-items:center; gap:10px; padding-left:12px; background:#282828; border:1px solid #ffffff28; border-radius:8px; color:#aaa; }
      #${DIALOG_ID} .ytm-pm-search-field input { border:0; background:transparent; width:100%; }
      #${DIALOG_ID} .ytm-pm-control { display:flex; flex-direction:column; gap:6px; min-width:0; }
      #${DIALOG_ID} .ytm-pm-control > span { font-size:12px; color:#aaa; }
      #${DIALOG_ID} .ytm-pm-selection-count { margin-left:auto; font-size:12px; color:#aaa; }
      #${DIALOG_ID} .ytm-pm-close, #${DIALOG_ID} .ytm-pm-pages button { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
      #${DIALOG_ID} .ytm-pm-destination { flex-direction:column; }
      #${DIALOG_ID} .ytm-pm-destination-controls { display:flex; gap:8px; }
      #${DIALOG_ID} .ytm-pm-destination-filter { width:42%; min-width:120px; }
      #${DIALOG_ID} .ytm-pm-action-row { align-items:flex-end; }
      #${DIALOG_ID} .ytm-pm-confirmation { color:#eee; }
      #${DIALOG_ID} .ytm-pm-row { position:relative; }
      #${DIALOG_ID} .ytm-pm-list { scrollbar-width:thin; scrollbar-color:#777 transparent; }
      #${DIALOG_ID} .ytm-pm-surface-label { font-size:12px; color:#aaa; }
      #${DIALOG_ID} .ytm-pm-filters { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:0 24px 14px; }
      #${DIALOG_ID} .ytm-pm-filters .ytm-pm-muted { margin-left:auto; }
      #${DIALOG_ID} .ytm-pm-chip { min-height:32px; padding:0 12px; border:0; border-radius:8px; background:#ffffff14; color:#eee; }
      #${DIALOG_ID} .ytm-pm-chip[aria-pressed=true] { background:#f1f1f1; color:#111; }
      #${DIALOG_ID} .ytm-pm-columns { display:grid; grid-template-columns:20px 30px minmax(0,1fr) minmax(100px,.55fr) 48px 80px; gap:12px; padding:0 32px 8px; color:#aaa; font-size:12px; border-bottom:1px solid #ffffff12; }
      #${DIALOG_ID} .ytm-pm-number { font-size:12px; color:#888; font-variant-numeric:tabular-nums; }
      #${DIALOG_ID} .ytm-pm-duration { font-size:12px; color:#aaa; font-variant-numeric:tabular-nums; }
      #${DIALOG_ID} .ytm-pm-badge { font-size:11px; padding:3px 6px; background:#ffffff10; border-radius:4px; }
      #${DIALOG_ID} .ytm-pm-selection label { min-height:28px; font-size:12px; }
      #${DIALOG_ID} .ytm-pm-position { flex:1; }
      #${DIALOG_ID} .ytm-pm-position input { width:100px; }
      #${DIALOG_ID} .ytm-pm-action-row .ytm-pm-control { align-items:flex-start; }
      #${DIALOG_ID} .ytm-pm-confirmation { max-width:620px; }
      @media(max-height:650px) { #${DIALOG_ID} { padding:8px; } #${DIALOG_ID} .ytm-pm-card { height:calc(100dvh - 16px); } #${DIALOG_ID} .ytm-pm-content { overflow:auto; } #${DIALOG_ID} .ytm-pm-list { flex:none; height:220px; } }
      @media(prefers-reduced-transparency:reduce) { #${DIALOG_ID} { backdrop-filter:none; background:#000e; } }
      #${DIALOG_ID} [hidden] { display:none !important; }
      #${BUTTON_ID}:focus-visible, #${DIALOG_ID} :focus-visible { outline:2px solid #f1f1f1; outline-offset:3px; }
      @media(max-width:640px) { #${DIALOG_ID} { padding:0; } #${DIALOG_ID} .ytm-pm-card { height:100dvh; border-radius:0; } #${DIALOG_ID} .ytm-pm-toolbar { flex-wrap:wrap; } #${DIALOG_ID} .ytm-pm-search-field { flex-basis:100%; } #${DIALOG_ID} .ytm-pm-content { overflow:auto; } #${DIALOG_ID} .ytm-pm-list { flex:none; height:280px; } #${DIALOG_ID} .ytm-pm-row, #${DIALOG_ID} .ytm-pm-columns { grid-template-columns:20px 24px minmax(0,1fr) 42px; gap:8px; } #${DIALOG_ID} .ytm-pm-album, #${DIALOG_ID} .ytm-pm-row-state { display:none; } #${DIALOG_ID} .ytm-pm-row > :last-child { display:none; } #${DIALOG_ID} .ytm-pm-footer { flex-wrap:wrap; } #${DIALOG_ID} .ytm-pm-footer .ytm-pm-muted { flex-basis:100%; } #${DIALOG_ID} .ytm-pm-filters .ytm-pm-muted { display:none; } #${DIALOG_ID} .ytm-pm-selection { gap:8px; } #${DIALOG_ID} .ytm-pm-workflow { padding:10px 16px; } #${DIALOG_ID} .ytm-pm-destination { min-width:180px; } }
    `;
    style.textContent += `
      .ytm-pm-entry-toolbar:empty { display:none; }
      .ytm-pm-entry-toolbar { display:flex; align-items:center; justify-content:flex-end; padding:8px 0 16px; }
      #${DIALOG_ID} .ytm-pm-song { display:flex; align-items:center; gap:12px; min-width:0; }
      #${DIALOG_ID} .ytm-pm-song-text { min-width:0; }
      #${DIALOG_ID} .ytm-pm-art { display:grid; place-items:center; width:40px; height:40px; flex:none; background:#ffffff0a; border-radius:4px; overflow:hidden; color:#777; }
      #${DIALOG_ID} .ytm-pm-art img { width:100%; height:100%; object-fit:cover; }
      #${DIALOG_ID} .ytm-pm-card { background:linear-gradient(145deg,#242424,#181818 42%); }
      #${DIALOG_ID} .ytm-pm-header { padding:24px 24px 20px; }
      #${DIALOG_ID} .ytm-pm-toolbar { align-items:center; }
      #${DIALOG_ID} .ytm-pm-toolbar .ytm-pm-control > span { display:none; }
      #${DIALOG_ID} .ytm-pm-search-field { border:0; border-radius:24px; }
      #${DIALOG_ID} .ytm-pm-search-field input { min-height:44px; }
      #${DIALOG_ID} .ytm-pm-selection { padding:8px 24px; background:transparent; gap:8px 12px; }
      #${DIALOG_ID} .ytm-pm-selection label:has(input:disabled) { display:none; }
      #${DIALOG_ID} .ytm-pm-selection .ytm-pm-secondary { border-color:transparent; }
      #${DIALOG_ID} .ytm-pm-workflow { background:#ffffff04; padding:14px 24px; }
      #${DIALOG_ID} .ytm-pm-pages { padding:6px 24px; font-size:12px; }
      #${DIALOG_ID} .ytm-pm-pages button { border:0; }
      #${DIALOG_ID} .ytm-pm-status { background:#ffffff06; border-left:3px solid currentColor; margin:8px 24px; padding:10px 12px; border-radius:4px; }
      #${DIALOG_ID} .ytm-pm-status:empty { margin:0; }
      #${DIALOG_ID} .ytm-pm-destination-filter { width:30%; }
      #${DIALOG_ID} .ytm-pm-footer { background:#181818; }
    `;
    document.head.appendChild(style);
  }

  function playlistIdFromLocation() {
    try { return new URL(location.href).searchParams.get("list") || ""; } catch { return ""; }
  }

  function hostForButton() {
    const visible = (host) => host && !host.hidden && host.getAttribute?.("aria-hidden") !== "true" && host.style?.display !== "none" && (!host.getClientRects || host.getClientRects().length > 0);
    const sortButtons = document.querySelectorAll("ytmusic-sort-filter-button-renderer");
    for (const sort of sortButtons) {
      if (visible(sort) && sort.closest?.("ytmusic-browse-response") && !sort.parentNode.querySelector?.("ytmusic-responsive-list-item-renderer")) return sort.parentNode;
    }
    const shelf = [...document.querySelectorAll("ytmusic-browse-response ytmusic-playlist-shelf-renderer")].find(visible);
    if (!shelf) return null;
    let toolbar = shelf.querySelector(":scope > .ytm-pm-entry-toolbar");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "ytm-pm-entry-toolbar";
      shelf.prepend(toolbar);
    }
    return toolbar;
  }

  function ensureButton() {
    addStyles();
    if (!isPlaylistPage()) {
      const existing = document.getElementById(BUTTON_ID);
      existing?.parentNode?.classList?.remove("ytm-pm-entry-host");
      existing?.remove();
      if (state.dialog) closeDialog();
      return;
    }
    if (state.dialog && state.playlistId !== playlistIdFromLocation()) closeDialog();
    const host = hostForButton();
    if (!host) return;
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
      button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.innerHTML = `${icon("manage")}<span>Manage playlist</span>`;
      button.setAttribute("aria-label", "Manage this playlist");
      button.addEventListener("click", openDialog);
    }
    if (button.parentNode !== host) {
      button.parentNode?.classList?.remove("ytm-pm-entry-host");
      host.appendChild(button);
    }
    if (!host.querySelector?.("ytmusic-responsive-list-item-renderer, ytmusic-playlist-shelf-renderer")) host.classList?.add("ytm-pm-entry-host");
  }

  function getFilteredTracks() {
    const needle = state.query.trim().toLocaleLowerCase();
    const selected = selectionIndices();
    return orderedTracks().filter((track) => {
      const index = track.originalIndex;
      if (state.filter === "duplicates" && !state.duplicateCandidates.has(index)) return false;
      if (state.filter === "unavailable" && !track.unavailable) return false;
      if (state.filter === "selected" && !selected.has(index)) return false;
      return !needle || [track.title, track.artist, track.album].join(" ").toLocaleLowerCase().includes(needle);
    });
  }

  function selectionIndices() {
    return new Set([...state.selected, ...state.duplicates, ...state.unavailable]);
  }

  // reuse sorted playlist snapshots
  function orderedTracks() {
    if (state.orderCache?.tracks === state.tracks && state.orderCache.sort === state.sort) return state.orderCache.items;
    let items = sortTracks(state.tracks, state.sort);
    const source = adapter();
    if (source?.sortItems && state.sourceItems.length) {
      const [field, direction] = state.sort.split("-");
      const byOccurrence = new Map(state.tracks.map((track) => [track.occurrenceId, track]));
      const sorted = source.sortItems(state.sourceItems, sortFieldForData(field), direction);
      if (sorted.every((item) => byOccurrence.has(item.occurrenceId))) items = sorted.map((item) => byOccurrence.get(item.occurrenceId));
    }
    state.orderCache = { tracks: state.tracks, sort: state.sort, items };
    return items;
  }

  function selectedSummary() {
    const summary = summarizeSelection(state.tracks, state.selected, state.duplicates, state.unavailable);
    const selected = selectionIndices();
    const ordered = orderedTracks().filter((track) => selected.has(track.originalIndex));
    summary.items = ordered.map((track) => state.sourceItems[track.originalIndex]).filter(Boolean);
    summary.unaddressableCount = summary.items.filter((item) => !item.setVideoId).length;
    summary.videoIds = [...new Set(ordered.map((track) => track.videoId))];
    return summary;
  }

  function renderRows() {
    const list = state.dialog?.querySelector("[data-role='list']");
    if (!list) return;
    const filtered = getFilteredTracks();
    const maxPage = Math.max(0, Math.ceil(filtered.length / ROW_PAGE_SIZE) - 1);
    state.page = Math.min(state.page, maxPage);
    const rows = filtered.slice(state.page * ROW_PAGE_SIZE, (state.page + 1) * ROW_PAGE_SIZE);
    list.innerHTML = rows.map((track) => {
      const index = track.originalIndex;
      const warning = track.unavailable ? '<span class="ytm-pm-warning">Unavailable</span>' : state.duplicateCandidates.has(index) ? '<span class="ytm-pm-badge">Extra copy</span>' : "";
      const checked = state.selected.has(index) || state.duplicates.has(index) || state.unavailable.has(index);
      return `<label class="ytm-pm-row"><input type="checkbox" data-index="${index}" ${checked ? "checked" : ""} aria-label="Select ${escapeHtml(track.title)}" /><span class="ytm-pm-number" title="Playlist position">${index + 1}</span><span class="ytm-pm-song"><span class="ytm-pm-art">${track.thumbnail ? `<img src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon("music")}</span><span class="ytm-pm-song-text"><span class="ytm-pm-row-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</span><span class="ytm-pm-row-sub">${escapeHtml(track.artist || "Unknown artist")}</span></span></span><span class="ytm-pm-row-sub ytm-pm-album" title="${escapeHtml(track.album)}">${escapeHtml(track.album || "—")}</span><span class="ytm-pm-duration">${formatDuration(track.durationSeconds)}</span><span class="ytm-pm-row-sub ytm-pm-row-state">${warning}</span></label>`;
    }).join("") || `<div class="ytm-pm-muted" style="padding:28px 0;text-align:center;">No matching tracks.</div>`;
    list.querySelectorAll("input[data-index]").forEach((input) => {
      let range = false;
      input.addEventListener("click", (event) => { range = event.shiftKey; });
      input.addEventListener("change", () => {
      const index = Number(input.dataset.index);
      const start = filtered.findIndex((track) => track.originalIndex === state.anchorIndex);
      const end = filtered.findIndex((track) => track.originalIndex === index);
      const indices = range && start >= 0 ? filtered.slice(Math.min(start, end), Math.max(start, end) + 1).map((track) => track.originalIndex) : [index];
      for (const selectedIndex of indices) {
        if (input.checked) state.selected.add(selectedIndex);
        else { state.selected.delete(selectedIndex); state.duplicates.delete(selectedIndex); state.unavailable.delete(selectedIndex); }
      }
      state.anchorIndex = index;
      const focusedIndex = index;
      if (range || state.filter === "selected") {
        const scroll = list.scrollTop;
        renderRows(); list.scrollTop = scroll;
        list.querySelector(`input[data-index="${focusedIndex}"]`)?.focus();
      }
      range = false;
      state.plan = null;
      syncSelectionControls();
      renderPreview();
      requestPlan();
      });
    });
    const pageLabel = state.dialog.querySelector("[data-role='page-label']");
    const pageCount = Math.max(1, Math.ceil(filtered.length / ROW_PAGE_SIZE));
    if (pageLabel) pageLabel.textContent = `${filtered.length ? state.page * ROW_PAGE_SIZE + 1 : 0}–${Math.min((state.page + 1) * ROW_PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()} · Page ${state.page + 1} of ${pageCount}`;
    const previous = state.dialog.querySelector("[data-action='previous']");
    const next = state.dialog.querySelector("[data-action='next']");
    if (previous) { previous.disabled = state.page === 0; previous.hidden = pageCount === 1; }
    if (next) { next.disabled = state.page >= pageCount - 1; next.hidden = pageCount === 1; }
    syncSelectionControls();
  }

  function syncSelectionControls() {
    if (!state.dialog) return;
    const duplicateControl = state.dialog.querySelector("[data-role='duplicates']");
    const unavailableControl = state.dialog.querySelector("[data-role='unavailable']");
    const selected = new Set([...state.selected, ...state.duplicates, ...state.unavailable]);
    for (const [control, candidates] of [[duplicateControl, state.duplicateCandidates], [unavailableControl, state.unavailableCandidates]]) {
      if (!control) continue;
      const count = [...candidates].filter((index) => selected.has(index)).length;
      control.checked = candidates.size > 0 && count === candidates.size;
      control.indeterminate = count > 0 && count < candidates.size;
      control.disabled = state.busy || candidates.size === 0;
    }
    const selectAll = state.dialog.querySelector("[data-action='select-all']");
    if (selectAll) {
      selectAll.textContent = "Select all songs";
      selectAll.disabled = state.busy || state.tracks.length === 0 || selected.size === state.tracks.length;
    }
    const clear = state.dialog.querySelector("[data-action='clear']");
    if (clear) clear.disabled = state.busy || selected.size === 0;
    const refresh = state.dialog.querySelector("[data-action='refresh-destinations']");
    if (refresh) refresh.disabled = state.busy || state.destinationLoading;
    const filtered = getFilteredTracks();
    const matching = state.dialog.querySelector("[data-action='select-matches']");
    if (matching) {
      matching.hidden = !state.query.trim() && state.filter === "all";
      matching.textContent = `Select results (${filtered.length})`;
      matching.disabled = state.busy || filtered.every((track) => selected.has(track.originalIndex));
    }
    const counts = { all: state.tracks.length, duplicates: state.duplicateCandidates.size, unavailable: state.unavailableCandidates.size, selected: selected.size };
    const labels = { all: "All songs", duplicates: "Duplicates", unavailable: "Unavailable", selected: "Selected" };
    state.dialog.querySelectorAll("[data-filter]").forEach((button) => {
      button.textContent = `${labels[button.dataset.filter]} ${counts[button.dataset.filter]}`;
      button.setAttribute("aria-pressed", String(state.filter === button.dataset.filter));
      button.disabled = state.busy;
    });
    const duplicateLabel = state.dialog.querySelector("[data-role='duplicate-label']");
    if (duplicateLabel) duplicateLabel.textContent = `Select extra copies (${state.duplicateCandidates.size})`;
    const unavailableLabel = state.dialog.querySelector("[data-role='unavailable-label']");
    if (unavailableLabel) unavailableLabel.textContent = `Select unavailable (${state.unavailableCandidates.size})`;
    const hint = state.dialog.querySelector("[data-role='filter-hint']");
    if (hint) hint.textContent = state.filter === "duplicates" ? "Same video only · first copy is kept" : state.filter === "unavailable" ? "Only songs marked unavailable by YouTube Music" : "Shift-click to select a range";
    const positionGroup = state.dialog.querySelector("[data-role='position-group']");
    if (positionGroup) positionGroup.hidden = state.operation !== "position";
    const position = state.dialog.querySelector("[data-role='position']");
    const maxPosition = Math.max(1, state.tracks.length - selected.size + 1);
    if (position) position.max = String(maxPosition);
    const positionHint = state.dialog.querySelector("[data-role='position-hint']");
    if (positionHint) positionHint.textContent = `1 = top · ${maxPosition} = end · keeps original relative order`;
    const destination = state.dialog.querySelector("[data-role='destination']");
    if (destination) {
      const enabled = isTransfer();
      destination.disabled = state.busy || !enabled;
      destination.style.display = enabled ? "" : "none";
      const group = state.dialog.querySelector("[data-role='destination-group']");
      if (group) group.hidden = !enabled;
    }
  }

  function isTransfer() { return state.operation === "copy" || state.operation === "move"; }
  function isSourceEdit() { return !isTransfer(); }

  function renderPreview() {
    if (!state.dialog) return;
    const summary = state.operation === "sort"
      ? { occurrenceCount: state.tracks.length, videoCount: state.tracks.length, duplicateCount: 0, unavailableCount: 0, unaddressableCount: state.sourceItems.filter((item) => !item?.setVideoId).length, videoIds: state.tracks.map((track) => track.videoId).filter(Boolean), items: state.sourceItems }
      : selectedSummary();
    const preview = state.dialog.querySelector("[data-role='preview']");
    const plannedCount = state.plan && Number.isFinite(Number(state.plan.acceptedCount)) ? Number(state.plan.acceptedCount) : summary.videoCount;
    const existingCount = state.plan?.blocked?.filter((item) => item.reason === "already in destination").length || 0;
    const rejectedCount = state.plan && Number.isFinite(Number(state.plan.rejectedCount)) ? Number(state.plan.rejectedCount) : 0;
    const addressWarning = summary.unaddressableCount && (isSourceEdit()) ? `; ${summary.unaddressableCount} need a refreshed playlist snapshot` : "";
    const snapshotWarning = !state.snapshotFingerprint && summary.videoCount ? "; refresh required before applying" : "";
    if (preview) {
      const action = {copy: "copy", move: "move", remove: "remove", position: "reposition"}[state.operation];
      const selectedIndices = selectionIndices();
      const selectedCount = selectedIndices.size;
      const hiddenCount = selectedCount - getFilteredTracks().filter((track) => selectedIndices.has(track.originalIndex)).length;
      const scope = hiddenCount > 0 ? ` Includes ${hiddenCount} selected outside this view.` : "";
      preview.innerHTML = state.operation === "sort"
        ? `Save this order for <strong>${summary.occurrenceCount}</strong> songs.${state.query || state.filter !== "all" ? " Applies to the entire playlist, including hidden songs." : ""} ${state.plan ? `${plannedCount} position changes.` : ""}${addressWarning}${snapshotWarning}`
        : !selectedCount ? "Select songs above, then choose an action. Nothing changes until you confirm."
        : state.planning ? `Preparing ${action} for ${selectedCount} selected songs…`
        : !state.plan ? isTransfer() && !state.destination ? `Choose a destination for <strong>${selectedCount}</strong> selected songs.${scope}` : `Review your action settings for <strong>${selectedCount}</strong> selected songs.${scope}`
        : `Ready to ${action} <strong>${state.operation === "position" ? selectedCount : plannedCount}</strong> ${selectedCount === 1 ? "song" : "songs"}.${existingCount ? ` ${existingCount} of ${selectedCount} already in the destination; skipped.` : ""}${rejectedCount > existingCount ? ` ${rejectedCount - existingCount} skipped: unavailable, repeated selection, or missing entry information.` : ""}${scope}${addressWarning}${snapshotWarning}`;
    }
    const apply = state.dialog.querySelector("[data-action='apply']");
    if (apply) apply.textContent = state.busy ? "Saving…" : state.plan && state.confirmationPlan === state.plan ? ({ copy: "Confirm copy", move: "Confirm move", remove: "Confirm removal", sort: "Confirm order", position: "Confirm position" }[state.operation]) : "Review changes";
    if (apply) apply.disabled = state.busy || state.planning || summary.videoCount === 0 || !state.snapshotFingerprint || !state.plan || ((isSourceEdit()) && summary.unaddressableCount > 0) || (isTransfer() && !state.destination) || state.plan?.acceptedCount === 0;
    const count = state.dialog.querySelector("[data-role='selection-count']");
    if (count) count.textContent = `${selectionIndices().size.toLocaleString()} selected`;
    const confirmation = state.dialog.querySelector("[data-role='confirmation']");
    if (confirmation && (!state.plan || state.confirmationPlan !== state.plan)) confirmation.textContent = state.planning ? "Checking this change…" : "Changes are saved only when you confirm.";
    state.dialog.querySelectorAll("input, select, [data-action='select-all'], [data-action='clear']").forEach((control) => { control.disabled = state.busy; });
    syncSelectionControls();
  }

  async function requestPlan(preserveStatus = false) {
    if (!state.dialog) return;
    const source = adapter();
    const summary = selectedSummary();
    const nonce = ++state.planNonce;
    state.planController?.abort?.();
    state.planController = typeof AbortController === "function" ? new AbortController() : null;
    const signal = state.planController?.signal;
    state.plan = null;
    state.confirmationPlan = null;
    state.planning = false;
    if (!source || !state.snapshotFingerprint || (state.operation !== "sort" && !summary.videoIds.length) || (isTransfer() && !state.destination)) {
      renderPreview();
      return;
    }
    state.planning = true;
    renderPreview();
    try {
      const [field, direction] = state.sort.split("-");
      let plan;
      if (state.operation === "sort") {
        if (typeof source.planSort !== "function") throw new Error("sorting is unavailable");
        plan = source.planSort(state.sourceItems, sortFieldForData(field), direction, { editable: state.sourceEditable, snapshotFingerprint: state.snapshotFingerprint });
      } else if (state.operation === "position") {
        if (typeof source.planPosition !== "function") throw new Error("position changes are unavailable");
        plan = source.planPosition(state.sourceItems, summary.items.map((item) => item.occurrenceId), state.position, { editable: state.sourceEditable, snapshotFingerprint: state.snapshotFingerprint });
      } else if (state.operation === "remove") {
        if (typeof source.planRemove !== "function") throw new Error("removal is unavailable");
        plan = source.planRemove(summary.items, { editable: state.sourceEditable, snapshotFingerprint: state.snapshotFingerprint });
      } else {
        if (typeof source.planTransfer !== "function") throw new Error("playlist transfer is unavailable");
        const destinationId = state.destination;
        let destination = state.destinationCache.get(destinationId);
        if (!destination) {
          const pending = source.readPlaylist(destinationId, { signal: state.destinationController?.signal })
            .then((playlist) => ({ editable: playlist.editable === true, videoIds: playlist.items.map((item) => item.videoId).filter(Boolean) }))
            .catch((error) => { if (state.destinationCache.get(destinationId) === pending) state.destinationCache.delete(destinationId); throw error; });
          state.destinationCache.set(destinationId, pending);
          destination = pending;
        }
        destination = await destination;
        if (nonce !== state.planNonce || !state.dialog) return;
        const destinationVideoIds = destination.videoIds;
        state.destinationCache.set(destinationId, destination);
        plan = source.planTransfer(summary.items, state.destination, {
          sourcePlaylistId: state.playlistId,
          sourceEditable: state.sourceEditable,
          destinationEditable: destination?.editable === true,
          destinationVideoIds,
          sourceSnapshotFingerprint: state.snapshotFingerprint,
          removeSource: state.operation === "move",
          dedupe: true,
        });
      }
      if (nonce !== state.planNonce || !state.dialog) return;
      const accepted = Array.isArray(plan?.acceptedVideoIds) ? plan.acceptedVideoIds : Array.isArray(plan?.actions) ? plan.actions : Array.isArray(plan?.entries) ? plan.entries : summary.videoIds;
      const rejected = Array.isArray(plan?.rejectedVideoIds) ? plan.rejectedVideoIds : Array.isArray(plan?.blocked) ? plan.blocked : [];
      state.plan = { ...plan, acceptedCount: plan?.editable === false ? 0 : accepted.length, rejectedCount: rejected.length, acceptedVideoIds: accepted, rejectedVideoIds: rejected };
      if (plan?.editable === false) setStatus("This action requires an editable playlist. You can still copy songs from a read-only playlist into one you own.", true);
      else if (!preserveStatus) setStatus("");
    } catch (error) {
      if (error?.name === "AbortError" || nonce !== state.planNonce || !state.dialog) return;
      setStatus(`Could not prepare this change: ${text(error?.message) || "unknown error"}`, true);
    } finally {
      if (nonce === state.planNonce) state.planning = false;
      renderPreview();
    }
  }

  function setStatus(message, error = false) {
    const status = state.dialog?.querySelector("[data-role='status']");
    if (status) { status.textContent = message; status.style.color = error ? "#ff8a80" : ""; }
  }

  async function loadDestinations() {
    if (!state.dialog || state.busy || typeof adapter()?.listDestinations !== "function") return;
    state.destinationController?.abort();
    const controller = new AbortController();
    state.destinationController = controller;
    state.destinationLoading = true;
    const generation = state.generation;
    const select = state.dialog.querySelector("[data-role='destination']");
    const refresh = state.dialog.querySelector("[data-action='refresh-destinations']");
    if (refresh) refresh.disabled = true;
    state.destinationCache.clear();
    state.planController?.abort?.();
    state.planNonce += 1;
    state.plan = null;
    state.confirmationPlan = null;
    state.planning = false;
    renderPreview();
    select.innerHTML = '<option value="">Loading your playlists…</option>';
    try {
      const playlists = await adapter().listDestinations(state.tracks.find((track) => track.videoId)?.videoId, { signal: controller.signal });
      if (!state.dialog || generation !== state.generation || controller.signal.aborted) return;
      state.destinations = playlists.filter((playlist) => playlist.id !== state.playlistId);
      if (!state.destinations.some((playlist) => playlist.id === state.destination)) { state.destination = ""; state.plan = null; }
      renderDestinations();
      renderPreview();
      if (state.destination) requestPlan();
    } catch (error) {
      if (controller.signal.aborted || generation !== state.generation) return;
      select.innerHTML = '<option value="">Could not load playlists — use Refresh</option>';
      setStatus(`Could not load your destinations: ${error.message}`, true);
    } finally {
      if (generation === state.generation && state.destinationController === controller) {
        state.destinationLoading = false;
        syncSelectionControls();
      }
    }
  }

  function renderDestinations() {
    if (!state.dialog) return;
    const select = state.dialog.querySelector("[data-role='destination']");
    const query = text(state.dialog.querySelector("[data-role='destination-filter']")?.value).toLocaleLowerCase();
    const matches = state.destinations.filter((playlist) => playlist.id === state.destination || playlist.title.toLocaleLowerCase().includes(query));
    select.innerHTML = `<option value="">${matches.length ? "Choose a destination playlist" : query ? "No playlists match your search" : "No other playlists found"}</option>` + matches.map((playlist) => `<option value="${escapeHtml(playlist.id)}">${escapeHtml(playlist.title)}${playlist.privacy ? ` · ${escapeHtml(playlist.privacy)}` : ""}</option>`).join("");
    select.value = state.destination;
  }

  async function loadData() {
    const source = adapter();
    if (!source || typeof source.readPlaylist !== "function") {
      setStatus("Playlist tools are unavailable right now.", true);
      return;
    }
    state.busy = true;
    state.loadController?.abort?.();
    state.loadController = typeof AbortController === "function" ? new AbortController() : null;
    const signal = state.loadController?.signal;
    const generation = state.generation;
    setStatus("Loading playlist tracks…");
    renderPreview();
    try {
      const result = await source.readPlaylist(state.playlistId, { signal, onProgress: (progress) => {
        if (!state.dialog || state.generation !== generation) return;
        const loaded = Number(progress?.loaded ?? progress?.current ?? progress ?? 0);
        const total = Number(progress?.total ?? 0);
        if (Number.isFinite(loaded)) state.loaded = loaded;
        if (Number.isFinite(total) && total > 0) state.total = total;
        setStatus(state.total ? `Loading playlist tracks… ${state.loaded} of ${state.total}` : `Loading playlist tracks… ${state.loaded}`);
      } });
      if (!state.dialog || state.generation !== generation) return;
      const rawTracks = Array.isArray(result) ? result : result?.items;
      state.playlistTitle = firstText(result?.title, result?.playlist?.title, result?.playlist?.name) || state.playlistTitle;
      const heading = state.dialog.querySelector("#ytm-pm-heading");
      if (heading) heading.textContent = state.playlistTitle;
      state.sourceEditable = result?.editable === true || result?.playlist?.editable === true;
      state.sourceItems = Array.isArray(rawTracks) ? rawTracks : [];
      state.snapshotFingerprint = typeof source.snapshotFingerprint === "function" ? source.snapshotFingerprint(state.sourceItems) : "";
      state.tracks = state.sourceItems.map(normalizeTrack);
      state.selected.clear();
      state.anchorIndex = null;
      state.duplicateCandidates = duplicateOccurrences(state.tracks);
      state.unavailableCandidates = new Set(state.tracks.map((track, index) => track.unavailable ? index : -1).filter((index) => index >= 0));
      state.duplicates.clear();
      state.unavailable.clear();
      state.plan = null;
      state.total = state.tracks.length;
      state.loaded = state.tracks.length;
      setStatus(state.sourceEditable ? "" : "Read-only playlist. Copy songs to a playlist you own to organize them.");
      renderRows();
      renderPreview();
      requestPlan();
    } catch (error) {
      if (error?.name === "AbortError" || !state.dialog || state.generation !== generation) return;
      setStatus(`Could not load playlist: ${text(error?.message) || "unknown error"}`, true);
    } finally {
      if (state.generation === generation) { state.busy = false; renderPreview(); }
    }
  }

  function closeDialog() {
    if (!state.dialog) return;
    state.loadController?.abort?.();
    state.planController?.abort?.();
    state.mutationController?.abort?.();
    state.destinationController?.abort?.();
    clearTimeout(state.destinationTimer);
    state.destinationTimer = null;
    state.planNonce += 1;
    state.generation += 1;
    state.dialog.remove();
    state.dialog = null;
    document.body?.classList.remove("ytm-playlist-manager-open");
    state.previousFocus?.focus?.();
    state.previousFocus = null;
    state.tracks = [];
    state.sourceItems = [];
    state.destinations = [];
    state.destinationCache.clear();
    state.orderCache = null;
    state.selected.clear();
    state.duplicates.clear();
    state.unavailable.clear();
    state.duplicateCandidates.clear();
    state.unavailableCandidates.clear();
    state.plan = null;
    state.confirmationPlan = null;
    state.snapshotFingerprint = "";
    state.loadController = state.planController = state.mutationController = state.destinationController = null;
  }

  function trapFocus(event) {
    if (!state.dialog || event.key !== "Tab") return;
    const focusable = [...state.dialog.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled])")].filter((element) => !element.getClientRects || element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function applyMutation() {
    if (state.busy || state.planning) return;
    const generation = state.generation;
    const source = adapter();
    const summary = state.operation === "sort"
      ? { occurrenceCount: state.tracks.length, videoCount: state.tracks.length, videoIds: state.tracks.map((track) => track.videoId).filter(Boolean), items: state.sourceItems }
      : selectedSummary();
    const planner = state.operation === "remove" ? source?.planRemove : state.operation === "sort" ? source?.planSort : state.operation === "position" ? source?.planPosition : source?.planTransfer;
    const executor = isSourceEdit() ? source?.executePlan : source?.executeTransfer;
    const hasPlanApi = source && typeof executor === "function" && typeof planner === "function";
    if (!source || !hasPlanApi || !summary.videoIds.length) return;
    if (isTransfer() && !state.destination) return;
    if (!state.plan) await requestPlan();
    if (!state.plan || state.plan.acceptedCount === 0 || !state.snapshotFingerprint) return;
    if (state.confirmationPlan !== state.plan) {
      state.confirmationPlan = state.plan;
      const destinationName = state.destinations.find((playlist) => playlist.id === state.destination)?.title || "the selected playlist";
      const count = state.plan.acceptedCount;
      const description = state.operation === "move" ? `Copy ${count} songs to “${destinationName}”, then remove confirmed copies from this playlist?`
        : state.operation === "copy" ? `Copy ${count} songs to “${destinationName}”?`
        : state.operation === "remove" ? `Remove ${summary.occurrenceCount} selected ${summary.occurrenceCount === 1 ? "song" : "songs"} from this playlist?`
        : state.operation === "position" ? `Move ${summary.occurrenceCount} selected songs to start at position ${state.position}, keeping their original relative order?`
        : `Save the displayed sort order for all ${state.tracks.length} songs?`;
      const confirmation = state.dialog.querySelector("[data-role='confirmation']");
      if (confirmation) confirmation.textContent = description;
      else setStatus(description);
      renderPreview();
      return;
    }
    state.busy = true;
    state.mutationController = typeof AbortController === "function" ? new AbortController() : null;
    const signal = state.mutationController?.signal;
    setStatus(`Applying ${state.operation}…`);
    renderPreview();
    try {
      if (isTransfer()) {
        const destination = await source.readPlaylist(state.destination, { signal });
        if (signal?.aborted || state.generation !== generation) return;
        const freshIds = destination.items.map((item) => item.videoId).filter(Boolean);
        const existing = new Set(freshIds);
        const changed = state.plan.entries.some((entry) => existing.has(entry.copyAction.addedVideoId));
        state.destinationCache.set(state.destination, { editable: destination.editable === true, videoIds: freshIds });
        if (changed || destination.editable !== true) {
          await requestPlan();
          setStatus("The destination changed. Review the updated counts before confirming.");
          return;
        }
      }
      const fresh = state.operation === "copy" ? { items: state.sourceItems } : await source.readPlaylist(state.playlistId, { signal });
      if (signal?.aborted || state.generation !== generation) return;
      const freshFingerprint = firstText(fresh?.snapshotFingerprint, fresh?.sourceSnapshotFingerprint)
        || (typeof source.snapshotFingerprint === "function" && Array.isArray(fresh?.items) ? source.snapshotFingerprint(fresh.items) : "");
      if (!freshFingerprint || freshFingerprint !== state.snapshotFingerprint) {
        setStatus("This playlist changed while you were reviewing it. Refresh the selection before applying.", true);
        await loadData();
        return;
      }
      const executionPlan = {
        ...state.plan,
        sourceSnapshotFingerprint: freshFingerprint,
        options: { ...(state.plan.options || {}), snapshotFingerprint: freshFingerprint },
      };
      const onProgress = ({ completed, total }) => {
        if (state.generation === generation) setStatus(`Saving changes… ${completed} of ${total}`);
      };
      const result = isSourceEdit()
        ? await source.executePlan(executionPlan, { playlistId: state.playlistId, snapshotFingerprint: freshFingerprint, editable: state.sourceEditable, signal, onProgress })
        : await source.executeTransfer(executionPlan, { snapshotFingerprint: freshFingerprint, signal, onProgress });
      if (state.generation !== generation) return;
      const resultCount = Number(result?.succeededCount ?? (typeof result?.succeeded === "number" ? result.succeeded : result?.succeeded?.length) ?? (state.operation === "move" ? result?.removed : result?.copied) ?? 0);
      const failedCount = Number(result?.failedCount ?? (typeof result?.failed === "number" ? result.failed : result?.failed?.length) ?? 0);
      const cancelled = result?.cancelled === true;
      const destinationName = state.destinations.find((playlist) => playlist.id === state.destination)?.title || "the destination";
      const existingCount = state.plan.blocked?.filter((item) => item.reason === "already in destination").length || 0;
      const failure = result?.results?.find((entry) => entry.error)?.error;
      const changedCount = state.operation === "position" && !failedCount && !cancelled ? summary.occurrenceCount : resultCount;
      let resultMessage = `${{copy: "Copied", move: "Moved", remove: "Removed", sort: "Reordered", position: "Repositioned"}[state.operation]} ${changedCount} ${changedCount === 1 ? "song" : "songs"}${isTransfer() ? ` to “${destinationName}”` : ""}.`;
      if (existingCount) resultMessage += ` ${existingCount} of ${summary.occurrenceCount} already there; skipped.`;
      if (state.operation === "move" && result.copied > result.removed) resultMessage += ` ${result.copied - result.removed} copied but not confirmed removed from the source.`;
      if (failedCount) resultMessage += ` ${failedCount} changes not confirmed. ${failure || "Refresh before retrying."}`;
      if (cancelled) resultMessage += " Cancelled. Refresh before retrying.";
      const completed = new Set((result?.results || []).filter((entry) => entry.ok).map((entry) => entry.occurrenceId));
      const remaining = new Set(summary.items.filter((item) => !completed.has(item.occurrenceId)).map((item) => item.occurrenceId));
      state.destinationCache.clear();
      state.selected.clear();
      state.duplicates.clear();
      state.unavailable.clear();
      state.plan = null;
      if (state.operation !== "copy") await loadData();
      if (failedCount || cancelled) state.tracks.forEach((track) => { if (remaining.has(track.occurrenceId)) state.selected.add(track.originalIndex); });
      renderRows();
      if (failedCount || cancelled) await requestPlan(true);
      renderPreview();
      setStatus(resultMessage, failedCount > 0);

    } catch (error) {
      if (state.generation !== generation) return;
      if (error?.name === "AbortError") {
        setStatus("Playlist change cancelled. Review the playlist before trying again.", true);
        return;
      }
      setStatus(`Could not apply change: ${text(error?.message) || "unknown error"}`, true);
    } finally {
      if (state.generation === generation) {
        state.busy = false;
        renderPreview();
      }
    }
  }

  function openDialog() {
    if (!isPlaylistPage() || state.dialog) return;
    addStyles();
    state.generation += 1;
    state.selected.clear();
    state.duplicates.clear();
    state.unavailable.clear();
    state.duplicateCandidates.clear();
    state.unavailableCandidates.clear();
    state.plan = null;
    state.planning = false;
    state.busy = false;
    state.snapshotFingerprint = "";
    state.sourceItems = [];
    state.sourceEditable = false;
    state.query = "";
    state.filter = "all";
    state.anchorIndex = null;
    state.position = 1;
    state.orderCache = null;
    state.sort = "original-asc";
    state.operation = "copy";
    state.destination = "";
    state.destinationLoading = false;
    state.destinationCache.clear();
    state.destinationTimer = null;
    state.page = 0;
    state.tracks = [];
    state.previousFocus = document.activeElement;
    state.playlistId = playlistIdFromLocation();
    state.playlistTitle = document.querySelector("ytmusic-detail-header-renderer h1, ytmusic-detail-header-renderer #title, ytmusic-responsive-header-renderer h1, ytmusic-responsive-header-renderer #title")?.textContent?.trim() || "Playlist";
    const dialog = document.createElement("div");
    dialog.id = DIALOG_ID;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "ytm-pm-heading");
    dialog.innerHTML = `
      <section class="ytm-pm-card">
        <header class="ytm-pm-header"><div class="ytm-pm-title"><span class="ytm-pm-muted">Manage playlist</span><strong id="ytm-pm-heading"></strong></div><button class="ytm-pm-close" type="button" aria-label="Close playlist manager">${icon("close")}</button></header>
        <div class="ytm-pm-content"><div class="ytm-pm-toolbar"><label class="ytm-pm-search-field">${icon("search")}<input class="ytm-pm-input ytm-pm-search" data-role="search" type="search" placeholder="Search this entire playlist" aria-label="Search playlist tracks" /></label><label class="ytm-pm-control"><span>Sort view</span><select data-role="sort" aria-label="Sort playlist tracks">${SORT_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label></div>
        <div class="ytm-pm-filters" role="group" aria-label="Show songs">${[["all", "All songs"], ["duplicates", "Duplicates"], ["unavailable", "Unavailable"], ["selected", "Selected"]].map(([value, label]) => `<button type="button" class="ytm-pm-chip" data-filter="${value}" aria-pressed="${value === "all"}">${label}</button>`).join("")}<span class="ytm-pm-muted" data-role="filter-hint">Search by title, artist, or album</span></div>
        <div class="ytm-pm-selection"><button class="ytm-pm-secondary" type="button" data-action="select-all">Select all songs</button><button class="ytm-pm-secondary" type="button" data-action="select-matches" hidden>Select results</button><button class="ytm-pm-secondary" type="button" data-action="clear">Clear selection</button><label title="Select extra copies of the same video; keep the first occurrence"><input type="checkbox" data-role="duplicates" /> <span data-role="duplicate-label">Select extra copies</span></label><label><input type="checkbox" data-role="unavailable" /> <span data-role="unavailable-label">Select unavailable</span></label><span class="ytm-pm-selection-count" data-role="selection-count">0 selected</span></div>
        <div class="ytm-pm-status" data-role="status" role="status" aria-live="polite">Loading playlist…</div>
        <div class="ytm-pm-columns" aria-hidden="true"><span></span><span>#</span><span>Song / artist</span><span class="ytm-pm-album">Album</span><span>Time</span><span class="ytm-pm-row-state">Status</span></div>
        <div class="ytm-pm-list" data-role="list" aria-label="Playlist songs"></div>
        <div class="ytm-pm-pages"><button class="ytm-pm-secondary" type="button" data-action="previous">${icon("chevronLeft")} Previous</button><span class="ytm-pm-muted" data-role="page-label">Page 1 of 1</span><button class="ytm-pm-secondary" type="button" data-action="next">Next ${icon("chevronRight")}</button></div>
        <div class="ytm-pm-workflow"><div class="ytm-pm-action-row"><label class="ytm-pm-control"><span>With selected songs</span><select data-role="operation" aria-label="Playlist action"><option value="copy">Copy selected to…</option><option value="move">Move selected to…</option><option value="remove">Remove selected</option><option value="position">Move within playlist</option><option value="sort">Save this sort order</option></select></label><label class="ytm-pm-control ytm-pm-position" data-role="position-group" hidden><span>Starting position</span><input class="ytm-pm-input" type="number" min="1" step="1" value="1" data-role="position" aria-label="Starting position" /><span data-role="position-hint"></span></label><div class="ytm-pm-destination" data-role="destination-group"><label class="ytm-pm-surface-label" for="ytm-pm-destination-select">Destination playlist</label><div class="ytm-pm-destination-controls"><input class="ytm-pm-input ytm-pm-destination-filter" data-role="destination-filter" type="search" placeholder="Filter playlists…" aria-label="Filter destination playlists" /><select id="ytm-pm-destination-select" data-role="destination" aria-label="Destination playlist"><option value="">Choose from your playlists</option></select><button class="ytm-pm-secondary" data-action="refresh-destinations" type="button" aria-label="Refresh your playlists">${icon("refresh")}</button></div></div></div><div class="ytm-pm-preview" data-role="preview" aria-live="polite"></div></div>
        </div><footer class="ytm-pm-footer"><span class="ytm-pm-muted" data-role="confirmation" aria-live="polite">Changes are saved only when you confirm.</span><div class="ytm-pm-actions"><button class="ytm-pm-secondary" type="button" data-action="cancel">Close</button><button class="ytm-pm-primary" type="button" data-action="apply" disabled>Review changes</button></div></footer>
      </section>`;
    document.body.appendChild(dialog);
    document.body.classList.add("ytm-playlist-manager-open");
    state.dialog = dialog;
    dialog.querySelector("#ytm-pm-heading").textContent = state.playlistTitle;
    dialog.querySelector("[data-role='sort']").value = state.sort;
    dialog.querySelector("[data-role='operation']").value = state.operation;
    dialog.querySelector(".ytm-pm-close").addEventListener("click", closeDialog);
    dialog.querySelector("[data-action='cancel']").addEventListener("click", closeDialog);
    dialog.addEventListener("keydown", (event) => { event.stopPropagation?.(); if (event.key === "Escape") closeDialog(); else trapFocus(event); });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(); });
    dialog.querySelector("[data-role='search']").addEventListener("input", (event) => { state.query = event.target.value; state.page = 0; state.anchorIndex = null; renderRows(); renderPreview(); });
    dialog.querySelector("[data-role='sort']").addEventListener("change", (event) => { state.sort = event.target.value; state.page = 0; state.anchorIndex = null; state.plan = null; renderRows(); renderPreview(); requestPlan(); });
    dialog.querySelector("[data-role='operation']").addEventListener("change", (event) => { state.operation = event.target.value; state.plan = null; if (isSourceEdit()) { state.destination = ""; dialog.querySelector("[data-role='destination']").value = ""; } syncSelectionControls(); renderPreview(); requestPlan(); });
    dialog.querySelector("[data-role='destination']").addEventListener("change", (event) => {
      state.destination = playlistIdFromInput(event.target.value);
      state.plan = null;
      if (!state.destination && text(event.target.value)) setStatus("Choose a playlist from your library.", true);
      renderPreview();
      clearTimeout(state.destinationTimer);
      state.destinationTimer = setTimeout(() => requestPlan(), 250);
    });
    for (const [role, candidateKey] of [["duplicates", "duplicateCandidates"], ["unavailable", "unavailableCandidates"]]) {
      dialog.querySelector(`[data-role='${role}']`).addEventListener("change", (event) => {
        for (const index of state[candidateKey]) {
          if (event.target.checked) state.selected.add(index);
          else { state.selected.delete(index); state.duplicates.delete(index); state.unavailable.delete(index); }
        }
        state.plan = null; renderRows(); renderPreview(); requestPlan();
      });
    }
    dialog.querySelector("[data-action='select-all']").addEventListener("click", () => {
      state.tracks.forEach((track) => state.selected.add(track.originalIndex));
      state.plan = null; renderRows(); renderPreview(); requestPlan();
    });
    dialog.querySelector("[data-action='select-matches']")?.addEventListener("click", () => {
      getFilteredTracks().forEach((track) => state.selected.add(track.originalIndex));
      state.plan = null; renderRows(); renderPreview(); requestPlan();
    });
    dialog.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
      state.filter = button.dataset.filter; state.page = 0; state.anchorIndex = null;
      renderRows(); renderPreview();
    }));
    dialog.querySelector("[data-role='position']")?.addEventListener("input", (event) => {
      state.position = Number(event.target.value); requestPlan();
    });
    dialog.querySelector("[data-action='clear']").addEventListener("click", () => { state.selected.clear(); state.duplicates.clear(); state.unavailable.clear(); state.plan = null; renderRows(); renderPreview(); requestPlan(); });
    dialog.querySelector("[data-action='previous']").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); renderRows(); dialog.querySelector("[data-role='list']").scrollTop = 0; });
    dialog.querySelector("[data-action='next']").addEventListener("click", () => { state.page += 1; renderRows(); dialog.querySelector("[data-role='list']").scrollTop = 0; });
    dialog.querySelector("[data-action='apply']").addEventListener("click", applyMutation);
    syncSelectionControls();
    dialog.querySelector(".ytm-pm-close").focus();
    dialog.querySelector("[data-action='refresh-destinations']")?.addEventListener("click", loadDestinations);
    dialog.querySelector("[data-role='destination-filter']")?.addEventListener("input", renderDestinations);
    const generation = state.generation;
    loadData().then(() => { if (state.dialog && state.generation === generation) loadDestinations(); });
  }

  addStyles();
  ensureButton();
  const observer = new MutationObserver(ensureButton);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  setInterval(ensureButton, 1200);
  publicApi.openDialog = openDialog;
  publicApi.closeDialog = closeDialog;
})();
