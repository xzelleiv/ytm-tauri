(() => {
  // authenticated page requests
  if (typeof location !== "object" || location.hostname !== "music.youtube.com") return;
  if (window.__ytmPlaylistManagerData) return;

  const MAX_PAGES = 10000;
  const MAX_ACTIONS = 10000;
  const BATCH_SIZE = 25;
  let mutationChain = Promise.resolve();

  function getInnertubeConfig() {
    if (!window.ytcfg || typeof window.ytcfg.get !== "function") {
      throw new Error("missing ytcfg session");
    }
    const apiKey = window.ytcfg.get("INNERTUBE_API_KEY");
    const context = window.ytcfg.get("INNERTUBE_CONTEXT");
    if (!apiKey || !context) throw new Error("missing ytcfg session");
    return { apiKey, context };
  }

  function cookie(name) {
    if (typeof document !== "object" || !document.cookie) return null;
    const match = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function sapisidHash(sapisid) {
    if (!sapisid || typeof crypto !== "object" || !crypto.subtle) return null;
    const time = Math.floor(Date.now() / 1000);
    const bytes = new TextEncoder().encode(`${time} ${sapisid} https://music.youtube.com`);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${time}_${hex}`;
  }

  async function callInnertube(endpoint, body, signal) {
    const config = getInnertubeConfig();
    const headers = {
      "Content-Type": "application/json",
      "X-Origin": "https://music.youtube.com",
    };
    const sapisid = cookie("SAPISID") || cookie("__Secure-3PAPISID") || cookie("__Secure-1PAPISID") || cookie("APISID");
    if (sapisid) {
      const hash = await sapisidHash(sapisid);
      if (hash) headers.Authorization = `SAPISIDHASH ${hash}`;
    }
    const get = window.ytcfg.get.bind(window.ytcfg);
    const clientName = get("INNERTUBE_CLIENT_NAME") || 67;
    const clientVersion = get("INNERTUBE_CLIENT_VERSION");
    const authUser = get("SESSION_INDEX") ?? get("AUTH_USER") ?? "0";
    const visitorData = get("VISITOR_DATA");
    const idToken = get("ID_TOKEN");
    if (clientName) headers["X-YouTube-Client-Name"] = String(clientName);
    if (clientVersion) headers["X-YouTube-Client-Version"] = String(clientVersion);
    if (authUser !== undefined) headers["X-Goog-AuthUser"] = String(authUser);
    if (visitorData) headers["X-Goog-Visitor-Id"] = String(visitorData);
    if (idToken) headers["X-YouTube-Identity-Token"] = String(idToken);

    const timeout = typeof AbortSignal === "function" && AbortSignal.timeout ? AbortSignal.timeout(30000) : null;
    const requestSignal = timeout && signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout;
    const response = await fetch(`/youtubei/v1/${endpoint}?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context: config.context, ...body }),
      signal: requestSignal,
    });
    if (!response.ok) {
      const hint = { 400: "YouTube Music rejected the request. Refresh the playlists before retrying.", 401: "Your YouTube Music session expired. Sign in again.", 403: "YouTube Music denied access. Check that you can edit this playlist.", 429: "YouTube Music is limiting requests. Wait before retrying." }[response.status] || "YouTube Music could not confirm the request. Refresh before retrying.";
      throw new Error(`${hint} (HTTP ${response.status})`);
    }
    const data = await response.json();
    if (!data || (data.responseContext === undefined && data.playlistId === undefined && !(endpoint === "browse/edit_playlist" && data.status))) {
      throw new Error("invalid YouTube Music response");
    }
    if (endpoint === "browse/edit_playlist" && data.status !== "STATUS_SUCCEEDED") {
      throw new Error(data.status === "STATUS_FAILED" ? "YouTube Music rejected this batch. Refresh the destination to check for existing songs or changed permissions." : "YouTube Music did not confirm this batch. Refresh both playlists before retrying.");
    }
    if (endpoint === "browse/edit_playlist" && Array.isArray(data.playlistEditResults)
      && data.playlistEditResults.some((entry) => [entry.status, entry.playlistEditResult].includes("STATUS_FAILED"))) {
      throw new Error("YouTube Music reported a partial batch failure. Refresh both playlists before retrying.");
    }
    return data;
  }

  function text(value) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    if (typeof value.simpleText === "string") return value.simpleText.trim();
    if (Array.isArray(value.runs)) return value.runs.map((run) => run && run.text || "").join("").trim();
    return "";
  }

  function findObjects(root, names) {
    const found = [];
    const seen = new Set();
    function visit(value) {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (names.has(key) && child && typeof child === "object") found.push(child);
        visit(child);
      }
    }
    visit(root);
    return found;
  }

  function findValues(root, names) {
    const found = [];
    const seen = new Set();
    function visit(value) {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (names.has(key)) found.push(child);
        visit(child);
      }
    }
    visit(root);
    return found;
  }

  function arrayAt(root, names) {
    for (const node of findObjects(root, names)) {
      if (Array.isArray(node)) return node;
      for (const key of ["contents", "items"]) if (Array.isArray(node[key])) return node[key];
    }
    return [];
  }

  function normalizeId(value) {
    const id = String(value || "").trim();
    const normalized = id.startsWith("VL") ? id.slice(2) : id;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) throw new Error("invalid playlist id");
    return normalized;
  }

  function endpointVideoId(item) {
    const candidates = [
      item.playlistItemData && item.playlistItemData.videoId,
      item.videoId,
      item.navigationEndpoint && item.navigationEndpoint.watchEndpoint && item.navigationEndpoint.watchEndpoint.videoId,
      item.playNavigationEndpoint && item.playNavigationEndpoint.watchEndpoint && item.playNavigationEndpoint.watchEndpoint.videoId,
      item.playButton?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId,
      item.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId,
      item.overlay && item.overlay.musicItemThumbnailOverlayRenderer && item.overlay.musicItemThumbnailOverlayRenderer.content && item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer && item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint && item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint.watchEndpoint && item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint.watchEndpoint.videoId,
    ];
    return candidates.find((value) => typeof value === "string" && value.trim())?.trim() || null;
  }

  function endpointSetId(item) {
    const data = item.playlistItemData || {};
    const menuActions = findValues(item, new Set(["playlistEditEndpoint"]))
      .flatMap((endpoint) => Array.isArray(endpoint?.actions) ? endpoint.actions : []);
    return [data.setVideoId, data.playlistSetVideoId, item.setVideoId, ...menuActions.map((action) => action?.setVideoId)]
      .find((value) => typeof value === "string" && value.trim())?.trim() || null;
  }

  function itemTitle(item) {
    const flex = item.flexColumns || [];
    const first = flex[0] && flex[0].musicResponsiveListItemFlexColumnRenderer;
    const title = text(first && first.text);
    if (title) return title;
    return text(item.title) || text(item.videoId);
  }

  function parseItem(item, occurrenceNumbers, usedIds, originalIndex) {
    const videoId = endpointVideoId(item);
    const setVideoId = endpointSetId(item);
    const title = itemTitle(item);
    const numberKey = setVideoId || videoId || title || "unavailable";
    const number = occurrenceNumbers.get(numberKey) || 0;
    occurrenceNumbers.set(numberKey, number + 1);
    let occurrenceId = setVideoId || (videoId ? `video:${videoId}:${number}` : `unavailable:${number}`);
    if (setVideoId && usedIds.has(setVideoId)) {
      throw new Error("Playlist changed while loading. Reload it before making changes.");
    }
    if (usedIds.has(occurrenceId)) {
      let suffix = 1;
      while (usedIds.has(`${occurrenceId}:${suffix}`)) suffix += 1;
      occurrenceId = `${occurrenceId}:${suffix}`;
    }
    usedIds.add(occurrenceId);
    const flex = item.flexColumns || [];
    const columns = flex.map((column) => column?.musicResponsiveListItemFlexColumnRenderer || {});
    const columnRuns = columns.map((column) => column.text?.runs || []);
    const pageType = (run) => String(run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || "");
    let artistColumn = null;
    let albumColumn = null;
    for (let index = 0; index < columnRuns.length; index += 1) {
      const type = pageType(columnRuns[index][0]);
      if (type === "MUSIC_PAGE_TYPE_ARTIST" || type === "MUSIC_PAGE_TYPE_USER_CHANNEL" || type === "MUSIC_PAGE_TYPE_UNKNOWN") artistColumn ??= index;
      if (type === "MUSIC_PAGE_TYPE_ALBUM" || type === "MUSIC_PAGE_TYPE_AUDIOBOOK") albumColumn ??= index;
    }
    artistColumn ??= columnRuns.length > 1 ? 1 : null;
    const artistRuns = artistColumn === null ? [] : columnRuns[artistColumn];
    const artists = artistRuns.map((run) => run?.text || "").map((value) => value.trim()).filter((value) => value && value !== "•" && value !== ",");
    const albumRuns = albumColumn === null ? [] : columnRuns[albumColumn];
    const album = text({ runs: albumRuns }) || null;
    const fixedText = text(item.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
    const durationRun = columnRuns.flat().find((run) => /\b\d{1,3}:\d{2}(?::\d{2})?\b/.test(String(run?.text || "")));
    const durationMatch = (fixedText || String(durationRun?.text || "")).match(/\b(\d{1,3}:\d{2}(?::\d{2})?)\b/);
    const durationParts = durationMatch ? durationMatch[1].split(":").map(Number) : [];
    const durationSeconds = durationParts.length === 3 ? durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2] : durationParts.length === 2 ? durationParts[0] * 60 + durationParts[1] : 0;
    const available = item.isAvailable !== false && item.musicItemRendererDisplayPolicy !== "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT";
    return {
      occurrenceId,
      setVideoId,
      videoId,
      title: title || "Unavailable song",
      artists,
      album,
      thumbnail: findValues(item.thumbnail || {}, new Set(["url"]))
        .find((url) => typeof url === "string" && /^https:\/\//i.test(url)) || null,
      durationSeconds,
      originalIndex,
      isAvailable: available,
      editable: !!setVideoId,
    };
  }

  function extractContinuation(root) {
    const shelves = findObjects(root, new Set(["musicPlaylistShelfRenderer", "musicPlaylistShelfContinuation"]));
    const appended = continuationItems(root);
    const scopes = appended ? [appended] : shelves;
    const continuations = scopes.flatMap((shelf) => findValues(shelf, new Set(["continuationCommand", "nextContinuationData"])));
    for (const node of continuations) {
      if (node?.request && node.request !== "CONTINUATION_REQUEST_TYPE_BROWSE") continue;
      if (node && typeof node.token === "string" && node.token.trim()) return node.token.trim();
      if (node && typeof node.continuation === "string" && node.continuation.trim()) return node.continuation.trim();
    }
    return null;
  }

  function parseTotal(root) {
    const headers = findObjects(root, new Set(["musicResponsiveHeaderRenderer", "musicEditablePlaylistDetailHeaderRenderer", "musicPlaylistHeaderRenderer"]));
    for (const header of headers) {
      const countRun = (header.secondSubtitle?.runs || []).find((run) => /\b(?:song|video|track)s?\b/i.test(String(run?.text || "")) && /\d/.test(String(run?.text || "")));
      const match = String(countRun?.text || "").match(/[\d,]+/);
      if (match) {
        const total = Number(match[0].replace(/,/g, ""));
        if (Number.isSafeInteger(total)) return total;
      }
    }
    const candidates = findValues(root, new Set(["numVideosText", "trackCount", "videoCount"]));
    for (const node of candidates) {
      const value = typeof node === "number" ? String(node) : typeof node === "string" ? node : text(node);
      const match = value.match(/[\d,]+/);
      if (match) {
        const total = Number(match[0].replace(/,/g, ""));
        if (Number.isSafeInteger(total)) return total;
      }
    }
    return null;
  }

  function parsePage(root, state) {
    const items = [];
    const shelfItems = playlistContentItems(root);
    for (const entry of shelfItems) {
      const item = ["musicResponsiveListItemRenderer", "musicTwoRowItemRenderer", "playlistPanelVideoRenderer"]
        .map((key) => entry?.[key]).find((value) => value && typeof value === "object") || null;
      if (!item) continue;
      items.push(parseItem(item, state.occurrenceNumbers, state.usedIds, state.originalIndex));
      state.originalIndex += 1;
    }
    const unique = [];
    const seen = new Set();
    for (const item of items) if (!seen.has(item.occurrenceId)) {
      seen.add(item.occurrenceId);
      unique.push(item);
    }
    return unique;
  }

  function playlistContentItems(root) {
    const appended = continuationItems(root);
    if (appended) return appended;
    const secondaryContents = findObjects(root, new Set(["secondaryContents"]));
    const scopes = secondaryContents.length ? secondaryContents : [root];
    const shelves = scopes.flatMap((scope) => findObjects(scope, new Set(["musicPlaylistShelfRenderer", "musicPlaylistShelfContinuation"])));
    if (!shelves.length) throw new Error("YouTube Music returned an unsupported playlist page. Please reload and try again.");
    const items = shelves.flatMap((shelf) => Array.isArray(shelf.contents) ? shelf.contents : []);
    return items;
  }

  function continuationItems(root) {
    const actions = root.onResponseReceivedActions || root.onResponseReceivedEndpoints || [];
    for (const action of actions) {
      const items = action?.appendContinuationItemsAction?.continuationItems;
      if (Array.isArray(items)) return items;
    }
    return null;
  }

  function parsePlaylist(root, id, state) {
    const items = parsePage(root, state);
    const editableHeader = findObjects(root, new Set(["musicEditablePlaylistDetailHeaderRenderer"]));
    const owned = editableHeader.length > 0;
    const header = editableHeader[0] || {};
    const responsive = findObjects(header, new Set(["musicResponsiveHeaderRenderer", "musicPlaylistHeaderRenderer"]))[0]
      || findObjects(root, new Set(["musicResponsiveHeaderRenderer", "musicPlaylistHeaderRenderer"]))[0]
      || header;
    const title = text(responsive.title) || text(header.title) || `Playlist ${id}`;
    return {
      id,
      title,
      description: text(responsive.description) || null,
      owned,
      editable: owned && id !== "LM",
      total: parseTotal(root),
      items,
      continuation: extractContinuation(root),
    };
  }

  function progress(onProgress, loaded, total, page) {
    if (typeof onProgress === "function") onProgress({ loaded, total, page });
  }

  async function readPlaylist(id, options = {}) {
    const playlistId = normalizeId(id);
    const signal = options.signal;
    const state = { occurrenceNumbers: new Map(), usedIds: new Set(), originalIndex: 0 };
    let page = await callInnertube("browse", { browseId: `VL${playlistId}` }, signal);
    let playlist = parsePlaylist(page, playlistId, state);
    const allItems = playlist.items.slice();
    let continuation = playlist.continuation;
    let pageNumber = 1;
    progress(options.onProgress, allItems.length, playlist.total, pageNumber);
    const seenTokens = new Set();
    while (continuation) {
      if (pageNumber >= MAX_PAGES) throw new Error("playlist pagination exceeded safety limit");
      if (seenTokens.has(continuation)) throw new Error("playlist pagination repeated a continuation token");
      seenTokens.add(continuation);
      page = await callInnertube("browse", { continuation }, signal);
      const nextItems = parsePage(page, state);
      allItems.push(...nextItems);
      pageNumber += 1;
      continuation = extractContinuation(page);
      progress(options.onProgress, allItems.length, playlist.total, pageNumber);
    }
    if (playlist.total !== null && allItems.length < playlist.total) {
      throw new Error(`playlist pagination incomplete (${allItems.length}/${playlist.total})`);
    }
    playlist.items = allItems;
    playlist.total = playlist.total === null ? allItems.length : Math.max(playlist.total, allItems.length);
    delete playlist.continuation;
    return playlist;
  }

  function stableItems(items) {
    if (!Array.isArray(items)) throw new Error("playlist items must be an array");
    return items.filter((item) => item && typeof item.occurrenceId === "string");
  }

  function snapshotFingerprint(items) {
    return JSON.stringify(stableItems(items).map((item) => [item.occurrenceId, item.setVideoId || null, item.videoId || null]));
  }

  function expectedSnapshot(items, options) {
    return options?.snapshotFingerprint || snapshotFingerprint(items);
  }

  function sortItems(items, field = "title", direction = "asc") {
    const source = stableItems(items);
    const sign = direction === "desc" ? -1 : 1;
    return source.map((item, index) => ({ item, index })).sort((a, b) => {
      const rawA = a.item[field] ?? "";
      const rawB = b.item[field] ?? "";
      const av = typeof rawA === "number" ? rawA : String(rawA).toLocaleLowerCase();
      const bv = typeof rawB === "number" ? rawB : String(rawB).toLocaleLowerCase();
      if (av < bv) return -sign;
      if (av > bv) return sign;
      return a.index - b.index;
    }).map(({ item }) => item);
  }

  function filterItems(items, query = "", options = {}) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    const availableOnly = options.availableOnly === true;
    return stableItems(items).filter((item) => {
      if (availableOnly && !item.isAvailable) return false;
      if (!needle) return true;
      return [item.title, ...(item.artists || [])].some((value) => String(value || "").toLocaleLowerCase().includes(needle));
    });
  }

  function dedupeItems(items, key = "videoId") {
    const seen = new Set();
    const duplicateOccurrenceIds = [];
    const unique = [];
    for (const item of stableItems(items)) {
      const value = item[key];
      if (!value) {
        unique.push(item);
        continue;
      }
      if (seen.has(value)) {
        duplicateOccurrenceIds.push(item.occurrenceId);
        continue;
      }
      seen.add(value);
      unique.push(item);
    }
    return { unique, duplicateOccurrenceIds };
  }

  function planSort(items, field = "title", direction = "asc", options = {}) {
    const current = stableItems(items);
    const target = sortItems(current, field, direction);
    return planOrder(current, target, options);
  }

  // preserve playlist occurrence identity
  function planOrder(current, target, options) {
    const working = current.slice();
    const actions = [];
    const blocked = options.editable === true ? [] : current.map((item) => ({ occurrenceId: item.occurrenceId, reason: "playlist is not editable" }));
    if (blocked.length) return { kind: "sort", editable: false, actions, blocked, targetOccurrenceIds: target.map((item) => item.occurrenceId), snapshotFingerprint: expectedSnapshot(current, options) };
    const missingSetIds = current.filter((item) => !item.setVideoId);
    if (missingSetIds.length) return { kind: "sort", editable: true, actions, blocked: missingSetIds.map((item) => ({ occurrenceId: item.occurrenceId, reason: "missing setVideoId" })), targetOccurrenceIds: target.map((item) => item.occurrenceId), snapshotFingerprint: expectedSnapshot(current, options) };
    for (let index = 0; index < target.length; index += 1) {
      if (working[index] === target[index]) continue;
      const from = working.findIndex((item) => item.occurrenceId === target[index].occurrenceId);
      const moved = working[from];
      const successor = working[index];
      if (!moved.setVideoId || !successor?.setVideoId) {
        blocked.push({ occurrenceId: moved.occurrenceId, reason: "missing setVideoId" });
        continue;
      }
      actions.push({ action: "ACTION_MOVE_VIDEO_BEFORE", setVideoId: moved.setVideoId, movedSetVideoIdSuccessor: successor.setVideoId, occurrenceId: moved.occurrenceId });
      working.splice(from, 1);
      working.splice(index, 0, moved);
    }
    return { kind: "sort", editable: true, actions, blocked, targetOccurrenceIds: target.map((item) => item.occurrenceId), snapshotFingerprint: expectedSnapshot(current, options) };
  }

  function planPosition(items, selectedIds, position, options = {}) {
    const current = stableItems(items);
    const selected = new Set(selectedIds);
    const block = current.filter((item) => selected.has(item.occurrenceId));
    const rest = current.filter((item) => !selected.has(item.occurrenceId));
    if (!block.length || !Number.isInteger(position) || position < 1 || position > rest.length + 1) {
      throw new Error(`Choose a starting position from 1 to ${rest.length + 1}.`);
    }
    const target = [...rest.slice(0, position - 1), ...block, ...rest.slice(position - 1)];
    if (options.editable !== true || current.some((item) => !item.setVideoId) || target.every((item, index) => item === current[index])) {
      return planOrder(current, target, options);
    }
    // append selected occurrences in order
    const successor = rest[position - 1];
    const actions = block.map((item) => ({
      action: "ACTION_MOVE_VIDEO_BEFORE", setVideoId: item.setVideoId,
      ...(successor ? { movedSetVideoIdSuccessor: successor.setVideoId } : {}),
      occurrenceId: item.occurrenceId,
    }));
    return { kind: "sort", editable: true, actions, blocked: [], targetOccurrenceIds: target.map((item) => item.occurrenceId), snapshotFingerprint: expectedSnapshot(current, options) };
  }

  function planRemove(items, options = {}) {
    const actions = [];
    const blocked = options.editable === true ? [] : stableItems(items).map((item) => ({ occurrenceId: item.occurrenceId, reason: "playlist is not editable" }));
    if (blocked.length) return { kind: "remove", editable: false, actions, blocked, snapshotFingerprint: expectedSnapshot(stableItems(items), options) };
    for (const item of stableItems(items)) {
      if (!item.setVideoId || !item.videoId) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: "missing setVideoId or videoId" });
        continue;
      }
      actions.push({ action: "ACTION_REMOVE_VIDEO", setVideoId: item.setVideoId, removedVideoId: item.videoId, occurrenceId: item.occurrenceId });
    }
    return { kind: "remove", editable: true, actions, blocked, snapshotFingerprint: expectedSnapshot(stableItems(items), options) };
  }

  function planCopy(sourceItems, destinationPlaylistId, options = {}) {
    const destinationId = normalizeId(destinationPlaylistId);
    const actions = [];
    const blocked = options.editable === true ? [] : stableItems(sourceItems).map((item) => ({ occurrenceId: item.occurrenceId, reason: "destination playlist is not editable" }));
    if (blocked.length) return { kind: "copy", editable: false, playlistId: destinationId, actions, blocked, snapshotFingerprint: expectedSnapshot(stableItems(sourceItems), options) };
    const seen = new Set();
    for (const item of stableItems(sourceItems)) {
      if (!item.videoId || item.isAvailable === false) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: "unavailable or missing videoId" });
        continue;
      }
      if (options.dedupe && seen.has(item.videoId)) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: "duplicate videoId" });
        continue;
      }
      seen.add(item.videoId);
      actions.push({ action: "ACTION_ADD_VIDEO", addedVideoId: item.videoId, occurrenceId: item.occurrenceId });
    }
    return { kind: "copy", editable: true, playlistId: destinationId, actions, blocked, snapshotFingerprint: expectedSnapshot(stableItems(sourceItems), options) };
  }

  function planMove(items, successor, options = {}) {
    const selected = stableItems(items);
    const target = stableItems([successor])[0];
    const blocked = [];
    const actions = [];
    if (options.editable !== true) return { kind: "move", editable: false, actions, blocked: selected.map((item) => ({ occurrenceId: item.occurrenceId, reason: "playlist is not editable" })), snapshotFingerprint: expectedSnapshot(selected, options) };
    if (!target || !target.setVideoId) return { kind: "move", editable: true, actions, blocked: [{ occurrenceId: target?.occurrenceId || null, reason: "missing successor setVideoId" }], snapshotFingerprint: expectedSnapshot(selected, options) };
    for (const item of selected) {
      if (!item.setVideoId || item.occurrenceId === target.occurrenceId) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: item.occurrenceId === target.occurrenceId ? "item is already the successor" : "missing setVideoId" });
        continue;
      }
      actions.push({ action: "ACTION_MOVE_VIDEO_BEFORE", setVideoId: item.setVideoId, movedSetVideoIdSuccessor: target.setVideoId, occurrenceId: item.occurrenceId });
    }
    return { kind: "move", editable: true, actions, blocked, snapshotFingerprint: expectedSnapshot(selected, options) };
  }

  function planTransfer(sourceItems, destinationPlaylistId, options = {}) {
    const destinationId = normalizeId(destinationPlaylistId);
    const sourceId = options.sourcePlaylistId ? normalizeId(options.sourcePlaylistId) : null;
    const selected = stableItems(sourceItems);
    const blocked = [];
    const seen = new Set();
    const existing = new Set(options.destinationVideoIds || []);
    if (sourceId && sourceId === destinationId) blocked.push({ occurrenceId: null, reason: "source and destination playlists must differ" });
    if (!sourceId) blocked.push({ occurrenceId: null, reason: "sourcePlaylistId is required" });
    if (options.destinationEditable !== true) blocked.push({ occurrenceId: null, reason: "destination playlist is not editable" });
    if (options.removeSource !== false && options.sourceEditable !== true) blocked.push({ occurrenceId: null, reason: "source playlist is not editable" });
    const entries = [];
    for (const item of selected) {
      if (existing.has(item.videoId)) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: "already in destination" });
        continue;
      }
      if (options.removeSource !== false && !item.setVideoId) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: "missing playlist entry identifier" });
        continue;
      }
      if (!item.videoId || item.isAvailable === false) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: "unavailable or missing videoId" });
        continue;
      }
      if (options.dedupe && seen.has(item.videoId)) {
        blocked.push({ occurrenceId: item.occurrenceId, reason: "duplicate videoId" });
        continue;
      }
      seen.add(item.videoId);
      entries.push({
        occurrenceId: item.occurrenceId,
        copyAction: { action: "ACTION_ADD_VIDEO", addedVideoId: item.videoId },
        removeAction: { action: "ACTION_REMOVE_VIDEO", setVideoId: item.setVideoId, removedVideoId: item.videoId },
      });

    }
    const structurallyEditable = !!sourceId && sourceId !== destinationId && options.destinationEditable === true && (options.removeSource === false || options.sourceEditable === true);
    return { kind: "transfer", sourcePlaylistId: sourceId, playlistId: destinationId, removeSource: options.removeSource !== false, entries, blocked, selectedCount: selected.length, editable: structurallyEditable, snapshotFingerprint: options.sourceSnapshotFingerprint || expectedSnapshot(selected, options) };
  }

  async function executePlan(plan, options = {}) {
    if (!plan || !Array.isArray(plan.actions)) throw new Error("invalid playlist mutation plan");
    const playlistId = normalizeId(options.playlistId || plan.playlistId);
    if (plan.editable !== true || options.editable === false) return { ok: false, attempted: 0, succeeded: 0, failed: 0, blocked: [{ occurrenceId: null, reason: "playlist is not editable" }], results: [] };
    if (!plan.snapshotFingerprint || options.snapshotFingerprint !== plan.snapshotFingerprint) return { ok: false, attempted: 0, succeeded: 0, failed: 0, blocked: [{ occurrenceId: null, reason: "playlist changed; reread before applying" }], results: [] };
    if (plan.actions.length > MAX_ACTIONS) throw new Error("too many playlist actions");
    const results = [];
    const blocked = Array.isArray(plan.blocked) ? plan.blocked.slice() : [];
    let cancelled = false;
    const batchSize = plan.kind === "remove" || plan.kind === "copy" ? BATCH_SIZE : 1;
    for (let index = 0; index < plan.actions.length; index += batchSize) {
      if (options.signal?.aborted) { cancelled = true; break; }
      const batch = plan.actions.slice(index, index + batchSize);
      const actions = batch.map(({ occurrenceId, ...action }) => action);
      try {
        await callInnertube("browse/edit_playlist", { playlistId, actions }, options.signal);
        results.push(...batch.map((action) => ({ occurrenceId: action.occurrenceId || null, ok: true })));
      } catch (error) {
        cancelled = error?.name === "AbortError";
        results.push(...batch.map((action) => ({ occurrenceId: action.occurrenceId || null, ok: false, cancelled, error: String(error?.message || error) })));
        break;
      }
      if (typeof options.onProgress === "function") options.onProgress({ completed: results.length, total: plan.actions.length });
    }
    return { ok: !cancelled && blocked.length === 0 && results.length === plan.actions.length && results.every((result) => result.ok), cancelled, attempted: results.length, succeeded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, blocked, results };
  }

  function enqueue(plan, options) {
    const run = mutationChain.then(() => executePlan(plan, options));
    mutationChain = run.catch(() => {});
    return run;
  }

  async function executeTransfer(plan, options = {}) {
    if (!plan || plan.kind !== "transfer" || !Array.isArray(plan.entries)) throw new Error("invalid playlist transfer plan");
    if (plan.editable !== true) return { ok: false, attempted: 0, copied: 0, removed: 0, failed: 0, blocked: plan.blocked || [], results: [] };
    if (plan.entries.length > MAX_ACTIONS) throw new Error("too many playlist transfer actions");
    if (!plan.snapshotFingerprint || options.snapshotFingerprint !== plan.snapshotFingerprint) return { ok: false, attempted: 0, copied: 0, removed: 0, failed: 0, blocked: [{ occurrenceId: null, reason: "source playlist changed; reread before applying" }], results: [] };
    const results = [];
    let copied = 0;
    let removed = 0;
    let cancelled = false;
    for (let index = 0; index < plan.entries.length; index += BATCH_SIZE) {
      if (options.signal?.aborted) { cancelled = true; break; }
      const batch = plan.entries.slice(index, index + BATCH_SIZE);
      const batchResults = batch.map((entry) => ({ occurrenceId: entry.occurrenceId, copied: false, removed: false, ok: false }));
      try {
        await callInnertube("browse/edit_playlist", { playlistId: plan.playlistId, actions: batch.map((entry) => entry.copyAction) }, options.signal);
        batchResults.forEach((result) => { result.copied = true; });
        copied += batch.length;
        if (plan.removeSource) {
          if (options.signal?.aborted) throw new DOMException("Cancelled after copying; source songs kept", "AbortError");
          await callInnertube("browse/edit_playlist", { playlistId: plan.sourcePlaylistId, actions: batch.map((entry) => entry.removeAction) }, options.signal);
          batchResults.forEach((result) => { result.removed = true; });
          removed += batch.length;
        }
        batchResults.forEach((result) => { result.ok = true; });
      } catch (error) {
        batchResults.forEach((result) => { result.error = String(error?.message || error); });
        if (error?.name === "AbortError") cancelled = true;
      }
      results.push(...batchResults);
      if (typeof options.onProgress === "function") options.onProgress({ completed: results.length, total: plan.entries.length });
      if (batchResults.some((result) => !result.ok)) break;
    }
    const blocked = Array.isArray(plan.blocked) ? plan.blocked.slice() : [];
    return { ok: !cancelled && blocked.length === 0 && results.length === plan.entries.length && results.every((result) => result.ok), cancelled, attempted: results.length, copied, removed, failed: results.filter((result) => !result.ok).length, blocked, results };
  }

  function enqueueTransfer(plan, options) {
    const run = mutationChain.then(() => executeTransfer(plan, options));
    mutationChain = run.catch(() => {});
    return run;
  }

  // include private destination playlists
  async function listDestinations(videoId, { signal } = {}) {
    const response = await callInnertube("playlist/get_add_to_playlist", {
      videoIds: videoId ? [videoId] : [], excludeWatchLater: true,
    }, signal);
    const options = findObjects(response, new Set(["playlistAddToOptionRenderer", "addToPlaylistItemRenderer"]));
    const seen = new Set();
    return options.flatMap((option) => {
      const id = option.playlistId;
      const title = text(option.title);
      if (!id || !title || ["LM", "WL"].includes(id) || seen.has(id)) return [];
      seen.add(id);
      return [{ id, title, privacy: String(option.privacy || "").toLowerCase() }];
    });
  }

  window.__ytmPlaylistManagerData = {
    planPosition,
    listDestinations,
    readPlaylist,
    sortItems,
    filterItems,
    dedupeItems,
    planSort,
    planRemove,
    planCopy,
    planMove,
    planTransfer,
    snapshotFingerprint,
    executePlan: enqueue,
    executeTransfer: enqueueTransfer,
    mutations: { execute: enqueue, transfer: enqueueTransfer },
    _test: { parseItem, parsePage, normalizeId },
  };
})();
