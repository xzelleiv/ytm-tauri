import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../src-tauri/src/playlist_manager_probe.js", import.meta.url),
  "utf8"
);
const dataSource = await readFile(
  new URL("../src-tauri/src/playlist_manager_data.js", import.meta.url),
  "utf8"
);

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.className = "";
    this.classList = { add() {}, remove() {} };
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.id = "";
    this.attributes = {};
    this._html = "";
  }

  set innerHTML(value) {
    this._html = String(value);
    this.children = [];
    if (this._html.includes("ytm-pm-card")) {
      const controls = [
        ["strong", "ytm-pm-heading", ""],
        ["button", "", "ytm-pm-close"],
        ["input", "", ""],
        ["select", "", ""],
        ["select", "", ""],
        ["select", "", ""],
        ["div", "", ""],
        ["div", "", ""],
        ["span", "", ""],
        ["button", "", ""],
        ["button", "", ""],
        ["button", "", ""],
        ["input", "", ""],
        ["input", "", ""],
        ["button", "", ""],
        ["button", "", ""],
        ["div", "", ""],
        ["button", "", ""],
        ["button", "", ""],
      ];
      controls.forEach(([tag, id, className]) => {
        const child = new FakeElement(tag);
        child.id = id;
        child.className = className;
        this.appendChild(child);
      });
      const byRole = {
        search: this.children[2], sort: this.children[3], operation: this.children[4],
        destination: this.children[5], status: this.children[6], list: this.children[7],
        "page-label": this.children[8], duplicates: this.children[12], unavailable: this.children[13], preview: this.children[16],
      };
      Object.entries(byRole).forEach(([role, child]) => { child.dataset.role = role; });
      const byAction = { previous: this.children[9], next: this.children[10], "select-all": this.children[11], clear: this.children[14], cancel: this.children[17], apply: this.children[18] };
      Object.entries(byAction).forEach(([action, child]) => { child.dataset.action = action; });
      return;
    }
    const indexes = [...this._html.matchAll(/data-index="(\d+)"/g)];
    indexes.forEach((match) => {
      const child = new FakeElement("input");
      child.dataset.index = match[1];
      child.checked = new RegExp(`data-index="${match[1]}"[^>]*\\bchecked\\b`).test(this._html);
      this.appendChild(child);
    });
  }

  get innerHTML() { return this._html; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type, event = {}) { this.listeners.get(type)?.({ target: this, ...event }); }
  focus() { this.ownerDocument && (this.ownerDocument.activeElement = this); }

  querySelector(selector) {
    if (selector === "option:checked") return this.children.find((child) => child.tagName === "OPTION") || null;
    if (selector.startsWith("#")) return this.find((child) => child.id === selector.slice(1));
    const role = selector.match(/data-role=['"]([^'"]+)/)?.[1];
    if (role) return this.find((child) => child.dataset.role === role);
    const action = selector.match(/data-action=['"]([^'"]+)/)?.[1];
    if (action) return this.find((child) => child.dataset.action === action);
    if (selector === ".ytm-pm-close") return this.find((child) => child.className === "ytm-pm-close");
    return null;
  }

  querySelectorAll(selector) {
    if (selector === "input[data-index]") return this.children.filter((child) => child.dataset.index !== undefined);
    return [];
  }

  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.find?.(predicate);
      if (found) return found;
    }
    return null;
  }
}

function runtime(adapter, { nativeFetch, modernHeader = false, cachedBrowse = false } = {}) {
  const body = new FakeElement("body");
  const head = new FakeElement("head");
  const host = new FakeElement("div");
  const cachedHost = new FakeElement("div");
  cachedHost.style.display = cachedBrowse ? "none" : "";
  if (cachedBrowse) {
    const staleButton = new FakeElement("button");
    staleButton.id = "ytm-playlist-manager-button";
    cachedHost.appendChild(staleButton);
    body.appendChild(cachedHost);
  }
  const document = {
    body, head, activeElement: host, readyState: "complete",
    createElement: (tag) => { const element = new FakeElement(tag); element.ownerDocument = document; return element; },
    getElementById: (id) => body.find((child) => child.id === id) || head.find((child) => child.id === id),
    querySelector: (selector) => (cachedBrowse && selector.includes("ytmusic-browse-response")) ? cachedHost : (modernHeader && selector.includes("ytmusic-responsive-header-renderer")) ? host : (!cachedBrowse && selector.includes("ytmusic-detail-header-renderer") ? host : null),
    querySelectorAll: (selector) => selector === "ytmusic-sort-filter-button-renderer" ? [{ parentNode: host, closest: () => host }] : [],
    addEventListener() {},
  };
  const context = {
    console,
    Date,
    JSON,
    URL,
    URLSearchParams,
    AbortController,
    document,
    location: { href: "https://music.youtube.com/playlist?list=PL1", hostname: "music.youtube.com", pathname: "/playlist" },
    setInterval() { return 1; },
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    ...(nativeFetch ? {
      fetch: nativeFetch,
      ytcfg: { get(key) { return { INNERTUBE_API_KEY: "test-key", INNERTUBE_CONTEXT: {}, INNERTUBE_CLIENT_NAME: 67 }[key]; } },
    } : {}),
    MutationObserver: class { observe() {} },
    confirm() { return true; },
    window: null,
  };
  context.window = context;
  if (nativeFetch) vm.runInNewContext(dataSource, context);
  if (adapter) context.window.__ytmPlaylistManagerData = adapter;
  vm.runInNewContext(source, context);
  return { context, document, host };
}

test("playlist manager exposes URL-safe availability, sorting, and duplicate rules", () => {
  const { context } = runtime({});
  const manager = context.window.__ytmPlaylistManager;
  assert.equal(manager.isPlaylistPage(new URL("https://music.youtube.com/playlist?list=PL1")), true);
  assert.equal(manager.isPlaylistPage(new URL("https://music.youtube.com/watch?v=x")), false);
  assert.equal(manager.playlistIdFromInput("https://music.youtube.com/playlist?list=PL%2Ddestination"), "PL-destination");
  assert.equal(manager.playlistIdFromInput("VLPL-destination"), "PL-destination");
  assert.equal(manager.isExplicitlyUnavailable({ isAvailable: false }), true);
  assert.equal(manager.isExplicitlyUnavailable({ title: "Missing metadata" }), false);
  const tracks = [
    manager.normalizeTrack({ videoId: "b", setVideoId: "entry-b", title: "Beta", durationSeconds: 120 }, 0),
    manager.normalizeTrack({ videoId: "a", setVideoId: "entry-a", title: "Alpha", durationSeconds: 60 }, 1),
    manager.normalizeTrack({ videoId: "a", setVideoId: "entry-a-2", title: "Alpha", durationSeconds: 60 }, 2),
  ];
  assert.deepEqual(manager.sortTracks(tracks, "title-desc").map((track) => track.originalIndex), [0, 1, 2]);
  assert.deepEqual([...manager.duplicateOccurrences(tracks)], [2]);
});

test("playlist manager UI integrates with the native data adapter and rechecks the source snapshot", async () => {
  const calls = [];
  const page = {
    responseContext: {},
    header: { musicEditablePlaylistDetailHeaderRenderer: { title: { simpleText: "Road Mix" } } },
    contents: { musicPlaylistShelfRenderer: { contents: [{ musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: "v1", setVideoId: "entry-1" },
      flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "One" }] } } }],
    } }] } },
  };
  const { context, document } = runtime(null, { nativeFetch: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.includes("browse/edit_playlist")) return { ok: true, json: async () => ({ responseContext: {}, status: "STATUS_SUCCEEDED" }) };
    return { ok: true, json: async () => page };
  } });
  context.window.confirm = () => true;
  context.window.__ytmPlaylistManager.openDialog();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dialog = document.body.find((child) => child.id === "ytm-playlist-manager-dialog");
  dialog.querySelector("[data-role='operation']").value = "remove";
  dialog.querySelector("[data-role='operation']").dispatch("change");
  const row = dialog.querySelector("[data-role='list']").querySelectorAll("input[data-index]")[0];
  row.checked = true;
  row.dispatch("change");
  await new Promise((resolve) => setTimeout(resolve, 0));
  dialog.querySelector("[data-action='apply']").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.some((call) => call.type === "execute" || call.body?.actions), false);
  dialog.querySelector("[data-action='apply']").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(({ body }) => body.actions?.[0]?.action).filter(Boolean), ["ACTION_REMOVE_VIDEO"]);
  assert.equal(calls.filter(({ url }) => url.includes("/browse?")).length, 3);
});

