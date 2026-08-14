(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime || location.origin !== "https://music.youtube.com") return;

  const PROVIDERS = ["YTMusic", "LRCLib", "MusixMatch", "LyricsGenius"];
  const HEADER = "#tabsContent > .tab-header:nth-of-type(2)";
  const TAB = '#tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]';
  const STYLE_ID = "ytm-tauri-synced-lyrics-style";
  const CONTAINER_ID = "synced-lyrics-container";
  const STAR_KEY = "ytmd-sl-starred-";
  const CACHE = new Map();

  let observer = null;
  let timer = 0;
  let trackTimer = 0;
  let activeTrack = null;
  let currentProvider = PROVIDERS[0];
  let manuallySwitched = false;
  let renderVersion = 0;
  let lastCurrentIndex = -1;
  let musixmatchToken = null;
  let musixmatchTokenExpires = 0;
  let musixmatchCookie = "x-mxm-user-id=";

  const state = () => CACHE.get(activeTrack?.videoId)?.providers || null;
  const config = () => runtime.config;
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const styles = `
html.ytm-tauri-synced-lyrics ${TAB} > :not(#${CONTAINER_ID}) { display: none !important; }
html.ytm-tauri-synced-lyrics ${TAB} > #${CONTAINER_ID} { display: block !important; height: 100%; }
html.ytm-tauri-synced-lyrics ${TAB} { scrollbar-width: none; }
#${CONTAINER_ID} {
  height: 100%;
  --lyrics-font-family: Satoshi, Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
  --lyrics-font-size: 3rem;
  --lyrics-line-height: 1.333;
  --lyrics-width: 100%;
  --lyrics-padding: 2rem;
  --lyrics-inactive-weight: 700;
  --lyrics-inactive-opacity: .33;
  --lyrics-inactive-scale: .95;
  --lyrics-active-weight: 700;
  --lyrics-active-opacity: 1;
  --lyrics-active-scale: 1;
  --lyrics-active-offset: 0;
}
#${CONTAINER_ID}[data-effect="scale"] { --lyrics-font-size: clamp(1.4rem, 1.1vmax, 3rem); --lyrics-line-height: var(--ytmusic-body-line-height); --lyrics-width: 83%; --lyrics-padding: 0; --lyrics-inactive-weight: 400; --lyrics-inactive-scale: 1; --lyrics-active-scale: 1.2; }
#${CONTAINER_ID}[data-effect="offset"] { --lyrics-font-size: clamp(1.4rem, 1.1vmax, 3rem); --lyrics-line-height: var(--ytmusic-body-line-height); --lyrics-padding: 0; --lyrics-inactive-weight: 400; --lyrics-inactive-scale: 1; --lyrics-active-offset: 5%; }
#${CONTAINER_ID}[data-effect="focus"] { --lyrics-font-size: clamp(1.4rem, 1.1vmax, 3rem); --lyrics-line-height: var(--ytmusic-body-line-height); --lyrics-padding: 0; --lyrics-inactive-weight: 400; --lyrics-inactive-scale: 1; }
.ytm-sl-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.ytm-sl-picker-wrap { position: sticky; top: 0; z-index: 10; backdrop-filter: blur(5px); background: linear-gradient(to bottom, rgba(3,3,3,.72), rgba(3,3,3,.34), transparent); transition: transform 325ms ease-in-out; }
.ytm-sl-picker { height: 5em; display: flex; align-items: center; justify-content: space-around; padding-block: 1em; box-sizing: border-box; }
.ytm-sl-picker-button { width: 40px; height: 40px; border: 0; border-radius: 25%; background: transparent; color: var(--ytmusic-text-primary, #fff); display: grid; place-items: center; cursor: pointer; }
.ytm-sl-picker-button:hover { background: hsla(0,0%,100%,.1); }
.ytm-sl-picker-center { width: 50%; min-width: 180px; display: flex; flex-direction: column; align-items: center; gap: 7px; }
.ytm-sl-picker-label { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; font-size: 1.4rem; color: var(--ytmusic-text-primary, #fff); }
.ytm-sl-status { width: 18px; height: 18px; display: inline-grid; place-items: center; font-size: 15px; }
.ytm-sl-star { border: 0; background: transparent; color: var(--ytmusic-text-primary, #fff); cursor: pointer; font-size: 20px; line-height: 1; padding: 2px 4px; }
.ytm-sl-dots { display: flex; gap: 8px; margin: 0; padding: 0; list-style: none; }
.ytm-sl-dot { width: 5px; height: 5px; border: 1px solid #6e7c7c7f; border-radius: 50%; background: #000; cursor: pointer; }
.ytm-sl-dot.current { background: #fff; }
.ytm-sl-scroll { flex: 1; overflow-y: auto; scrollbar-width: none; padding-top: 4px; }
.ytm-sl-scroll::-webkit-scrollbar { display: none; }
.ytm-sl-lines { min-height: 100%; padding: 0 20px 45vh 0; box-sizing: border-box; }
.ytm-sl-line { width: var(--lyrics-width); margin: .5rem 20px .5rem 0; transition: all .3s ease-in-out; transform-origin: 0 50%; }
.ytm-sl-text { cursor: pointer; display: flex; flex-direction: column; text-align: left; font-family: var(--lyrics-font-family) !important; font-size: var(--lyrics-font-size) !important; font-weight: var(--lyrics-inactive-weight) !important; line-height: var(--lyrics-line-height) !important; padding: var(--lyrics-padding) 0 var(--lyrics-padding) 1.5rem; scale: var(--lyrics-inactive-scale); translate: 0; transition: scale .166s, translate .3s ease-in-out; color: var(--ytmusic-text-primary, #fff); }
.ytm-sl-words { opacity: var(--lyrics-inactive-opacity); transition: opacity .33s; }
.ytm-sl-word { display: inline-block; white-space: pre-wrap; }
.ytm-sl-line.current .ytm-sl-text { font-weight: var(--lyrics-active-weight) !important; scale: var(--lyrics-active-scale); translate: var(--lyrics-active-offset); }
.ytm-sl-line.current .ytm-sl-words { opacity: var(--lyrics-active-opacity); }
#${CONTAINER_ID}[data-effect="fancy"] .ytm-sl-line.current .ytm-sl-word { animation: ytm-sl-glow var(--line-duration, 2s) forwards, ytm-sl-wobble calc(var(--line-duration, 2s) / 2) forwards; }
.ytm-sl-time { color: var(--ytmusic-text-secondary, #aaa); font-size: .42em; font-weight: 500; margin-bottom: .25rem; }
.ytm-sl-romaji { color: var(--ytmusic-text-secondary, #aaa); font-size: .7em; font-style: italic; margin-top: .25rem; }
.ytm-sl-message { padding: 48px 24px; color: var(--ytmusic-text-secondary, #aaa); font-size: 1.6rem; line-height: 1.5; text-align: center; }
.ytm-sl-error { color: #ff8a80; }
.ytm-sl-retry { display: block; margin: 16px auto 0; border: 0; border-radius: 18px; padding: 8px 16px; background: rgba(255,255,255,.12); color: #fff; cursor: pointer; }
@keyframes ytm-sl-wobble { 0%,100% { transform: translateY(0); } 33.33% { transform: translateY(1.75px); } 66.66% { transform: translateY(-1.75px); } }
@keyframes ytm-sl-glow { from { text-shadow: 0 0 1.5rem rgba(255,255,255,.5); } to { text-shadow: 0 0 0 rgba(255,255,255,0); } }
`;

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = styles;
    document.documentElement.appendChild(style);
  }

  function currentVideoId() {
    try {
      const urlId = new URL(location.href).searchParams.get("v");
      if (urlId) return urlId;
    } catch {}
    const anchor = document.querySelector("ytmusic-player-bar a[href*='watch'][href*='v=']");
    try {
      return anchor ? new URL(anchor.href, location.href).searchParams.get("v") : null;
    } catch {
      return null;
    }
  }

  function trackInfo() {
    const videoId = currentVideoId();
    const media = runtime.media();
    const metadata = navigator.mediaSession?.metadata;
    const title = clean(metadata?.title || document.querySelector("ytmusic-player-bar .title")?.textContent);
    const artist = clean(metadata?.artist || document.querySelector("ytmusic-player-bar .byline")?.textContent?.split(/[•·]/)[0]);
    const album = clean(metadata?.album || "");
    const duration = Number.isFinite(media?.duration) ? media.duration : 0;
    if (!videoId || !title) return null;
    return { videoId, title, alternativeTitle: title, artist, album, songDuration: duration };
  }

  function blankProviderState() {
    return Object.fromEntries(PROVIDERS.map((name) => [name, { state: "fetching", data: null, error: null }]));
  }

  function ensureTrack(info) {
    let entry = CACHE.get(info.videoId);
    if (!entry) {
      entry = { status: "loading", providers: blankProviderState() };
      CACHE.set(info.videoId, entry);
      for (const name of PROVIDERS) fetchProvider(name, info, entry);
    }
    return entry;
  }

  async function fetchProvider(name, info, entry) {
    const provider = entry.providers[name];
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
    autoPickProvider();
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
      return;
    }
    const available = PROVIDERS.filter(usable).sort((a, b) => providerBias(b) - providerBias(a));
    if (available.length && providerBias(available[0]) > providerBias(currentProvider)) currentProvider = available[0];
  }

  function readStarred(videoId) {
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
    if (readStarred(activeTrack.videoId) === currentProvider) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ provider: currentProvider }));
    render();
  }

  function selectProvider(index, manual = true) {
    currentProvider = PROVIDERS[(index + PROVIDERS.length) % PROVIDERS.length];
    if (manual) manuallySwitched = true;
    render();
  }

  function providerSearch(name, info) {
    switch (name) {
      case "YTMusic": return fetchYtmLyrics(info);
      case "LRCLib": return fetchLrcLib(info);
      case "MusixMatch": return fetchMusixMatch(info);
      case "LyricsGenius": return fetchGenius(info);
      default: return Promise.resolve(null);
    }
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

  async function fetchLrcLib(info) {
    const query = new URLSearchParams({ artist_name: info.artist, track_name: info.title });
    if (info.album) query.set("album_name", info.album);
    let data = await requestJson(`https://lrclib.net/api/search?${query}`);
    if ((!Array.isArray(data) || data.length === 0) && config().lyrics_show_inexact) {
      data = await requestJson(`https://lrclib.net/api/search?${new URLSearchParams({ q: info.alternativeTitle || info.title })}`);
      if ((!Array.isArray(data) || data.length === 0) && info.alternativeTitle && info.alternativeTitle !== info.title) {
        data = await requestJson(`https://lrclib.net/api/search?${new URLSearchParams({ q: info.title })}`);
      }
    }
    if (!Array.isArray(data)) return null;
    const artists = splitArtists(info.artist);
    const matches = data.filter((item) => {
      const candidateArtists = splitArtists(item.artistName);
      return Math.max(...artists.flatMap((left) => candidateArtists.map((right) => jaroWinkler(left.toLowerCase(), right.toLowerCase()))), 0) > 0.9;
    });
    matches.sort((a, b) => Math.abs(Number(a.duration) - info.songDuration) - Math.abs(Number(b.duration) - info.songDuration));
    const result = matches[0];
    if (!result || Math.abs(Number(result.duration) - info.songDuration) > 15 || result.instrumental) return null;
    if (!result.syncedLyrics && !result.plainLyrics) return null;
    return {
      title: result.trackName,
      artists: splitArtists(result.artistName),
      lines: result.syncedLyrics ? parseLrc(result.syncedLyrics).lines : null,
      lyrics: result.plainLyrics || null,
    };
  }

  async function fetchGenius(info) {
    const query = new URLSearchParams({ q: `${info.artist} ${info.title}`, page: "1", per_page: "10" });
    const data = await requestJson(`https://genius.com/api/search/song?${query}`);
    const hits = data?.response?.sections?.[0]?.hits;
    if (!Array.isArray(hits) || !hits.length) return null;
    hits.sort((a, b) => geniusPoints(b.result, info) - geniusPoints(a.result, info));
    const result = hits[0]?.result;
    if (!result || result.primary_artist?.url === "https://genius.com/artists/Deleted-artist") return null;
    const response = await runtime.request(`https://genius.com${result.path}`);
    if (!response?.ok || !response.body) return null;
    const doc = new DOMParser().parseFromString(response.body, "text/html");
    const script = [...doc.querySelectorAll("script")].find((node) => node.textContent?.includes("window.__PRELOADED_STATE__"));
    const raw = script?.textContent?.match(/__PRELOADED_STATE__ = JSON\.parse\('(.*?)'\);/)?.[1]?.replace(/\\"/g, '"');
    const html = raw?.match(/body\":\{\"html\":\"(.*?)\",\"children\"/)?.[1]
      ?.replace(/\\\//g, "/")
      ?.replace(/\\\\/g, "\\")
      ?.replace(/\\n/g, "\n")
      ?.replace(/\\'/g, "'")
      ?.replace(/\\"/g, '"');
    if (!html) return /lyricsPlaceholderReason.{1,5}unreleased/.test(raw || "") ? null : null;
    const lyricsDoc = new DOMParser().parseFromString(html, "text/html");
    const lyrics = lyricsDoc.body.innerText;
    if (lyrics.trim().toLowerCase().replace(/[\[\]]/g, "") === "instrumental") return null;
    return { title: result.title, artists: result.primary_artists?.map((artist) => artist.name) || [info.artist], lines: null, lyrics };
  }

  async function fetchMusixMatch(info) {
    await ensureMusixMatchToken();
    if (!musixmatchToken) return null;
    const params = new URLSearchParams({
      app_id: "web-desktop-app-v1.0",
      format: "json",
      usertoken: musixmatchToken,
      q_track: info.alternativeTitle || info.title,
      q_artist: info.artist,
      q_duration: String(info.songDuration),
      namespace: "lyrics_richsynched",
      subtitle_format: "lrc",
    });
    if (info.album) params.set("q_album", info.album);
    let response = await musixmatchRequest(`macro.subtitles.get?${params}`);
    let parsed = response?.body ? JSON.parse(response.body) : null;
    if (parsed?.message?.header?.status_code === 401) {
      musixmatchToken = null;
      musixmatchTokenExpires = 0;
      await ensureMusixMatchToken();
      params.set("usertoken", musixmatchToken || "");
      response = await musixmatchRequest(`macro.subtitles.get?${params}`);
      parsed = response?.body ? JSON.parse(response.body) : null;
    }
    const calls = parsed?.message?.body?.macro_calls;
    const track = calls?.["matcher.track.get"]?.message?.body?.track;
    if (!track || track.track_id === 115264642) return null;
    const lyrics = calls?.["track.lyrics.get"]?.message?.body?.lyrics?.lyrics_body || null;
    const subtitle = calls?.["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body;
    return {
      title: track.track_name,
      artists: [track.artist_name],
      lines: subtitle ? parseLrc(subtitle).lines : null,
      lyrics,
    };
  }

  async function ensureMusixMatchToken() {
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
    return JSON.parse(response.body);
  }

  function geniusPoints(result, info) {
    return (result?.title === info.title ? 1 : 0) + (result?.primary_artist?.name?.includes(info.artist) ? 1 : 0);
  }

  function splitArtists(value) {
    return clean(value).split(/[&,]/).map(clean).filter(Boolean);
  }

  function parseLrc(text) {
    const lines = [];
    const tags = [];
    let offset = 0;
    const timestamp = /^\[(?<minutes>\d+):(?<seconds>\d+)\.(?<fraction>\d+)\]/;
    const tag = /^\[(?<tag>\w+):\s*(?<value>.+?)\s*\]$/;
    const word = /<(?<minutes>\d+):(?<seconds>\d+)\.(?<fraction>\d+)>\s*(?<word>\S+)/g;
    for (let raw of String(text || "").split("\n")) {
      raw = raw.trim();
      if (!raw.startsWith("[")) continue;
      const times = [];
      let match;
      while ((match = raw.match(timestamp)?.groups)) {
        const timeInMs = toMs(match.minutes, match.seconds, match.fraction);
        times.push({ time: `${match.minutes}:${match.seconds}.${match.fraction}`, timeInMs });
        raw = raw.replace(timestamp, "");
      }
      if (!times.length) {
        const meta = raw.match(tag)?.groups;
        if (meta?.tag === "offset") offset = Number.parseInt(meta.value, 10) || 0;
        else if (meta) tags.push({ tag: meta.tag, value: meta.value });
        continue;
      }
      const words = [...raw.matchAll(word)].map((item) => ({ timeInMs: toMs(item.groups.minutes, item.groups.seconds, item.groups.fraction), word: item.groups.word }));
      const lyricText = words.length ? words.map((item) => item.word).join(" ") : raw.trim();
      for (const item of times) lines.push({ ...item, timeInMs: item.timeInMs + offset, duration: Infinity, text: lyricText, words });
    }
    lines.sort((a, b) => a.timeInMs - b.timeInMs);
    for (let index = 0; index < lines.length - 1; index++) lines[index].duration = Math.max(0, lines[index + 1].timeInMs - lines[index].timeInMs);
    if (lines[0]?.timeInMs > 300) lines.unshift({ time: "00:00.00", timeInMs: 0, duration: lines[0].timeInMs, text: "", words: [] });
    return { tags, lines };
  }

  function toMs(minutes, seconds, fraction) {
    return Number.parseInt(minutes, 10) * 60_000 + Number.parseInt(seconds, 10) * 1_000 + Number.parseInt(String(fraction).padEnd(3, "0").slice(0, 3), 10);
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
    const tab = document.querySelector(TAB);
    if (!tab) return null;
    let container = tab.querySelector(`#${CONTAINER_ID}`);
    if (!container) {
      container = document.createElement("div");
      container.id = CONTAINER_ID;
      tab.appendChild(container);
    }
    container.dataset.effect = config().lyrics_line_effect || "fancy";
    return container;
  }

  function forceLyricsTab() {
    const header = document.querySelector(HEADER);
    if (!header) return;
    header.removeAttribute("disabled");
  }

  function render() {
    const version = ++renderVersion;
    const container = ensureContainer();
    if (!container) return;
    container.dataset.effect = config().lyrics_line_effect || "fancy";
    const current = state()?.[currentProvider];
    const providerIndex = PROVIDERS.indexOf(currentProvider);
    const starred = activeTrack ? readStarred(activeTrack.videoId) : null;

    container.innerHTML = "";
    const root = document.createElement("div");
    root.className = "ytm-sl-root";
    const pickerWrap = document.createElement("div");
    pickerWrap.className = "ytm-sl-picker-wrap";
    const picker = document.createElement("div");
    picker.className = "ytm-sl-picker";
    picker.append(
      pickerButton("‹", () => selectProvider(providerIndex - 1)),
      pickerCenter(current, starred),
      pickerButton("›", () => selectProvider(providerIndex + 1)),
    );
    pickerWrap.appendChild(picker);
    root.appendChild(pickerWrap);

    const scroll = document.createElement("div");
    scroll.className = "ytm-sl-scroll";
    const linesRoot = document.createElement("div");
    linesRoot.className = "ytm-sl-lines";
    scroll.appendChild(linesRoot);
    root.appendChild(scroll);
    container.appendChild(root);

    let mouseY = 0;
    const updatePicker = (event) => {
      if (typeof event?.clientY === "number") mouseY = event.clientY;
      const top = container.getBoundingClientRect().top;
      const show = scroll.scrollTop <= picker.offsetHeight || mouseY - top <= picker.offsetHeight + 5;
      pickerWrap.style.transform = show ? "translateY(0)" : `translateY(-${picker.offsetHeight}px)`;
    };
    scroll.addEventListener("scroll", updatePicker, { passive: true });
    container.addEventListener("mousemove", updatePicker, { passive: true });

    if (!current || current.state === "fetching") {
      message(linesRoot, "(っ˘ω˘ς )", "Loading lyrics…");
      return;
    }
    if (current.state === "error") {
      message(linesRoot, "(╥﹏╥)", current.error?.message || "Lyrics provider failed.", true, () => retryCurrentProvider(version));
      return;
    }
    if (current.data?.lines?.length) {
      renderSynced(linesRoot, current.data.lines);
      updateCurrentLine();
      return;
    }
    if (current.data?.lyrics) {
      renderPlain(linesRoot, current.data.lyrics);
      return;
    }
    message(linesRoot, "¯\\_(ツ)_/¯", "No lyrics found for this provider.");
  }

  function pickerButton(label, handler) {
    const button = document.createElement("button");
    button.className = "ytm-sl-picker-button";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function pickerCenter(current, starred) {
    const center = document.createElement("div");
    center.className = "ytm-sl-picker-center";
    const label = document.createElement("div");
    label.className = "ytm-sl-picker-label";
    const status = document.createElement("span");
    status.className = "ytm-sl-status";
    status.textContent = current?.state === "fetching" ? "◌" : current?.state === "error" ? "!" : usable(currentProvider) ? "✓" : "△";
    const name = document.createElement("span");
    name.textContent = currentProvider;
    const star = document.createElement("button");
    star.type = "button";
    star.className = "ytm-sl-star";
    star.textContent = starred === currentProvider ? "★" : "☆";
    star.title = starred === currentProvider ? "Use automatic provider selection" : "Prefer this provider for this track";
    star.addEventListener("click", toggleStar);
    label.append(status, name, star);
    center.appendChild(label);
    const dots = document.createElement("ul");
    dots.className = "ytm-sl-dots";
    PROVIDERS.forEach((provider, index) => {
      const dot = document.createElement("li");
      dot.className = `ytm-sl-dot${provider === currentProvider ? " current" : ""}`;
      dot.title = provider;
      dot.addEventListener("click", () => selectProvider(index));
      dots.appendChild(dot);
    });
    center.appendChild(dots);
    return center;
  }

  function message(parent, face, text, error = false, retry) {
    const node = document.createElement("div");
    node.className = `ytm-sl-message${error ? " ytm-sl-error" : ""}`;
    const faceNode = document.createElement("div");
    faceNode.textContent = face;
    const textNode = document.createElement("div");
    textNode.textContent = text;
    node.append(faceNode, textNode);
    if (retry) {
      const button = document.createElement("button");
      button.className = "ytm-sl-retry";
      button.type = "button";
      button.textContent = "Retry";
      button.addEventListener("click", retry);
      node.appendChild(button);
    }
    parent.appendChild(node);
  }

  function renderSynced(parent, lines) {
    for (const line of lines) {
      const node = document.createElement("div");
      node.className = "ytm-sl-line upcoming";
      node.dataset.time = String(line.timeInMs);
      node.dataset.duration = String(line.duration);
      const text = document.createElement("div");
      text.className = "ytm-sl-text";
      text.style.setProperty("--line-duration", `${Number.isFinite(line.duration) ? line.duration / 1000 : 2}s`);
      if (config().lyrics_show_timecodes) {
        const time = document.createElement("span");
        time.className = "ytm-sl-time";
        time.textContent = `[${line.time}]`;
        text.appendChild(time);
      }
      const words = document.createElement("span");
      words.className = "ytm-sl-words";
      const value = clean(line.text) || "♪";
      value.split(" ").forEach((word, index) => {
        const span = document.createElement("span");
        span.className = "ytm-sl-word";
        span.style.animationDelay = `${index * 0.05}s`;
        span.style.transitionDelay = `${index * 0.05}s`;
        span.textContent = `${word} `;
        words.appendChild(span);
      });
      text.appendChild(words);
      text.addEventListener("click", () => {
        const media = runtime.media();
        if (media) media.currentTime = (line.timeInMs + 10) / 1000;
      });
      node.appendChild(text);
      parent.appendChild(node);
    }
  }

  function renderPlain(parent, lyrics) {
    for (const line of String(lyrics).split("\n").map((value) => value.trim()).filter(Boolean)) {
      const node = document.createElement("div");
      node.className = "ytm-sl-line";
      const text = document.createElement("div");
      text.className = "ytm-sl-text";
      const words = document.createElement("span");
      words.className = "ytm-sl-words";
      words.style.opacity = "1";
      words.textContent = line;
      text.appendChild(words);
      node.appendChild(text);
      parent.appendChild(node);
    }
  }

  function updateCurrentLine() {
    const container = document.getElementById(CONTAINER_ID);
    const lines = [...(container?.querySelectorAll(".ytm-sl-line[data-time]") || [])];
    if (!lines.length) return;
    const now = (runtime.media()?.currentTime || 0) * 1000;
    let currentIndex = -1;
    lines.forEach((node, index) => {
      const start = Number(node.dataset.time);
      const duration = Number(node.dataset.duration);
      const status = start >= now ? "upcoming" : now - start >= duration ? "previous" : "current";
      node.classList.remove("upcoming", "previous", "current");
      node.classList.add(status);
      if (status === "current") currentIndex = index;
    });
    if (currentIndex !== -1 && currentIndex !== lastCurrentIndex) {
      lastCurrentIndex = currentIndex;
      const target = lines[Math.min(currentIndex + 1, lines.length - 1)];
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function retryCurrentProvider(version) {
    if (version !== renderVersion || !activeTrack) return;
    const entry = CACHE.get(activeTrack.videoId);
    if (entry) fetchProvider(currentProvider, activeTrack, entry);
  }

  function refreshTrack() {
    const info = trackInfo();
    if (!info) return;
    if (activeTrack?.videoId === info.videoId) return;
    activeTrack = info;
    manuallySwitched = false;
    lastCurrentIndex = -1;
    currentProvider = readStarred(info.videoId) || PROVIDERS[0];
    ensureTrack(info);
    autoPickProvider();
    render();
  }

  function start() {
    installStyle();
    document.documentElement.classList.add("ytm-tauri-synced-lyrics");
    forceLyricsTab();
    observer = new MutationObserver(() => {
      forceLyricsTab();
      ensureContainer();
      refreshTrack();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-selected"] });
    refreshTrack();
    timer = window.setInterval(updateCurrentLine, config().lyrics_precise_timing ? 100 : 250);
    trackTimer = window.setInterval(refreshTrack, 1000);
    render();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    window.clearInterval(timer);
    window.clearInterval(trackTimer);
    timer = 0;
    trackTimer = 0;
    document.documentElement.classList.remove("ytm-tauri-synced-lyrics");
    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    activeTrack = null;
    manuallySwitched = false;
    lastCurrentIndex = -1;
  }

  function update() {
    const container = document.getElementById(CONTAINER_ID);
    if (container) container.dataset.effect = config().lyrics_line_effect || "fancy";
    if (timer) {
      window.clearInterval(timer);
      timer = window.setInterval(updateCurrentLine, config().lyrics_precise_timing ? 100 : 250);
    }
    render();
  }

  runtime.register("synced_lyrics", { start, stop, update });
})();
