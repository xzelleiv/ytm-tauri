(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  const API_URL = "https://sponsor.ajay.app";
  const DEFAULT_CATEGORIES = ["sponsor", "intro", "outro", "interaction", "selfpromo", "music_offtopic"];

  let currentVideoId = null;
  let currentSegments = [];
  let boundMedia = null;
  let toastTimer = 0;

  async function fetchSegments(videoId) {
    if (!videoId) return [];
    const url = `${API_URL}/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${encodeURIComponent(JSON.stringify(DEFAULT_CATEGORIES))}`;
    try {
      const res = await window.fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data
        .map((item) => item.segment)
        .filter((seg) => Array.isArray(seg) && seg.length === 2 && Number.isFinite(seg[0]) && Number.isFinite(seg[1]))
        .sort((a, b) => a[0] - b[0]);
    } catch {
      return [];
    }
  }

  function showSkipToast(category) {
    let toast = document.getElementById("ytm-tauri-sponsorblock-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ytm-tauri-sponsorblock-toast";
      toast.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483646;padding:8px 16px;border-radius:18px;background:rgba(20,20,20,0.88);color:#81c784;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;pointer-events:none;transition:opacity 0.2s;box-shadow:0 4px 12px rgba(0,0,0,0.4)";
      const target = document.body || document.documentElement;
      if (target) target.appendChild(toast);
    }
    toast.textContent = "Skipped non-music segment";
    toast.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast) toast.style.opacity = "0";
    }, 1200);
  }

  function onTimeUpdate() {
    if (!boundMedia || !currentSegments.length) return;
    const time = boundMedia.currentTime;
    for (const segment of currentSegments) {
      if (time >= segment[0] && time < segment[1] - 0.2) {
        boundMedia.currentTime = segment[1];
        showSkipToast();
        break;
      }
    }
  }

  async function onTrackChange() {
    const player = document.querySelector("#movie_player, .html5-video-player, ytmusic-player");
    const videoData = player?.getVideoData?.();
    const videoId = videoData?.video_id || new URL(location.href).searchParams.get("v");
    if (videoId === currentVideoId) return;
    currentVideoId = videoId;
    currentSegments = [];
    if (videoId) {
      currentSegments = await fetchSegments(videoId);
    }
  }

  function attachMedia() {
    const media = runtime.media();
    if (media && media !== boundMedia) {
      if (boundMedia) {
        boundMedia.removeEventListener("timeupdate", onTimeUpdate);
        boundMedia.removeEventListener("emptied", onTrackChange);
      }
      boundMedia = media;
      boundMedia.addEventListener("timeupdate", onTimeUpdate);
      boundMedia.addEventListener("emptied", onTrackChange);
    }
  }

  function start() {
    attachMedia();
    onTrackChange();

    const player = document.querySelector("#movie_player, .html5-video-player, ytmusic-player");
    if (player && !player.__ytmSponsorBlockBound) {
      player.__ytmSponsorBlockBound = true;
      player.addEventListener("videodatachange", () => {
        attachMedia();
        onTrackChange();
      });
    }

    window.setInterval(() => {
      attachMedia();
      onTrackChange();
    }, 2000);
  }

  function stop() {
    if (boundMedia) {
      boundMedia.removeEventListener("timeupdate", onTimeUpdate);
      boundMedia.removeEventListener("emptied", onTrackChange);
      boundMedia = null;
    }
    currentSegments = [];
    currentVideoId = null;
    document.getElementById("ytm-tauri-sponsorblock-toast")?.remove();
  }

  runtime.register("sponsorblock", { start, stop });
})();
