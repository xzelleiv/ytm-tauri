(function () {
  const host = location.hostname || "";
  const path = location.pathname || "";
  const search = location.search || "";
  const TARGET_URL = "https://music.youtube.com/";

  if (host !== "music.youtube.com") return;

  function scheduleRecoveryRedirect(delayMs) {
    const expectedPath = location.pathname;
    setTimeout(() => {
      if (location.hostname === "music.youtube.com" && location.pathname === expectedPath) {
        window.location.replace(TARGET_URL);
      }
    }, delayMs);
  }

  if (path.includes("/oops") || path.includes("/error")) {
    scheduleRecoveryRedirect(1500);
    return;
  }

  if (search.includes("action_handle_signin")) {
    try {
      const params = new URLSearchParams(search);
      params.delete("action_handle_signin");
      const nextSearch = params.toString();
      const clean = `${path}${nextSearch ? `?${nextSearch}` : ""}${location.hash || ""}`;
      window.history.replaceState(null, "", clean);
    } catch {}
  }
})();
