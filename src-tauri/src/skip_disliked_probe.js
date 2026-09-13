(() => {
  const runtime = window.__ytmFeatures;
  if (!runtime) return;

  let observer = null;
  let boundButton = null;
  let buttonPollTimer = 0;

  function skipIfDisliked(button) {
    if (button?.getAttribute("like-status") !== "DISLIKE") return;
    document.querySelector("yt-icon-button.next-button, ytmusic-player-bar #next-button")?.click();
  }

  function attach() {
    const button = document.querySelector("#like-button-renderer");
    if (button === boundButton) return;
    observer?.disconnect();
    observer = null;
    boundButton = button || null;
    if (button) {
      const mutationObserver = new MutationObserver(() => skipIfDisliked(button));
      mutationObserver.observe(button, { attributes: true, attributeFilter: ["like-status"] });
      observer = mutationObserver;
      skipIfDisliked(button);
    }
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    boundButton = null;
    window.clearInterval(buttonPollTimer);
    buttonPollTimer = 0;
  }

  function start() {
    attach();
    window.clearInterval(buttonPollTimer);
    buttonPollTimer = window.setInterval(attach, 1000);
  }

  runtime.register("skip_disliked", { start, stop });
})();
