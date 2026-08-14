(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime || location.origin !== "https://music.youtube.com") return;

  let observer = null;
  let waitTimer = 0;

  function skipIfDisliked(button) {
    if (button?.getAttribute("like-status") !== "DISLIKE") return;
    document.querySelector("yt-icon-button.next-button, ytmusic-player-bar #next-button")?.click();
  }

  function attach() {
    const button = document.querySelector("#like-button-renderer");
    if (!button) {
      waitTimer = window.setTimeout(attach, 250);
      return;
    }
    observer?.disconnect();
    observer = new MutationObserver(() => skipIfDisliked(button));
    observer.observe(button, { attributes: true, attributeFilter: ["like-status"] });
    skipIfDisliked(button);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    window.clearTimeout(waitTimer);
    waitTimer = 0;
  }

  runtime.register("skip_disliked", { start: attach, stop });
})();