test("playlist manager discovers the song toolbar and selects the full loaded playlist", async () => {
  const items = Array.from({ length: 165 }, (_, index) => ({
    videoId: `video-${index}`, setVideoId: `entry-${index}`, title: `Song ${index}`, isAvailable: true,
  }));
  const adapter = {
    async readPlaylist(id, options = {}) {
      options.onProgress?.({ loaded: items.length, total: items.length });
      return { id, title: "Modern playlist", editable: true, items };
    },
    snapshotFingerprint(sourceItems) { return JSON.stringify(sourceItems.map((item) => item.setVideoId)); },
    planRemove(sourceItems, options) { return { kind: "remove", editable: true, actions: sourceItems.map((item) => ({ occurrenceId: item.occurrenceId, setVideoId: item.setVideoId })), blocked: [], snapshotFingerprint: options.snapshotFingerprint }; },
  };
  const { context, document, host } = runtime(adapter, { modernHeader: true });
  assert.equal(host.children.some((child) => child.id === "ytm-playlist-manager-button"), true);
  context.window.__ytmPlaylistManager.openDialog();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dialog = document.body.find((child) => child.id === "ytm-playlist-manager-dialog");
  const selectAll = dialog.querySelector("[data-action='select-all']");
  selectAll.dispatch("click");
  assert.match(dialog.querySelector("[data-role='preview']").innerHTML, /165/);
  assert.equal(selectAll.disabled, true);
  const firstPageRows = dialog.querySelector("[data-role='list']").querySelectorAll("input[data-index]");
  assert.equal(firstPageRows.length, 80);
  assert.equal(firstPageRows.every((row) => row.checked), true);
});

