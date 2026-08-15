(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const PROVIDERS = ["LRCLib", "YTMusic", "MusixMatch", "Megalobiz", "LyricsGenius"];
  const STYLE_ID = "ytm-tauri-synced-lyrics-style";
  const CONTAINER_ID = "synced-lyrics-container";
  const STAR_KEY = "ytmd-sl-starred-";
  const CACHE = new Map();

  let headerObserver = null;
  let updateInterval = 0;
  let trackPollInterval = 0;
  let activeTrack = null;
  let currentProvider = PROVIDERS[0];
  let manuallySwitched = false;
  let renderVersion = 0;
  let lastCurrentIndex = -1;
  let isUserScrolling = false;
  let userScrollTimeout = 0;

  let musixmatchToken = null;
  let musixmatchTokenExpires = 0;
  let musixmatchCookie = "x-mxm-user-id=";

  const state = () => CACHE.get(activeTrack?.videoId)?.providers || null;
  const config = () => runtime.config || {};
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const styles = `
/* hide static lyrics */
ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > *:not(#${CONTAINER_ID}),
#tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > *:not(#${CONTAINER_ID}),
#tab-renderer > ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > *:not(#${CONTAINER_ID}),
ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] ytmusic-description-shelf-renderer,
ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] ytmusic-music-description-shelf-renderer,
ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] yt-formatted-string.description {
  display: none !important;
}

ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > #${CONTAINER_ID},
#tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > #${CONTAINER_ID},
#tab-renderer > ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > #${CONTAINER_ID},
#${CONTAINER_ID} {
  display: flex !important;
  flex-direction: column !important;
  height: 100% !important;
  min-height: 400px !important;
  width: 100% !important;
  box-sizing: border-box !important;
  position: relative !important;
  z-index: 10 !important;
  background: transparent !important;
}

ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'],
#tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] {
  scrollbar-width: none !important;
  display: flex !important;
  flex-direction: column !important;
  height: 100% !important;
}

#tabsContent > tp-yt-paper-tab,
#tabsContent > .tab-header {
  pointer-events: auto !important;
  cursor: pointer !important;
}

@property --lyrics-duration {
  syntax: '<time>';
  inherits: false;
  initial-value: 2s;
}

:root {
  /* layout */
  --global-margin: 0.7rem;
  --lyrics-padding: 0;

  /* typography */
  --lyrics-font-family: Satoshi, Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
  --lyrics-font-size: clamp(1.4rem, 1.1vmax, 3rem);
  --lyrics-line-height: var(--ytmusic-body-line-height, 1.5);
  --lyrics-width: 100%;

  /* inactive lyrics */
  --lyrics-inactive-font-weight: 400;
  --lyrics-inactive-opacity: 0.33;
  --lyrics-inactive-scale: 1;
  --lyrics-inactive-offset: 0;

  /* active lyrics */
  --lyrics-active-font-weight: 700;
  --lyrics-active-opacity: 1;
  --lyrics-active-scale: 1;
  --lyrics-active-offset: 0;

  --lyrics-duration: 2s;

  /* animations */
  --lyrics-animations: lyrics-glow var(--lyrics-glow-duration, 2s) forwards, lyrics-wobble var(--lyrics-wobble-duration, 1s) forwards;
  --lyrics-scale-duration: 0.166s;
  --lyrics-opacity-transition: 0.33s;
  --lyrics-glow-duration: var(--lyrics-duration, 2s);
  --lyrics-wobble-duration: calc(var(--lyrics-duration, 2s) / 2);

  /* colors */
  --glow-color: rgba(255, 255, 255, 0.5);
}

/* line effects */
html[data-lyrics-effect="fancy"], :root[data-lyrics-effect="fancy"] {
  --lyrics-font-size: 3rem;
  --lyrics-line-height: 1.333;
  --lyrics-width: 100%;
  --lyrics-padding: 1.5rem;
  --lyrics-inactive-font-weight: 700;
  --lyrics-inactive-opacity: 0.33;
  --lyrics-inactive-scale: 0.95;
  --lyrics-inactive-offset: 0;
  --lyrics-active-font-weight: 700;
  --lyrics-active-opacity: 1;
  --lyrics-active-scale: 1;
  --lyrics-active-offset: 0;
  --lyrics-animations: lyrics-glow var(--lyrics-glow-duration, 2s) forwards, lyrics-wobble var(--lyrics-wobble-duration, 1s) forwards;
}

html[data-lyrics-effect="scale"], :root[data-lyrics-effect="scale"] {
  --lyrics-font-size: clamp(1.4rem, 1.1vmax, 3rem);
  --lyrics-width: 83%;
  --lyrics-padding: 0;
  --lyrics-animations: none;
  --lyrics-inactive-font-weight: 400;
  --lyrics-inactive-opacity: 0.33;
  --lyrics-inactive-scale: 1;
  --lyrics-inactive-offset: 0;
  --lyrics-active-font-weight: 700;
  --lyrics-active-opacity: 1;
  --lyrics-active-scale: 1.2;
  --lyrics-active-offset: 0;
}

html[data-lyrics-effect="offset"], :root[data-lyrics-effect="offset"] {
  --lyrics-font-size: clamp(1.4rem, 1.1vmax, 3rem);
  --lyrics-width: 100%;
  --lyrics-padding: 0;
  --lyrics-animations: none;
  --lyrics-inactive-font-weight: 400;
  --lyrics-inactive-opacity: 0.33;
  --lyrics-inactive-scale: 1;
  --lyrics-inactive-offset: 0;
  --lyrics-active-font-weight: 700;
  --lyrics-active-opacity: 1;
  --lyrics-active-scale: 1;
  --lyrics-active-offset: 5%;
}

html[data-lyrics-effect="focus"], :root[data-lyrics-effect="focus"] {
  --lyrics-font-size: clamp(1.4rem, 1.1vmax, 3rem);
  --lyrics-width: 100%;
  --lyrics-padding: 0;
  --lyrics-animations: none;
  --lyrics-inactive-font-weight: 400;
  --lyrics-inactive-opacity: 0.33;
  --lyrics-inactive-scale: 1;
  --lyrics-inactive-offset: 0;
  --lyrics-active-font-weight: 700;
  --lyrics-active-opacity: 1;
  --lyrics-active-scale: 1;
  --lyrics-active-offset: 0;
}

.lyrics-renderer {
  display: flex !important;
  flex-direction: column !important;
  height: 100% !important;
  min-height: 400px !important;
  width: 100% !important;
}

.lyrics-picker-sticky {
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  background: linear-gradient(to bottom, rgba(10,10,10,0.9), rgba(10,10,10,0.5), transparent);
  transform: translateY(var(--lyrics-picker-top, -60px));
  opacity: var(--lyrics-picker-opacity, 0);
  pointer-events: var(--lyrics-picker-pointer, none);
  transition: transform 280ms cubic-bezier(0.25, 1, 0.5, 1), opacity 220ms ease-in-out;
}

.lyrics-picker {
  height: 4.5em;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-around;
  padding-block: 0.6em;
  box-sizing: border-box;
}

.lyrics-picker-left,
.lyrics-picker-right {
  display: flex;
  justify-content: center;
  align-items: center;
  transition: background-color 0.3s ease;
  border-radius: 50%;
  width: 36px;
  height: 36px;
  background: rgba(255, 255, 255, 0.08);
  border: 0;
  color: #fff;
  cursor: pointer;
  font-size: 1.4rem;
}
.lyrics-picker-left:hover,
.lyrics-picker-right:hover {
  background: rgba(255, 255, 255, 0.2);
}

.lyrics-picker-content {
  display: flex;
  width: 50%;
  min-width: 180px;
  flex-direction: column;
  justify-content: space-around;
  align-items: center;
  gap: 4px;
}

.lyrics-picker-content-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
}

.lyrics-picker-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 1.25rem;
  font-weight: 600;
  color: #ffffff;
}

.lyrics-picker-star {
  border: 0;
  background: transparent;
  color: #ffca28;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
}

.lyrics-picker-status {
  font-size: 15px;
  display: inline-flex;
  align-items: center;
}
.lyrics-picker-status.done { color: #81c784; }
.lyrics-picker-status.fetching { color: #ffb74d; }
.lyrics-picker-status.error { color: #e57373; }
.lyrics-picker-status.warning { color: #ffb74d; }

.lyrics-picker-content-dots {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lyrics-picker-dot {
  display: inline-block;
  cursor: pointer;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.4);
  background: transparent;
  transition: background 0.2s, transform 0.2s;
}
.lyrics-picker-dot.active {
  background: #ffffff;
  border-color: #ffffff;
  transform: scale(1.2);
}

.synced-lyrics-vlist {
  flex: 1 1 auto !important;
  display: block !important;
  height: 100% !important;
  min-height: 350px !important;
  overflow-y: auto !important;
  scrollbar-width: none !important;
  padding: 16px 12px 50vh 12px !important;
  box-sizing: border-box !important;
}
.synced-lyrics-vlist::-webkit-scrollbar { display: none; }

.synced-line {
  width: var(--lyrics-width, 100%);
  margin: var(--global-margin) 0;
  transition: all 0.3s cubic-bezier(0.25, 1, 0.5, 1);
  display: block;
}

.synced-line .text-lyrics {
  cursor: pointer;
  padding-left: 1.5rem;
}

.text-lyrics {
  font-family: var(--lyrics-font-family) !important;
  font-size: var(--lyrics-font-size) !important;
  font-weight: var(--lyrics-inactive-font-weight) !important;
  line-height: var(--lyrics-line-height) !important;
  padding-top: var(--lyrics-padding);
  padding-bottom: var(--lyrics-padding);
  scale: var(--lyrics-inactive-scale);
  translate: var(--lyrics-inactive-offset);
  transition: scale var(--lyrics-scale-duration), translate 0.3s ease-in-out, opacity var(--lyrics-opacity-transition);
  display: block;
  text-align: left;
  transform-origin: 0 50%;
  color: #ffffff !important;
}

.text-lyrics > span > span {
  display: inline-block;
  white-space: pre-wrap;
  opacity: var(--lyrics-inactive-opacity);
  transition: opacity var(--lyrics-opacity-transition);
  color: #ffffff !important;
}

.synced-line.current .text-lyrics {
  font-weight: var(--lyrics-active-font-weight) !important;
  scale: var(--lyrics-active-scale);
  translate: var(--lyrics-active-offset);
  color: #ffffff !important;
}

.synced-line.current .text-lyrics > span > span {
  opacity: var(--lyrics-active-opacity);
  animation: var(--lyrics-animations);
  color: #ffffff !important;
}

.text-lyrics > .romaji {
  color: var(--ytmusic-text-secondary, rgba(255, 255, 255, 0.7)) !important;
  font-size: calc(var(--lyrics-font-size) * 0.7) !important;
  font-style: italic !important;
  display: block;
  margin-top: 4px;
}

.text-lyrics > .timecode {
  color: var(--ytmusic-text-secondary, rgba(255, 255, 255, 0.5));
  font-size: 0.45em;
  font-weight: 500;
  display: block;
  margin-bottom: 2px;
}

.kaomoji-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  width: 100%;
  color: rgba(255, 255, 255, 0.7);
  font-family: var(--lyrics-font-family);
  font-size: 2rem;
  user-select: none;
  text-align: center;
}

.error-container {
  padding: 24px;
  margin-bottom: 5%;
}
.error-box {
  background-color: rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 12px;
  color: #ff8a80;
  font-family: monospace;
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-all;
}
.retry-btn {
  margin-top: 14px;
  border: 0;
  border-radius: 18px;
  padding: 8px 20px;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  cursor: pointer;
  font-size: 14px;
}

@keyframes lyrics-wobble {
  from { transform: translateY(0px); }
  33.33% { transform: translateY(1.75px); }
  66.66% { transform: translateY(-1.75px); }
  to { transform: translateY(0px); }
}

@keyframes lyrics-glow {
  0% { text-shadow: 0 0 1.5rem var(--glow-color); }
  to { text-shadow: 0 0 0 var(--glow-color); }
}

.line-seek-pulse {
  animation: line-seek-flash 0.4s ease-out !important;
}

@keyframes line-seek-flash {
  0% {
    transform: scale(1.05);
    filter: brightness(1.8) drop-shadow(0 0 14px rgba(255, 255, 255, 0.9));
  }
  100% {
    transform: scale(1);
    filter: brightness(1) drop-shadow(0 0 0 transparent);
  }
}

.synced-line.instrumental .text-lyrics {
  opacity: 0.5;
  letter-spacing: 0.2em;
}

.synced-line.instrumental.current .text-lyrics {
  opacity: 1;
  animation: pulse-note 1.8s infinite ease-in-out;
}

@keyframes pulse-note {
  0%, 100% { transform: scale(1); filter: brightness(1); }
  50% { transform: scale(1.15); filter: brightness(1.4) drop-shadow(0 0 10px var(--glow-color, rgba(255,255,255,0.7))); }
}
`;

  function installStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      const target = document.head || document.documentElement || document.body;
      if (target) {
        target.appendChild(style);
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          const t = document.head || document.documentElement || document.body;
          if (t && !document.getElementById(STYLE_ID)) t.appendChild(style);
        }, { once: true });
      }
    }
    style.textContent = styles;
  }

  function getLyricsTabHeader() {
    const tabs = document.querySelectorAll(
      "#tabsContent > tp-yt-paper-tab, #tabsContent > .tab-header, ytmusic-player-page #tabsContent tp-yt-paper-tab, #tab-header"
    );
    for (const tab of tabs) {
      if (/lyrics/i.test(tab.textContent || "")) return tab;
    }
    return document.querySelector("#tabsContent > .tab-header:nth-of-type(2), #tabsContent > tp-yt-paper-tab:nth-of-type(2)");
  }

  function getLyricsTabRenderer() {
    return document.querySelector(
      'ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"], #tab-renderer > ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"], #tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"], ytmusic-player-page ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"], ytmusic-player-page #tab-renderer > ytmusic-tab-renderer:nth-of-type(2)'
    );
  }

  function cleanSongTitle(title) {
    if (!title) return "";
    return title
      .replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, " ")
      .replace(/\s*-\s*(official|audio|video|lyrics?|visualizer|remaster(ed)?|demo|live|extended|draft).*$/gi, " ")
      .replace(/\s+(feat|ft)\.?\s+.*$/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getPlayer() {
    return document.querySelector("#movie_player, .html5-video-player, ytmusic-player");
  }

  function trackInfo() {
    const player = getPlayer();
    const videoData = player?.getVideoData?.();
    const playerResponse = player?.getPlayerResponse?.();
    const media = runtime.media();

    let title = clean(
      videoData?.title ||
      navigator.mediaSession?.metadata?.title ||
      document.querySelector("ytmusic-player-bar .title")?.textContent ||
      document.querySelector("ytmusic-player-bar yt-formatted-string.title")?.textContent
    );
    let artist = clean(
      videoData?.author ||
      navigator.mediaSession?.metadata?.artist ||
      document.querySelector("ytmusic-player-bar .byline a")?.textContent ||
      document.querySelector("ytmusic-player-bar .byline")?.textContent?.split(/[•·]/)[0]
    );
    let album = clean(
      playerResponse?.videoDetails?.album ||
      navigator.mediaSession?.metadata?.album ||
      ""
    );
    const duration = Number(
      videoData?.length_seconds ||
      playerResponse?.videoDetails?.lengthSeconds ||
      media?.duration ||
      0
    );
    const videoId = videoData?.video_id || new URL(location.href).searchParams.get("v") || (title ? `${artist}-${title}` : "");
    const alternativeTitle = clean(
      playerResponse?.microformat?.microformatDataRenderer?.linkAlternates?.find?.((l) => l.title)?.title || ""
    );
    const tags = Array.isArray(playerResponse?.microformat?.microformatDataRenderer?.tags)
      ? playerResponse.microformat.microformatDataRenderer.tags
      : [];

    if (!title && !videoId) return null;

    return {
      videoId,
      title,
      alternativeTitle,
      artist,
      album,
      songDuration: duration,
      tags,
    };
  }

  function blankProviderState() {
    return Object.fromEntries(PROVIDERS.map((name) => [name, { state: "fetching", data: null, error: null }]));
  }

  const REMEMBER_KEY = "ytmd-sl-selected-";

  function readRemembered(videoId) {
    if (!videoId) return null;
    try {
      const val = localStorage.getItem(REMEMBER_KEY + videoId) || sessionStorage.getItem(REMEMBER_KEY + videoId);
      return PROVIDERS.includes(val) ? val : null;
    } catch {
      return null;
    }
  }

  function saveRemembered(videoId, provider) {
    if (!videoId || !provider) return;
    try {
      localStorage.setItem(REMEMBER_KEY + videoId, provider);
      sessionStorage.setItem(REMEMBER_KEY + videoId, provider);
    } catch {}
  }

  function ensureTrack(info) {
    let entry = CACHE.get(info.videoId);
    if (!entry) {
      const starred = readStarred(info.videoId);
      const remembered = readRemembered(info.videoId);
      const initialProvider = starred || remembered || PROVIDERS[0];
      entry = {
        status: "loading",
        providers: blankProviderState(),
        selectedProvider: initialProvider,
      };
      CACHE.set(info.videoId, entry);
      currentProvider = initialProvider;
      for (const name of PROVIDERS) fetchProvider(name, info, entry);
    } else if (entry.selectedProvider) {
      currentProvider = entry.selectedProvider;
    }
    return entry;
  }

  async function fetchProvider(name, info, entry) {
    const provider = entry.providers[name];
    if (provider.state === "done" && provider.data) {
      return;
    }
    provider.state = "fetching";
    provider.data = null;
    provider.error = null;
    render();
    try {
      const data = await providerSearch(name, info);
      provider.state = "done";
      provider.data = data;
    } catch (error) {
      provider.state = "error";
      provider.error = error instanceof Error ? error : new Error(String(error));
    }
    entry.status = PROVIDERS.every((providerName) => entry.providers[providerName].state !== "fetching") ? "done" : "loading";
    if (!entry.selectedProvider || !usable(entry.selectedProvider)) {
      autoPickProvider();
    }
    render();
  }

  function providerBias(name) {
    const item = state()?.[name];
    if (!item) return -99;
    return (item.state === "done" ? 1 : -1)
      + (item.data?.lines?.length ? 2 : -1)
      + (item.data?.lines?.length && name === "YTMusic" ? 1 : 0)
      + (item.data?.lyrics ? 1 : -1);
  }

  function usable(name) {
    const data = state()?.[name]?.data;
    return Boolean(data?.lines?.length || data?.lyrics);
  }

  function autoPickProvider() {
    if (manuallySwitched || !activeTrack) return;
    const starred = readStarred(activeTrack.videoId);
    if (starred && usable(starred)) {
      currentProvider = starred;
      const entry = CACHE.get(activeTrack.videoId);
      if (entry) entry.selectedProvider = currentProvider;
      saveRemembered(activeTrack.videoId, currentProvider);
      return;
    }
    const remembered = readRemembered(activeTrack.videoId);
    if (remembered && usable(remembered)) {
      currentProvider = remembered;
      const entry = CACHE.get(activeTrack.videoId);
      if (entry) entry.selectedProvider = currentProvider;
      return;
    }
    const available = PROVIDERS.filter(usable).sort((a, b) => providerBias(b) - providerBias(a));
    if (available.length && (providerBias(available[0]) > providerBias(currentProvider) || !usable(currentProvider))) {
      currentProvider = available[0];
      const entry = CACHE.get(activeTrack.videoId);
      if (entry) entry.selectedProvider = currentProvider;
      saveRemembered(activeTrack.videoId, currentProvider);
    }
  }

  function readStarred(videoId) {
    if (!videoId) return null;
    try {
      const value = JSON.parse(localStorage.getItem(STAR_KEY + videoId) || "null");
      return PROVIDERS.includes(value?.provider) ? value.provider : null;
    } catch {
      return null;
    }
  }

  function toggleStar() {
    if (!activeTrack) return;
    const key = STAR_KEY + activeTrack.videoId;
    if (readStarred(activeTrack.videoId) === currentProvider) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify({ provider: currentProvider }));
    }
    const entry = CACHE.get(activeTrack.videoId);
    if (entry) entry.selectedProvider = currentProvider;
    saveRemembered(activeTrack.videoId, currentProvider);
    render();
  }

  function selectProvider(index, manual = true) {
    currentProvider = PROVIDERS[(index + PROVIDERS.length) % PROVIDERS.length];
    if (manual) manuallySwitched = true;
    if (activeTrack) {
      const entry = CACHE.get(activeTrack.videoId);
      if (entry) entry.selectedProvider = currentProvider;
      saveRemembered(activeTrack.videoId, currentProvider);
    }
    render();
  }

  function providerSearch(name, info) {
    switch (name) {
      case "LRCLib": return fetchLrcLib(info);
      case "YTMusic": return fetchYtmLyrics(info);
      case "MusixMatch": return fetchMusixMatch(info);
      case "Megalobiz": return fetchMegalobiz(info);
      case "LyricsGenius": return fetchGenius(info);
      default: return Promise.resolve(null);
    }
  }

  async function directFetchJson(url) {
    try {
      const res = await window.fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // fallback
    }
    return requestJson(url);
  }

  async function fetchLrcLib(info) {
    let query = new URLSearchParams({
      artist_name: info.artist,
      track_name: info.title,
    });
    if (info.album) {
      query.set("album_name", info.album);
    }

    let url = `https://lrclib.net/api/search?${query.toString()}`;
    let data = await directFetchJson(url);

    if (!Array.isArray(data) || data.length === 0) {
      const trackName = info.alternativeTitle || info.title;
      query = new URLSearchParams({ q: trackName });
      url = `https://lrclib.net/api/search?${query.toString()}`;
      data = await directFetchJson(url);

      if ((!Array.isArray(data) || data.length === 0) && info.alternativeTitle) {
        query = new URLSearchParams({ q: info.title });
        url = `https://lrclib.net/api/search?${query.toString()}`;
        data = await directFetchJson(url);
      }
    }

    if (!Array.isArray(data) || data.length === 0) {
      const cleanTitle = cleanSongTitle(info.title);
      if (cleanTitle && cleanTitle !== info.title) {
        query = new URLSearchParams({ q: `${info.artist} ${cleanTitle}` });
        url = `https://lrclib.net/api/search?${query.toString()}`;
        data = await directFetchJson(url);
      }
    }

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const filteredResults = [];
    for (const item of data) {
      const { artistName } = item;
      if (!artistName) continue;

      const artists = info.artist.split(/[&,]/g).map((i) => i.trim());
      const itemArtists = artistName.split(/[&,]/g).map((i) => i.trim());

      const permutations = [];
      for (const artistA of artists) {
        for (const artistB of itemArtists) {
          permutations.push([artistA.toLowerCase(), artistB.toLowerCase()]);
        }
      }
      for (const artistA of itemArtists) {
        for (const artistB of artists) {
          permutations.push([artistA.toLowerCase(), artistB.toLowerCase()]);
        }
      }

      let ratio = Math.max(...permutations.map(([x, y]) => jaroWinkler(x, y)));

      if (ratio <= 0.85 && info.tags && info.tags.length > 0) {
        const filteredTags = info.tags.filter((tag) => tag.toLowerCase() !== info.artist.toLowerCase());
        const tagPermutations = [];
        for (const tag of filteredTags) {
          for (const itemArtist of itemArtists) {
            tagPermutations.push([tag.toLowerCase(), itemArtist.toLowerCase()]);
          }
        }
        for (const itemArtist of itemArtists) {
          for (const tag of filteredTags) {
            tagPermutations.push([itemArtist.toLowerCase(), tag.toLowerCase()]);
          }
        }
        if (tagPermutations.length > 0) {
          const tagRatio = Math.max(...tagPermutations.map(([x, y]) => jaroWinkler(x, y)));
          ratio = Math.max(ratio, tagRatio);
        }
      }

      if (ratio <= 0.85) continue;
      filteredResults.push(item);
    }

    if (!filteredResults.length && data.length > 0) {
      filteredResults.push(...data.filter((item) => !item.instrumental && (item.syncedLyrics || item.plainLyrics)));
    }

    filteredResults.sort((a, b) => {
      const left = Math.abs((a.duration || 0) - info.songDuration);
      const right = Math.abs((b.duration || 0) - info.songDuration);
      return left - right;
    });

    const closestResult = filteredResults[0];
    if (!closestResult) return null;
    if (info.songDuration > 0 && Math.abs(closestResult.duration - info.songDuration) > 20) {
      if (!closestResult.syncedLyrics && !closestResult.plainLyrics) return null;
    }
    if (closestResult.instrumental) return null;

    const raw = closestResult.syncedLyrics;
    const plain = closestResult.plainLyrics;
    if (!raw && !plain) return null;

    return {
      title: closestResult.trackName || info.title,
      artists: closestResult.artistName ? closestResult.artistName.split(/[&,]/g) : [info.artist],
      lines: raw ? parseLrc(raw).lines : null,
      lyrics: plain || null,
    };
  }

  async function fetchYtmLyrics(info) {
    const app = runtime.app();
    const manager = app?.networkManager;
    if (!manager?.fetch) return null;
    const data = await manager.fetch("/next?prettyPrint=false", { videoId: info.videoId });
    const tabs = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
    if (!Array.isArray(tabs)) return null;
    const tab = tabs.find((item) => item?.tabRenderer?.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === "MUSIC_PAGE_TYPE_TRACK_LYRICS");
    const browseId = tab?.tabRenderer?.endpoint?.browseEndpoint?.browseId;
    if (!browseId) return null;
    const response = await runtime.request("https://ytmbrowseproxy.zvz.be/browse?prettyPrint=false", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ browseId, context: { client: { clientName: "26", clientVersion: "7.01.05" } } }),
    });
    if (!response?.ok || !response.body) return null;
    const browse = JSON.parse(response.body);
    const contents = browse?.contents;
    const timed = contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel?.lyricsData?.timedLyricsData;
    let lines = Array.isArray(timed) && timed[0]?.cueRange
      ? timed.map((item) => {
          const start = Number.parseInt(item.cueRange.startTimeMilliseconds, 10);
          const end = Number.parseInt(item.cueRange.endTimeMilliseconds, 10);
          return { time: formatTime(start), timeInMs: start, duration: Math.max(0, end - start), text: clean(item.lyricLine) === "♪" ? "" : clean(item.lyricLine), words: [] };
        })
      : null;
    if (lines?.length && lines[0].timeInMs > 300) lines.unshift({ time: "00:00.00", timeInMs: 0, duration: lines[0].timeInMs, text: "", words: [] });
    let lyrics = null;
    if (!lines) {
      lyrics = Array.isArray(timed)
        ? timed.map((item) => item.lyricLine).join("\n")
        : contents?.messageRenderer?.text?.runs?.map((item) => item.text).join("\n")
          || contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer?.description?.runs?.map((item) => item.text).join("\n")
          || null;
    }
    if (lyrics === "Lyrics not available") return null;
    return { title: info.title, artists: [info.artist], lines, lyrics };
  }

  async function fetchMegalobiz(info) {
    const query = new URLSearchParams({
      qry: `${info.artist} ${info.title}`,
    });
    const searchRes = await runtime.request(`https://www.megalobiz.com/search/all?${query.toString()}`);
    if (!searchRes?.ok || !searchRes.body) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(searchRes.body, "text/html");
    const anchors = Array.from(doc.querySelectorAll('a.entity_name[href^="/lrc/maker/"][name][title]'));
    if (!anchors.length) return null;

    function removeNoise(t) {
      return String(t || "")
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*?\)/g, "")
        .trim()
        .replace(/(^[-•])|([-•]$)/g, "")
        .trim()
        .replace(/\s+by$/, "");
    }

    const searchResults = anchors.map((anchor) => {
      const titleAttr = anchor.getAttribute("title") || "";
      const match = titleAttr.match(/\[(?<minutes>\d+):(?<seconds>\d+)\.(?<millis>\d+)\]/);
      if (!match?.groups) return null;
      const { minutes, seconds, millis } = match.groups;
      let name = anchor.getAttribute("name") || "";
      const feat = name.match(/\(?[Ff]eat\. (.+)\)?/)?.[1] || "";
      const dash = name.match(/(.*?)\s+[-•]\s+(.*)/);
      const by = name.match(/(.*?)\s+by\s+(.*)/);
      const artists = [
        removeNoise(feat),
        ...(dash ? dash[1].split(/[&,]/).map(removeNoise) : []),
        ...(by ? by[2].split(/[&,]/).map(removeNoise) : []),
      ].filter(Boolean);

      for (const art of artists) {
        name = name.replace(art, "");
        name = removeNoise(name);
      }

      return {
        title: name || anchor.getAttribute("name"),
        artists,
        href: anchor.getAttribute("href"),
        duration: parseInt(minutes, 10) * 60 + parseInt(seconds, 10) + (parseInt(millis, 10) / 1000),
      };
    }).filter(Boolean);

    if (!searchResults.length) return null;
    searchResults.sort((a, b) => Math.abs(a.duration - info.songDuration) - Math.abs(b.duration - info.songDuration));
    const closest = searchResults[0];
    if (!closest || (info.songDuration > 0 && Math.abs(closest.duration - info.songDuration) > 20)) {
      return null;
    }

    const pageRes = await runtime.request(`https://www.megalobiz.com${closest.href}`);
    if (!pageRes?.ok || !pageRes.body) return null;
    const lyricsDoc = parser.parseFromString(pageRes.body, "text/html");
    const raw = lyricsDoc.querySelector('span[id^="lrc_"][id$="_lyrics"]')?.textContent;
    if (!raw) return null;

    const parsed = parseLrc(raw);
    return {
      title: closest.title || info.title,
      artists: closest.artists.length ? closest.artists : [info.artist],
      lines: parsed.lines?.length ? parsed.lines : null,
      lyrics: raw,
    };
  }

  async function fetchGenius(info) {
    const query = new URLSearchParams({ q: `${info.artist} ${info.title}` });
    const search = await requestJson(`https://genius.com/api/search/multi?${query}`);
    const sections = search?.response?.sections || [];
    const hits = sections.flatMap((section) => (section.type === "song" ? section.hits || [] : []));
    if (!hits.length) return null;
    hits.sort((left, right) => geniusPoints(right.result, info) - geniusPoints(left.result, info));
    const hit = hits[0]?.result;
    if (!hit?.path) return null;
    const page = await runtime.request(`https://genius.com${hit.path}`);
    if (!page?.ok || !page.body) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(page.body, "text/html");
    const containers = doc.querySelectorAll('[data-lyrics-container="true"]');
    if (!containers.length) return null;
    const text = Array.from(containers)
      .map((item) => item.textContent?.replace(/\n\n+/g, "\n") || "")
      .filter(Boolean)
      .join("\n")
      .trim();
    return { title: hit.title || info.title, artists: [hit.primary_artist?.name || info.artist], lines: null, lyrics: text || null };
  }

  async function fetchMusixMatch(info) {
    await initMusixmatch();
    if (!musixmatchToken) return null;
    const params = new URLSearchParams({
      app_id: "web-desktop-app-v1.0",
      usertoken: musixmatchToken,
      q_track: info.title,
      q_artist: info.artist,
      page_size: "5",
    });
    const search = await musixmatchRequest(`track.search?${params}`);
    const trackList = search?.body ? JSON.parse(search.body)?.message?.body?.track_list : [];
    if (!Array.isArray(trackList) || !trackList.length) return null;
    const track = trackList
      .map((item) => item.track)
      .sort((left, right) => jaroWinkler(right.track_name, info.title) - jaroWinkler(left.track_name, info.title))[0];
    if (!track?.track_id) return null;

    let lines = null;
    if (track.has_subtitles) {
      const subParams = new URLSearchParams({
        app_id: "web-desktop-app-v1.0",
        usertoken: musixmatchToken,
        track_id: String(track.track_id),
        subtitle_format: "lrc",
      });
      const sub = await musixmatchRequest(`track.subtitle.get?${subParams}`);
      const body = sub?.body ? JSON.parse(sub.body)?.message?.body?.subtitle?.subtitle_body : "";
      if (body) lines = parseLrc(body).lines;
    }

    let lyrics = null;
    if (!lines && track.has_lyrics) {
      const lyricParams = new URLSearchParams({
        app_id: "web-desktop-app-v1.0",
        usertoken: musixmatchToken,
        track_id: String(track.track_id),
      });
      const lyricRes = await musixmatchRequest(`track.lyrics.get?${lyricParams}`);
      lyrics = lyricRes?.body ? JSON.parse(lyricRes.body)?.message?.body?.lyrics?.lyrics_body : null;
    }

    if (!lines && !lyrics) return null;
    return { title: track.track_name || info.title, artists: [track.artist_name || info.artist], lines, lyrics };
  }

  async function initMusixmatch() {
    if (musixmatchToken && musixmatchTokenExpires > Date.now()) return;
    const params = new URLSearchParams({ app_id: "web-desktop-app-v1.0" });
    const response = await musixmatchRequest(`token.get?${params}`);
    const parsed = response?.body ? JSON.parse(response.body) : null;
    musixmatchToken = parsed?.message?.body?.user_token || null;
    musixmatchTokenExpires = Date.now() + 60_000;
  }

  async function musixmatchRequest(path) {
    const response = await runtime.request(`https://apic-desktop.musixmatch.com/ws/1.1/${path}`, {
      headers: { Cookie: musixmatchCookie, Authority: "apic-desktop.musixmatch.com" },
    });
    const cookie = Object.entries(response?.headers || {}).find(([name]) => name.toLowerCase() === "set-cookie")?.[1];
    if (cookie) musixmatchCookie = cookie;
    return response;
  }

  async function requestJson(url, init) {
    const response = await runtime.request(url, init);
    if (!response?.ok || !response.body) return null;
    try {
      return JSON.parse(response.body);
    } catch {
      return null;
    }
  }

  function geniusPoints(result, info) {
    return (result?.title === info.title ? 1 : 0) + (result?.primary_artist?.name?.includes(info.artist) ? 1 : 0);
  }

  function parseLrc(text) {
    const lines = [];
    const tags = [];
    let offset = 0;
    const timestampRegex = /^\[(?<minutes>\d+):(?<seconds>\d+)\.(?<centiseconds>\d+)\]/m;
    const tagRegex = /^\[(?<tag>\w+):\s*(?<value>.+?)\s*\]$/;
    const wordRegex = /<(?<minutes>\d+):(?<seconds>\d+)\.(?<centiseconds>\d+)>\s*(?<word>\S+)/g;

    for (let raw of String(text || "").split("\n")) {
      raw = raw.trim();
      if (!raw.startsWith("[")) continue;
      const timestamps = [];
      let match;
      while ((match = raw.match(timestampRegex)?.groups)) {
        const { minutes, seconds, centiseconds } = match;
        const timeInMs =
          parseInt(minutes, 10) * 60 * 1000 +
          parseInt(seconds, 10) * 1000 +
          parseInt(centiseconds.padEnd(3, "0"), 10);
        timestamps.push({
          time: `${minutes}:${seconds}.${centiseconds}`,
          timeInMs,
        });
        raw = raw.replace(timestampRegex, "");
      }

      if (!timestamps.length) {
        const tag = raw.match(tagRegex)?.groups;
        if (tag) {
          if (tag.tag === "offset") offset = parseInt(tag.value, 10) || 0;
          else tags.push({ tag: tag.tag, value: tag.value });
        }
        continue;
      }

      let lineText = raw.trim();
      const words = Array.from(lineText.matchAll(wordRegex), ({ groups }) => {
        const { minutes, seconds, centiseconds, word } = groups;
        const timeInMs =
          parseInt(minutes, 10) * 60 * 1000 +
          parseInt(seconds, 10) * 1000 +
          parseInt(centiseconds.padEnd(3, "0"), 10);
        return { timeInMs, word };
      });

      if (words.length) {
        lineText = words.map(({ word }) => word).join(" ");
      }

      for (const { time, timeInMs } of timestamps) {
        lines.push({
          time,
          timeInMs,
          text: lineText,
          words,
          duration: Infinity,
        });
      }
    }

    lines.sort((a, b) => a.timeInMs - b.timeInMs);
    for (let i = 0; i < lines.length; i++) {
      lines[i].timeInMs += offset;
      if (lines[i + 1]) {
        lines[i].duration = Math.max(0, lines[i + 1].timeInMs - lines[i].timeInMs);
      }
    }

    if (lines[0]?.timeInMs > 300) {
      lines.unshift({
        time: "00:00.00",
        timeInMs: 0,
        duration: lines[0].timeInMs,
        text: "",
        words: [],
      });
    }

    return { tags, lines };
  }

  function formatTime(ms) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    const centiseconds = Math.floor((ms % 1_000) / 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
  }

  function jaroWinkler(left, right) {
    if (left === right) return 1;
    if (!left.length || !right.length) return 0;
    const range = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0);
    const leftMatches = Array(left.length).fill(false);
    const rightMatches = Array(right.length).fill(false);
    let matches = 0;
    for (let i = 0; i < left.length; i++) {
      const start = Math.max(0, i - range);
      const end = Math.min(i + range + 1, right.length);
      for (let j = start; j < end; j++) {
        if (rightMatches[j] || left[i] !== right[j]) continue;
        leftMatches[i] = true;
        rightMatches[j] = true;
        matches++;
        break;
      }
    }
    if (!matches) return 0;
    const leftChars = left.split("").filter((_, index) => leftMatches[index]);
    const rightChars = right.split("").filter((_, index) => rightMatches[index]);
    const transpositions = leftChars.reduce((count, char, index) => count + (char !== rightChars[index] ? 1 : 0), 0) / 2;
    const jaro = (matches / left.length + matches / right.length + (matches - transpositions) / matches) / 3;
    let prefix = 0;
    while (prefix < 4 && prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  function ensureContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (container && document.body.contains(container)) return container;

    const tabRenderer = getLyricsTabRenderer();
    if (!tabRenderer) return null;

    if (!container) {
      container = document.createElement("div");
      container.id = CONTAINER_ID;
    }
    tabRenderer.appendChild(container);
    return container;
  }

  function setupHeaderObserver() {
    const header = getLyricsTabHeader();
    if (!header) return;

    header.removeAttribute("disabled");
    header.removeAttribute("aria-disabled");

    if (!header.__ytmSlBound) {
      header.__ytmSlBound = true;
      header.addEventListener("click", () => {
        setTimeout(render, 50);
        setTimeout(render, 300);
      });
    }

    if (!headerObserver) {
      headerObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.attributeName === "disabled") {
            header.removeAttribute("disabled");
            header.removeAttribute("aria-disabled");
          } else if (mutation.attributeName === "aria-selected") {
            render();
          }
        }
      });
      headerObserver.observe(header, { attributes: true, attributeFilter: ["disabled", "aria-selected"] });
    }
  }

  function onUserScroll() {
    isUserScrolling = true;
    if (userScrollTimeout) window.clearTimeout(userScrollTimeout);
    userScrollTimeout = window.setTimeout(() => {
      isUserScrolling = false;
    }, 4000);
  }

  function applyEffect() {
    const effect = config().lyrics_line_effect || "fancy";
    if (document?.documentElement?.dataset) {
      document.documentElement.dataset.lyricsEffect = effect;
    }
  }

  function render() {
    const version = ++renderVersion;
    applyEffect();
    const container = ensureContainer();
    if (!container) return;

    if (activeTrack) {
      const entry = CACHE.get(activeTrack.videoId);
      if (entry?.selectedProvider && PROVIDERS.includes(entry.selectedProvider)) {
        currentProvider = entry.selectedProvider;
      }
    }

    const current = state()?.[currentProvider];
    const providerIndex = PROVIDERS.indexOf(currentProvider);
    const starred = activeTrack ? readStarred(activeTrack.videoId) : null;

    container.replaceChildren();
    const root = document.createElement("div");
    root.className = "lyrics-renderer";

    const pickerWrap = document.createElement("div");
    pickerWrap.className = "lyrics-picker-sticky";
    const picker = document.createElement("div");
    picker.className = "lyrics-picker";
    picker.append(
      pickerButton("‹", "lyrics-picker-left", () => selectProvider(providerIndex - 1)),
      pickerCenter(current, starred),
      pickerButton("›", "lyrics-picker-right", () => selectProvider(providerIndex + 1)),
    );
    pickerWrap.appendChild(picker);
    root.appendChild(pickerWrap);

    const vlist = document.createElement("div");
    vlist.className = "synced-lyrics-vlist";
    vlist.addEventListener("wheel", onUserScroll, { passive: true });
    vlist.addEventListener("touchmove", onUserScroll, { passive: true });
    root.appendChild(vlist);
    container.appendChild(root);

    let isHoveringTop = false;
    const updatePickerVisibility = (show) => {
      if (show === isHoveringTop) return;
      isHoveringTop = show;
      pickerWrap.style.setProperty("--lyrics-picker-top", show ? "0px" : "-60px");
      pickerWrap.style.setProperty("--lyrics-picker-opacity", show ? "1" : "0");
      pickerWrap.style.setProperty("--lyrics-picker-pointer", show ? "auto" : "none");
    };

    container.addEventListener("mousemove", (e) => {
      const top = container.getBoundingClientRect().top;
      const mouseY = e.clientY - top;
      const isOver = mouseY >= 0 && mouseY <= (picker.offsetHeight || 55) + 12;
      updatePickerVisibility(isOver);
    }, { passive: true });

    container.addEventListener("mouseleave", () => {
      updatePickerVisibility(false);
    }, { passive: true });

    if (!current || current.state === "fetching") {
      renderLoadingKaomoji(vlist);
      return;
    }
    if (current.state === "error") {
      renderErrorDisplay(vlist, current.error?.message || "Failed to fetch lyrics.", () => retryCurrentProvider(version));
      return;
    }
    if (current.data?.lines?.length) {
      renderSynced(vlist, current.data.lines);
      return;
    }
    if (current.data?.lyrics) {
      renderPlain(vlist, current.data.lyrics);
      return;
    }
    renderNotFoundKaomoji(vlist);
  }

  function pickerButton(glyph, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = glyph;
    button.addEventListener("click", onClick);
    return button;
  }

  function pickerCenter(current, starred) {
    const center = document.createElement("div");
    center.className = "lyrics-picker-content";

    const labelRow = document.createElement("div");
    labelRow.className = "lyrics-picker-content-label";

    const item = document.createElement("div");
    item.className = "lyrics-picker-item";

    const status = document.createElement("span");
    const statusClass = current?.state === "fetching"
      ? "fetching"
      : current?.state === "error"
      ? "error"
      : current?.data?.lines?.length || current?.data?.lyrics
      ? "done"
      : "warning";
    status.className = `lyrics-picker-status ${statusClass}`;
    status.textContent = current?.state === "fetching" ? "…" : current?.state === "error" ? "✕" : current?.data?.lines?.length ? "✓" : current?.data?.lyrics ? "≡" : "!";
    item.appendChild(status);

    const title = document.createElement("span");
    title.textContent = currentProvider;
    item.appendChild(title);

    const star = document.createElement("button");
    star.type = "button";
    star.className = "lyrics-picker-star";
    star.textContent = starred === currentProvider ? "★" : "☆";
    star.addEventListener("click", toggleStar);
    item.appendChild(star);

    labelRow.appendChild(item);
    center.appendChild(labelRow);

    const dots = document.createElement("ul");
    dots.className = "lyrics-picker-content-dots";
    PROVIDERS.forEach((name, index) => {
      const dot = document.createElement("li");
      dot.className = `lyrics-picker-dot${name === currentProvider ? " active" : ""}`;
      dot.addEventListener("click", () => selectProvider(index));
      dots.appendChild(dot);
    });
    center.appendChild(dots);
    return center;
  }

  function renderLoadingKaomoji(target) {
    const box = document.createElement("div");
    box.className = "kaomoji-container";
    box.textContent = "{ (>_<) }";
    target.appendChild(box);
  }

  function renderNotFoundKaomoji(target) {
    const box = document.createElement("div");
    box.className = "kaomoji-container";
    box.textContent = "＼(〇_ｏ)／";
    target.appendChild(box);
  }

  function renderErrorDisplay(target, message, onRetry) {
    const wrap = document.createElement("div");
    wrap.className = "error-container";
    const box = document.createElement("div");
    box.className = "error-box";
    box.textContent = message;
    wrap.appendChild(box);
    if (onRetry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "retry-btn";
      btn.textContent = "Retry";
      btn.addEventListener("click", onRetry);
      wrap.appendChild(btn);
    }
    target.appendChild(wrap);
  }

  function retryCurrentProvider(version) {
    if (!activeTrack) return;
    const entry = CACHE.get(activeTrack.videoId);
    if (!entry) return;
    fetchProvider(currentProvider, activeTrack, entry).then(() => {
      if (version === renderVersion) render();
    });
  }

  function renderPlain(target, text) {
    const lines = text.split("\n").filter((l) => l.trim());
    lines.forEach((line) => {
      const wrap = document.createElement("div");
      wrap.className = "synced-line";
      const lineText = document.createElement("div");
      lineText.className = "text-lyrics";
      const inner = document.createElement("span");
      const span = document.createElement("span");
      span.textContent = line;
      inner.appendChild(span);
      lineText.appendChild(inner);
      wrap.appendChild(lineText);
      target.appendChild(wrap);
    });
  }

  function renderSynced(target, lines) {
    lines.forEach((line, index) => {
      const lineEl = document.createElement("div");
      const rawText = clean(line.text);
      const isInstrumental = !rawText || rawText === "♪" || rawText === "..." || rawText === "•••";
      lineEl.className = `synced-line${isInstrumental ? " instrumental" : ""}`;
      lineEl.dataset.index = String(index);

      const text = document.createElement("div");
      text.className = "text-lyrics";
      text.style.setProperty("--lyrics-duration", `${Math.max(line.duration, 1000) / 1000}s`, "important");
      text.addEventListener("click", () => seek(line.timeInMs, lineEl));

      if (config().lyrics_show_timecodes && line.time) {
        const time = document.createElement("span");
        time.className = "timecode";
        time.textContent = `[${line.time}]`;
        text.appendChild(time);
      }

      const wordsWrap = document.createElement("span");
      const words = (isInstrumental ? "♪" : (line.text || "♪")).split(" ");
      words.forEach((word, wIdx) => {
        const span = document.createElement("span");
        span.style.transitionDelay = `${wIdx * 0.05}s`;
        span.style.animationDelay = `${wIdx * 0.05}s`;
        span.textContent = `${word} `;
        wordsWrap.appendChild(span);
      });
      text.appendChild(wordsWrap);

      if (config().lyrics_romanization && line.text && !isInstrumental) {
        const romaji = document.createElement("span");
        romaji.className = "romaji";
        const rWords = line.text.split(" ");
        rWords.forEach((word, wIdx) => {
          const span = document.createElement("span");
          span.style.transitionDelay = `${wIdx * 0.05}s`;
          span.style.animationDelay = `${wIdx * 0.05}s`;
          span.textContent = `${word} `;
          romaji.appendChild(span);
        });
        text.appendChild(romaji);
      }

      lineEl.appendChild(text);
      target.appendChild(lineEl);
    });
    updateCurrentLine();
  }

  function seek(timeInMs, lineEl) {
    isUserScrolling = false;
    if (lineEl) {
      lineEl.classList.add("line-seek-pulse");
      window.setTimeout(() => lineEl.classList.remove("line-seek-pulse"), 400);
    }
    const player = getPlayer();
    if (typeof player?.seekTo === "function") {
      player.seekTo((timeInMs + 10) / 1000);
      return;
    }
    const media = runtime.media();
    if (media) media.currentTime = Math.max(0, (timeInMs + 10) / 1000);
  }

  function updateCurrentLine() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    const current = state()?.[currentProvider]?.data?.lines;
    if (!current?.length) return;

    const player = getPlayer();
    const currentTimeSec = typeof player?.getCurrentTime === "function"
      ? player.getCurrentTime()
      : (runtime.media()?.currentTime || 0);
    const currentTimeMs = currentTimeSec * 1000;
    const currentIndex = current.findLastIndex((line) => line.timeInMs <= currentTimeMs);

    if (currentIndex === lastCurrentIndex) return;
    lastCurrentIndex = currentIndex;

    const lines = container.querySelectorAll(".synced-line");
    lines.forEach((line, index) => {
      line.classList.toggle("current", index === currentIndex);
      line.classList.toggle("previous", index < currentIndex);
      line.classList.toggle("upcoming", index > currentIndex);
    });

    if (currentIndex >= 0 && lines[currentIndex] && !isUserScrolling) {
      const vlist = container.querySelector(".synced-lyrics-vlist");
      if (vlist) {
        const target = lines[currentIndex];
        const top = target.offsetTop - vlist.clientHeight * 0.38;
        vlist.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
    }
  }

  function refreshTrack() {
    const info = trackInfo();
    if (!info) return;

    if (activeTrack?.videoId !== info.videoId || activeTrack?.title !== info.title) {
      activeTrack = info;
      manuallySwitched = false;
      lastCurrentIndex = -1;
      ensureTrack(info);
      render();
    }
  }

  function start() {
    installStyle();
    setupHeaderObserver();
    refreshTrack();

    const player = getPlayer();
    if (player && !player.__ytmSyncedLyricsBound) {
      player.__ytmSyncedLyricsBound = true;
      player.addEventListener("videodatachange", () => refreshTrack());
    }

    updateInterval = window.setInterval(updateCurrentLine, config().lyrics_precise_timing ? 100 : 250);
    trackPollInterval = window.setInterval(() => {
      setupHeaderObserver();
      refreshTrack();
      ensureContainer();
    }, 1000);

    render();
  }

  function stop() {
    if (headerObserver) headerObserver.disconnect();
    headerObserver = null;
    window.clearInterval(updateInterval);
    window.clearInterval(trackPollInterval);
    const container = document.getElementById(CONTAINER_ID);
    if (container) container.remove();
  }

  function update() {
    setupHeaderObserver();
    render();
  }

  runtime.register("synced_lyrics", { start, stop, update });
})();
