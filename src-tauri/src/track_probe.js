(() => {
  if (typeof location === "object" && location.hostname && location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytMusicTauriProbeInstalled) {
    return;
  }

  window.__ytMusicTauriProbeInstalled = true;

  const PREFIX = "YTMRPC:";
  const CLEAR_PAYLOAD = PREFIX + JSON.stringify({ type: "clear" });
  // Progress changes every second; Discord only needs occasional timestamp refreshes.
  // Keep play/pause and track changes out of this throttle by excluding elapsed time from presenceKey().
  const PROGRESS_REFRESH_MS = 30000;
  let lastPayload = "";
  let lastPresenceKey = "";
  let lastProgressPublish = 0;
  let publishTimer = 0;

  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();

  const absoluteUrl = (value) => {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, location.href).toString();
    } catch {
      return "";
    }
  };

  const numeric = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  };

  const isMetricLabel = (value) =>
    /(^|\s)(views?|plays?|subscribers?|likes?|songs?|tracks?)($|\s)/i.test(clean(value));

  const isGenericSourceLabel = (value) => {
    const label = clean(value).toLowerCase();
    return label === "youtube music" || label === "music.youtube.com" || label === "youtube";
  };

  const cleanArtist = (value) => {
    const artist = clean(value);
    return artist && !isMetricLabel(artist) && !isGenericSourceLabel(artist) ? artist : "";
  };

  const text = (selectors) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = clean(node && node.textContent);
      if (value) {
        return value;
      }
    }
    return "";
  };

  const attr = (selectors, name) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = clean(node && node.getAttribute(name));
      if (value) {
        return value;
      }
    }
    return "";
  };

  const isMusicHost = () => location.hostname === "music.youtube.com";

  const readMediaSession = () => {
    // Prefer Media Session because YouTube Music keeps it closer to the active track
    // than some player-bar DOM labels during queue transitions.
    const metadata = navigator.mediaSession && navigator.mediaSession.metadata;
    if (!metadata) {
      return null;
    }

    const artwork = Array.isArray(metadata.artwork) ? metadata.artwork : [];
    const cover = artwork
      .slice()
      .sort((left, right) => {
        const leftSize = Number.parseInt(String(left.sizes || "0").split("x")[0], 10) || 0;
        const rightSize = Number.parseInt(String(right.sizes || "0").split("x")[0], 10) || 0;
        return rightSize - leftSize;
      })
      .map((item) => absoluteUrl(item && item.src))
      .find(Boolean);

    return {
      title: clean(metadata.title),
      artist: clean(metadata.artist),
      album: clean(metadata.album),
      cover_url: cover || "",
    };
  };

  const isAdShowing = () => {
    // If YouTube exposes ad state, do not publish the ad as Discord presence.
    // Add new selectors here when screenshots show an ad leaking into RPC.
    if (
      document.querySelector(
        ".ad-showing, .ytp-ad-player-overlay, .ytp-ad-preview-container, .ytp-ad-skip-button-container, .ytp-ad-text"
      )
    ) {
      return true;
    }

    const player = document.querySelector(".html5-video-player");
    return Boolean(
      player &&
        player.classList &&
        (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"))
    );
  };

  const readPlaying = () => {
    // The media element is the source of truth. Button labels can be stale or inverted
    // while YouTube Music is swapping tracks, which previously caused false "Paused" RPC.
    const media = document.querySelector("video, audio");
    if (media && typeof media.paused === "boolean") {
      return !media.paused;
    }

    const button = document.querySelector(
      "ytmusic-player-bar #play-pause-button, ytmusic-player-bar .play-pause-button"
    );
    const label = clean(
      (button && (button.getAttribute("title") || button.getAttribute("aria-label"))) || ""
    ).toLowerCase();

    if (label.includes("pause")) {
      return true;
    }

    if (label.includes("play")) {
      return false;
    }

    const playerBar = document.querySelector("ytmusic-player-bar");
    return Boolean(playerBar && playerBar.className && String(playerBar.className).includes("playing"));
  };

  const readTiming = () => {
    const media = document.querySelector("video, audio");
    const mediaElapsed = media ? numeric(media.currentTime) : null;
    const mediaDuration = media ? numeric(media.duration) : null;

    if (mediaElapsed !== null && mediaDuration !== null && mediaDuration > 0) {
      return {
        elapsed_seconds: mediaElapsed,
        duration_seconds: mediaDuration,
      };
    }

    const progress = document.querySelector(
      "ytmusic-player-bar tp-yt-paper-slider, ytmusic-player-bar #progress-bar"
    );
    const elapsed = numeric(
      progress &&
        (progress.getAttribute("value") ||
          progress.getAttribute("aria-valuenow") ||
          progress.getAttribute("aria-valuetext"))
    );
    const duration = numeric(
      progress &&
        (progress.getAttribute("max") ||
          progress.getAttribute("aria-valuemax"))
    );

    return {
      elapsed_seconds: elapsed,
      duration_seconds: duration,
    };
  };

  const splitByline = (value) => {
    const parts = clean(value)
      .split(/\s+[•·-]\s+/)
      .map(clean)
      .filter((part) => part && !isMetricLabel(part));

    return {
      artist: cleanArtist(parts[0]) || "",
      album: parts[1] || "",
    };
  };

  const readTrackUrl = () => {
    const href = attr(
      [
        "ytmusic-player-bar .title a[href*='watch']",
        "ytmusic-player-bar yt-formatted-string.title a[href*='watch']",
        "a[href^='/watch'][href*='v=']",
      ],
      "href"
    );

    const trackUrl = absoluteUrl(href);
    if (trackUrl) {
      return trackUrl;
    }

    return location.href.startsWith("https://music.youtube.com/") ? location.href : "";
  };

  const readCoverUrl = (mediaSessionTrack) => {
    if (mediaSessionTrack && mediaSessionTrack.cover_url) {
      return mediaSessionTrack.cover_url;
    }

    return absoluteUrl(
      attr(
        [
          "ytmusic-player-bar img.image",
          "ytmusic-player-bar img.thumbnail",
          "ytmusic-player-bar img[src]",
        ],
        "src"
      )
    );
  };

  const readTrack = () => {
    if (isAdShowing()) {
      return null;
    }

    const mediaSessionTrack = readMediaSession();
    const title =
      (mediaSessionTrack && mediaSessionTrack.title) ||
      text([
        "ytmusic-player-bar .title",
        "ytmusic-player-bar yt-formatted-string.title",
        ".ytmusic-player-bar .title",
      ]);

    if (!title || title === "YouTube Music") {
      return null;
    }

    const byline = text([
      "ytmusic-player-bar .byline",
      "ytmusic-player-bar yt-formatted-string.byline",
      ".ytmusic-player-bar .byline",
    ]);
    const bylineParts = splitByline(byline);
    const timing = readTiming();
    const mediaSessionArtist = cleanArtist(mediaSessionTrack && mediaSessionTrack.artist);

    return {
      title,
      artist: mediaSessionArtist || bylineParts.artist || null,
      album: (mediaSessionTrack && mediaSessionTrack.album) || bylineParts.album || null,
      playing: readPlaying(),
      url: readTrackUrl() || null,
      cover_url: readCoverUrl(mediaSessionTrack) || null,
      elapsed_seconds: timing.elapsed_seconds,
      duration_seconds: timing.duration_seconds,
    };
  };

  const presenceKey = (track) =>
    // elapsed_seconds is intentionally omitted so normal playback progress does not
    // spam document-title updates; actual play/pause changes still publish immediately.
    JSON.stringify({
      title: track.title,
      artist: track.artist,
      album: track.album,
      playing: track.playing,
      url: track.url,
      cover_url: track.cover_url,
      duration_seconds: track.duration_seconds,
    });

  const publishClear = () => {
    if (document.title.startsWith("YTMFEATURE:")) {
      window.setTimeout(publishClear, 80);
      return;
    }
    if (lastPayload === CLEAR_PAYLOAD) {
      return;
    }

    lastPayload = CLEAR_PAYLOAD;
    if (lastPresenceKey !== "") {
      lastPresenceKey = "";
      window.dispatchEvent(new CustomEvent("ytm-track-change", { detail: null }));
    }
    lastProgressPublish = 0;
    document.title = CLEAR_PAYLOAD;
  };

  const publish = () => {
    if (document.title.startsWith("YTMFEATURE:")) {
      window.setTimeout(publish, 80);
      return;
    }
    if (!isMusicHost() || !document.body) {
      publishClear();
      return;
    }

    const track = readTrack();
    if (!track) {
      publishClear();
      return;
    }

    const payload = PREFIX + JSON.stringify({ type: "track", track });
    const key = presenceKey(track);
    const now = Date.now();

    if (
      key === lastPresenceKey &&
      payload !== lastPayload &&
      now - lastProgressPublish < PROGRESS_REFRESH_MS
    ) {
      return;
    }

    const isNewTrack = key !== lastPresenceKey;
    if (isNewTrack) {
      window.dispatchEvent(new CustomEvent("ytm-track-change", { detail: track }));
    }

    if (payload !== lastPayload) {
      lastPayload = payload;
      lastPresenceKey = key;
      lastProgressPublish = now;
      document.title = payload;
    }
  };

  const schedulePublish = () => {
    window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(publish, 180);
  };

  const installObserver = () => {
    if (!document.documentElement) {
      window.setTimeout(installObserver, 100);
      return;
    }

    const observer = new MutationObserver(schedulePublish);
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });

    document.addEventListener("yt-navigate-finish", schedulePublish, true);
    document.addEventListener("play", schedulePublish, true);
    document.addEventListener("pause", schedulePublish, true);

    window.setInterval(publish, 2500);
    schedulePublish();
  };

  installObserver();
})();