test("playlist manager relocates a stale cached button to the visible song toolbar", () => {
  const { context, host } = runtime({}, { modernHeader: true, cachedBrowse: true });
  assert.equal(host.children.some((child) => child.id === "ytm-playlist-manager-button"), true);
});

test("playlist manager opens, loads paged rows, plans occurrence-safe changes, and executes after a fresh snapshot", async () => {
  const calls = [];
  let reads = 0;
  const adapter = {
    async readPlaylist(id, onProgress) {
      reads += 1;
      onProgress?.onProgress?.({ loaded: 2, total: 2 });
      return { id, title: "Road Mix", editable: true, items: [
        { videoId: "v1", setVideoId: "entry-1", title: "One", isAvailable: true },
        { videoId: "v1", setVideoId: "entry-2", title: "One copy", isAvailable: true },
      ] };
    },
    snapshotFingerprint(items) { return JSON.stringify(items.map((item) => item.occurrenceId || item.setVideoId)); },
    async planRemove(items, options) { calls.push({ type: "plan", payload: { items, options } }); return { kind: "remove", editable: true, actions: [{ occurrenceId: items[0].occurrenceId, setVideoId: items[0].setVideoId }], blocked: [], snapshotFingerprint: options.snapshotFingerprint }; },
    async executePlan(plan, options) { calls.push({ type: "execute", plan, options }); return { succeeded: 1, failed: 0 }; },
  };
  const { context, document } = runtime(adapter);
  const manager = context.window.__ytmPlaylistManager;
  manager.openDialog();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dialog = document.body.find((child) => child.id === "ytm-playlist-manager-dialog");
  assert.ok(dialog);
  dialog.querySelector("[data-role='operation']").value = "remove";
  dialog.querySelector("[data-role='operation']").dispatch("change");
  const rows = dialog.querySelector("[data-role='list']").querySelectorAll("input[data-index]");
  rows[1].checked = true;
  rows[1].dispatch("change");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0].payload.items[0].setVideoId, "entry-2");
  assert.equal(dialog.querySelector("[data-action='apply']").disabled, false);
  dialog.querySelector("[data-action='apply']").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.some((call) => call.type === "execute" || call.body?.actions), false);
  dialog.querySelector("[data-action='apply']").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.at(-1).type, "execute");
  assert.equal(calls.at(-1).options.snapshotFingerprint, calls[0].payload.options.snapshotFingerprint);
  assert.equal(reads >= 2, true);
});

