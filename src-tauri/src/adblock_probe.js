(() => {
  if (location.hostname !== "music.youtube.com") {
    return;
  }
  if (window.__ytMusicTauriAdBlockInstalled) {
    return;
  }
  window.__ytMusicTauriAdBlockInstalled = true;

  const savedMediaState = new WeakMap();
  const style = document.createElement("style");
  style.textContent = `
    ytd-ad-slot-renderer,
    ytd-display-ad-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytmusic-mealbar-promo-renderer,
    ytmusic-guide-section-renderer:first-of-type ytmusic-guide-entry-renderer:nth-child(n+4),
    ytmusic-guide-entry-renderer:has(a[href*="/upgrade"]),
    ytmusic-guide-entry-renderer:has(a[href*="music_premium"]),
    ytmusic-guide-entry-renderer:has(tp-yt-paper-item[aria-label*="Upgrade"]),
    ytmusic-guide-entry-renderer:has([aria-label*="Upgrade"]),
    ytmusic-guide-entry-renderer[tab-identifier="FEmusic_premium"],
    ytmusic-mini-guide-entry-renderer:has(a[href*="/upgrade"]),
    ytmusic-mini-guide-entry-renderer:has(a[href*="music_premium"]),
    ytmusic-mini-guide-entry-renderer:has([aria-label*="Upgrade"]),
    ytmusic-mini-guide-entry-renderer[tab-identifier="FEmusic_premium"],
    ytmusic-mini-guide-renderer ytmusic-mini-guide-entry-renderer:nth-child(n+4),
    #mini-guide #items > *:nth-child(n+4),
    ytmusic-pivot-bar-item-renderer:has(a[href*="/upgrade"]),
    ytmusic-pivot-bar-item-renderer:has(a[href*="music_premium"]),
    ytmusic-compact-link-renderer:has(a[href*="/upgrade"]),
    ytmusic-compact-link-renderer:has(a[href*="music_premium"]),
    #guide ytmusic-guide-entry-renderer:has(a[href*="upgrade"]),
    #mini-guide ytmusic-mini-guide-entry-renderer:has(a[href*="upgrade"]),
    #mini-guide ytmusic-guide-entry-renderer:has(a[href*="upgrade"]),
    .html5-video-player.ad-showing .ytp-ad-module,
    .html5-video-player.ad-interrupting .ytp-ad-module {
      display: none !important;
    }
  `;

  const injectStyle = () => {
    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    } else {
      window.setTimeout(injectStyle, 50);
    }
  };
  injectStyle();

  const isMusicHost = () => location.hostname === "music.youtube.com";

  const isAdShowing = () => {
    const player = document.querySelector(".html5-video-player");
    return Boolean(
      player &&
        player.classList &&
        (player.classList.contains("ad-showing") ||
          player.classList.contains("ad-interrupting")),
    );
  };

  const restoreMedia = () => {
    for (const media of document.querySelectorAll("video, audio")) {
      const saved = savedMediaState.get(media);
      if (!saved) {
        continue;
      }
      media.muted = saved.muted;
      media.playbackRate = saved.playbackRate;
      savedMediaState.delete(media);
    }
  };

  const skipAd = () => {
    const skipButton = document.querySelector(
      ".ytp-ad-skip-button-modern, .ytp-ad-skip-button, .ytp-ad-skip-button-container button, .ytp-ad-skip-button-slot button",
    );
    if (skipButton && !skipButton.disabled) {
      skipButton.click();
    }

    for (const media of document.querySelectorAll("video, audio")) {
      if (!savedMediaState.has(media)) {
        savedMediaState.set(media, {
          muted: media.muted,
          playbackRate: media.playbackRate,
        });
      }

      media.muted = true;
      media.playbackRate = 16;
      if (
        Number.isFinite(media.duration) &&
        media.duration > 0 &&
        media.currentTime < media.duration - 0.25
      ) {
        try {
          media.currentTime = Math.max(media.currentTime, media.duration - 0.1);
        } catch {
          // fallback seek
        }
      }
    }
  };

  const run = () => {
    if (
      window.__ytMusicTauriAdBlockEnabled === false ||
      !isMusicHost() ||
      !isAdShowing()
    ) {
      restoreMedia();
      return;
    }

    skipAd();
  };

  const install = () => {
    if (!document.documentElement) {
      window.setTimeout(install, 50);
      return;
    }

    const observer = new MutationObserver(run);
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    document.addEventListener("yt-navigate-finish", run, true);
    window.addEventListener("pageshow", run, true);
    window.setInterval(run, 250);
    run();
  };

  install();
})();
