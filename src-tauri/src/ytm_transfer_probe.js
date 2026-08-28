(() => {
  if (typeof location === "object" && location.hostname && location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytmTransferAdapter) return;

  const BATCH_SIZE = 25;
  const SONGS_SEARCH_PARAMS = "Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D";

  function getInnertubeConfig() {
    if (!window.ytcfg || typeof window.ytcfg.get !== "function") {
      return null;
    }
    const apiKey = window.ytcfg.get("INNERTUBE_API_KEY");
    const context = window.ytcfg.get("INNERTUBE_CONTEXT");
    if (!apiKey || !context) return null;
    return { apiKey, context };
  }

  function parseDurationText(text) {
    if (!text || typeof text !== "string") return 0;
    const parts = text.trim().split(":");
    if (parts.length === 2) {
      const mins = parseInt(parts[0], 10) || 0;
      const secs = parseInt(parts[1], 10) || 0;
      return mins * 60 + secs;
    } else if (parts.length === 3) {
      const hours = parseInt(parts[0], 10) || 0;
      const mins = parseInt(parts[1], 10) || 0;
      const secs = parseInt(parts[2], 10) || 0;
      return hours * 3600 + mins * 60 + secs;
    }
    return 0;
  }

  function cleanSearchQuery(title, artists) {
    if (!title) return "";
    let cleanTitle = title
      .replace(/\s*-\s*\d{4}\s*remaster/gi, "")
      .replace(/\s*-\s*remaster(?:ed)?/gi, "")
      .replace(/\s*\[remaster(?:ed)?\]/gi, "")
      .replace(/\s*\(remaster(?:ed)?\)/gi, "")
      .replace(/\s*\(feat\..*?\)/gi, "")
      .replace(/\s*\[feat\..*?\]/gi, "")
      .replace(/\s*\(with.*?\)/gi, "")
      .replace(/\s*\(official (?:audio|video|visualizer)\)/gi, "")
      .replace(/\s*\[official (?:audio|video|visualizer)\]/gi, "")
      .trim();

    const artistStr = Array.isArray(artists) && artists.length ? artists[0] : "";
    if (artistStr && !cleanTitle.toLowerCase().includes(artistStr.toLowerCase())) {
      return `${artistStr} ${cleanTitle}`;
    }
    return cleanTitle;
  }

  function parseSearchItem(renderer) {
    if (!renderer) return null;

    let videoId =
      renderer.playlistItemData?.videoId ||
      renderer.navigationEndpoint?.watchEndpoint?.videoId ||
      renderer.doubleTapEndpoint?.watchEndpoint?.videoId ||
      renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;

    const flexCols = renderer.flexColumns || [];
    if (!flexCols.length) return null;

    // extract title
    const titleCol = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const title = titleCol.map((r) => r.text).join("").trim();
    if (!title) return null;

    if (!videoId && titleCol[0]?.navigationEndpoint?.watchEndpoint?.videoId) {
      videoId = titleCol[0].navigationEndpoint.watchEndpoint.videoId;
    }

    if (!videoId) return null;

    // extract subtitle runs
    const subCol = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const artists = [];
    let album = null;
    let durationSeconds = 0;

    for (const run of subCol) {
      const pageType = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      const text = run.text ? run.text.trim() : "";
      if (!text || text === "•" || text === "," || text === " • ") continue;

      if (pageType === "MUSIC_PAGE_TYPE_ARTIST" || pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL") {
        artists.push(text);
      } else if (pageType === "MUSIC_PAGE_TYPE_ALBUM") {
        album = text;
      } else if (text.includes(":") && /\d+:\d+/.test(text)) {
        durationSeconds = parseDurationText(text);
      } else if (!artists.length && !album && isNaN(parseInt(text, 10))) {
        artists.push(text);
      }
    }

    // check badges
    let isExplicit = false;
    if (renderer.badges) {
      for (const badge of renderer.badges) {
        const iconType = badge.musicInlineBadgeRenderer?.icon?.iconType;
        if (iconType === "MUSIC_EXPLICIT_BADGE") {
          isExplicit = true;
          break;
        }
      }
    }

    return {
      video_id: videoId,
      title,
      artists: artists.length ? artists : ["Unknown Artist"],
      album,
      duration_seconds: durationSeconds,
      is_explicit: isExplicit,
      is_official: true,
      score: 0.0,
      confidence: "none",
    };
  }

  function getCookie(name) {
    if (typeof document !== "object" || !document.cookie) return null;
    const match = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function getSapisidHash(sapisid, origin = "https://music.youtube.com") {
    if (!sapisid) return null;
    const time = Math.floor(Date.now() / 1000);
    const msg = `${time} ${sapisid} ${origin}`;
    if (typeof crypto === "object" && crypto.subtle) {
      const buffer = new TextEncoder().encode(msg);
      const hashBuffer = await crypto.subtle.digest("SHA-1", buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      return `${time}_${hashHex}`;
    }
    return null;
  }

  async function callInnertube(endpoint, body) {
    const config = getInnertubeConfig();
    if (!config) {
      throw new Error("missing ytcfg session");
    }

    const headers = {
      "Content-Type": "application/json",
      "X-Origin": "https://music.youtube.com",
    };

    const sapisid =
      getCookie("SAPISID") ||
      getCookie("__Secure-3PAPISID") ||
      getCookie("__Secure-1PAPISID") ||
      getCookie("APISID");

    if (sapisid) {
      try {
        const hash = await getSapisidHash(sapisid, "https://music.youtube.com");
        if (hash) {
          headers["Authorization"] = `SAPISIDHASH ${hash}`;
          headers["X-Origin"] = "https://music.youtube.com";
        }
      } catch (e) {}
    }

    if (window.ytcfg && typeof window.ytcfg.get === "function") {
      const clientName = window.ytcfg.get("INNERTUBE_CLIENT_NAME") || 67;
      const clientVersion = window.ytcfg.get("INNERTUBE_CLIENT_VERSION");
      const authUser = window.ytcfg.get("SESSION_INDEX") ?? window.ytcfg.get("AUTH_USER") ?? "0";
      const visitorData = window.ytcfg.get("VISITOR_DATA");
      const idToken = window.ytcfg.get("ID_TOKEN");

      if (clientName) headers["X-YouTube-Client-Name"] = String(clientName);
      if (clientVersion) headers["X-YouTube-Client-Version"] = String(clientVersion);
      if (authUser !== undefined) headers["X-Goog-AuthUser"] = String(authUser);
      if (visitorData) headers["X-Goog-Visitor-Id"] = String(visitorData);
      if (idToken) headers["X-YouTube-Identity-Token"] = String(idToken);
    }

    const url = `/youtubei/v1/${endpoint}?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`;
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        context: config.context,
        ...body,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("HTTP 401: Please make sure you are signed in to YouTube Music in the app");
      }
      throw new Error(`http ${response.status}`);
    }

    return response.json();
  }

  const adapter = {
    cleanQuery: cleanSearchQuery,

    async searchSongs(queryOrTitle, artists = null) {
      try {
        const query = artists ? cleanSearchQuery(queryOrTitle, artists) : queryOrTitle;
        const data = await callInnertube("search", {
          query,
          params: SONGS_SEARCH_PARAMS,
        });

        const candidates = [];
        const sectionList =
          data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

        for (const section of sectionList) {
          const shelf = section.musicShelfRenderer || section.musicCardShelfRenderer;
          if (shelf && shelf.contents) {
            for (const item of shelf.contents) {
              const cand = parseSearchItem(item.musicResponsiveListItemRenderer);
              if (cand && !candidates.some((c) => c.video_id === cand.video_id)) {
                candidates.push(cand);
                if (candidates.length >= 8) break;
              }
            }
          }
          if (candidates.length >= 8) break;
        }

        return candidates;
      } catch (err) {
        return [];
      }
    },

    async createPlaylist(title, description, privacy = "PRIVATE", videoIds = []) {
      const payload = {
        title,
        description: description || "Imported via YouTube Music Desktop",
        privacyStatus: privacy,
      };
      if (Array.isArray(videoIds) && videoIds.length) {
        payload.videoIds = videoIds.slice(0, 50);
      }
      const data = await callInnertube("playlist/create", payload);

      const playlistId = data.playlistId;
      if (!playlistId) {
        throw new Error("no playlist id");
      }
      return playlistId;
    },

    async addPlaylistItems(playlistId, videoIds, onProgress) {
      let added = 0;
      let failed = 0;

      for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
        const chunk = videoIds.slice(i, i + BATCH_SIZE);
        const actions = chunk.map((id) => ({
          action: "ACTION_ADD_VIDEO",
          addedVideoId: id,
        }));

        try {
          await callInnertube("browse/edit_playlist", {
            playlistId,
            actions,
          });
          added += chunk.length;
        } catch (batchErr) {
          // fallback single additions
          for (const singleId of chunk) {
            try {
              await callInnertube("browse/edit_playlist", {
                playlistId,
                actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId: singleId }],
              });
              added += 1;
            } catch (singleErr) {
              failed += 1;
            }
          }
        }

        if (typeof onProgress === "function") {
          onProgress(added + failed, videoIds.length);
        }
      }

      return { added, failed };
    },
  };

  window.__ytmTransferAdapter = adapter;
})();