test("clearing selection during destination loading invalidates the old plan", async () => {
  let finishDestination;
  const destination = new Promise((resolve) => { finishDestination = resolve; });
  const items = [{ occurrenceId: "entry-1", videoId: "v1", setVideoId: "entry-1", title: "One", isAvailable: true }];
  const adapter = {
    readPlaylist(id) { return id === "PL1" ? Promise.resolve({ id, title: "Source", editable: true, items }) : destination; },
    snapshotFingerprint() { return "snapshot"; },
    listDestinations() { return Promise.resolve([{ id: "PLprivate", title: "Private playlist", privacy: "private" }]); },
    planTransfer() { return { kind: "transfer", editable: true, entries: [{}], blocked: [] }; },
  };
  const { context, document } = runtime(adapter);
  context.__ytmPlaylistManager.openDialog();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dialog = document.body.find((child) => child.id === "ytm-playlist-manager-dialog");
  const select = dialog.querySelector("[data-role='destination']");
  select.value = "PLprivate";
  select.dispatch("change");
  dialog.querySelector("[data-action='select-all']").dispatch("click");
  const apply = dialog.querySelector("[data-action='apply']");
  assert.equal(apply.disabled, true);
  dialog.querySelector("[data-action='clear']").dispatch("click");
  finishDestination({ id: "PLprivate", title: "Private playlist", editable: true, items: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(apply.disabled, true);
  dialog.querySelector("[data-action='select-all']").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(apply.disabled, false);
  assert.equal(apply.textContent, "Review changes");
});


test("closing a loading manager aborts work and cannot overwrite its reopened dialog", async () => {
  const reads = [];
  const adapter = {
    readPlaylist(id, options) { return new Promise(resolve => reads.push({ id, options, resolve })); },
    snapshotFingerprint(items) { return JSON.stringify(items); },
  };
  const { context, document } = runtime(adapter);
  const manager = context.__ytmPlaylistManager;
  manager.openDialog();
  manager.closeDialog();
  assert.equal(reads[0].options.signal.aborted, true);
  manager.openDialog();
  reads[0].resolve({ title: "Stale playlist", editable: true, items: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const dialog = document.getElementById("ytm-playlist-manager-dialog");
  assert.notEqual(dialog.querySelector("#ytm-pm-heading").textContent, "Stale playlist");
  assert.equal(dialog.querySelector("[data-action='select-all']").disabled, true);
  reads[1].resolve({ title: "Fresh playlist", editable: true, items: [{ occurrenceId: "fresh", videoId: "fresh", setVideoId: "fresh" }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dialog.querySelector("#ytm-pm-heading").textContent, "Fresh playlist");
  assert.equal(dialog.querySelector("[data-action='select-all']").disabled, false);
  manager.closeDialog();
  assert.equal(document.getElementById("ytm-playlist-manager-dialog"), null);
});
