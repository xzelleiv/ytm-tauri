import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src-tauri/src/playlist_manager_data.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("destination picker uses the authenticated playlist menu and preserves private playlists", async () => {
  const calls = [];
  const adapter = load({ fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ responseContext: {}, contents: [{ addToPlaylistRenderer: { playlists: [
      { playlistAddToOptionRenderer: { playlistId: "PLprivate", title: { simpleText: "Private collection" }, privacy: "PRIVATE" } },
      { playlistAddToOptionRenderer: { playlistId: "PLprivate", title: { simpleText: "Duplicate" } } },
      { playlistAddToOptionRenderer: { playlistId: "WL", title: { simpleText: "Watch later" } } },
    ] } }] }) };
  } });
  assert.deepEqual(plain(await adapter.listDestinations("song")), [{ id: "PLprivate", title: "Private collection", privacy: "private" }]);
  assert.match(calls[0].url, /playlist\/get_add_to_playlist/);
  assert.deepEqual(calls[0].body.videoIds, ["song"]);
  assert.equal(calls.length, 1);
});

function load({ hostname = "music.youtube.com", fetch = async () => ({ ok: true, json: async () => ({ responseContext: {} }) }) } = {}) {
  const window = {
    ytcfg: {
      get(key) {
        return { INNERTUBE_API_KEY: "test-key", INNERTUBE_CONTEXT: {}, INNERTUBE_CLIENT_NAME: 67 }[key];
      },
    },
  };
  const context = vm.createContext({
    window,
    location: { hostname },
    document: { cookie: "" },
    fetch,
    crypto: undefined,
    TextEncoder,
    DOMException,
    Promise,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Math,
    Date,
    RegExp,
    Error,
    JSON,
  });
  vm.runInContext(source, context);
  return window.__ytmPlaylistManagerData;
}

const item = (videoId, setVideoId, title, artist = "Artist") => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId, setVideoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: artist }] } } },
    ],
  },
});

test("adapter is installed only on the exact YouTube Music host", () => {
  assert.equal(load({ hostname: "www.youtube.com" }), undefined);
  assert.equal(load({ hostname: "music.youtube.com.evil.example" }), undefined);
  assert.ok(load());
});

test("pure selection helpers preserve stable occurrence identity", () => {
  const adapter = load();
  const items = [
    { occurrenceId: "set-b", setVideoId: "set-b", videoId: "b", title: "Beta", artists: ["Z"], isAvailable: true },
    { occurrenceId: "set-a", setVideoId: "set-a", videoId: "a", title: "Alpha", artists: ["A"], isAvailable: true },
    { occurrenceId: "set-a-2", setVideoId: "set-a-2", videoId: "a", title: "Alpha", artists: ["A"], isAvailable: false },
  ];
  assert.deepEqual(adapter.sortItems(items), [items[1], items[2], items[0]]);
  assert.deepEqual(adapter.filterItems(items, "alpha", { availableOnly: true }), [items[1]]);
  assert.deepEqual(plain(adapter.dedupeItems(items)), { unique: [items[0], items[1]], duplicateOccurrenceIds: ["set-a-2"] });
  const unavailable = { occurrenceId: "unavailable", videoId: null, title: "Unavailable", isAvailable: false };
  assert.deepEqual(plain(adapter.dedupeItems([unavailable])), { unique: [unavailable], duplicateOccurrenceIds: [] });
});

test("plans use setVideoId for occurrence-safe remove, move, sort, and copy", () => {
  const adapter = load();
  const items = [
    { occurrenceId: "b", setVideoId: "set-b", videoId: "video-b", title: "Beta", isAvailable: true },
    { occurrenceId: "a", setVideoId: "set-a", videoId: "video-a", title: "Alpha", isAvailable: true },
    { occurrenceId: "missing", setVideoId: null, videoId: null, title: "Unavailable", isAvailable: false },
  ];
  assert.deepEqual(plain(adapter.planRemove(items, { editable: true }).actions), [
    { action: "ACTION_REMOVE_VIDEO", setVideoId: "set-b", removedVideoId: "video-b", occurrenceId: "b" },
    { action: "ACTION_REMOVE_VIDEO", setVideoId: "set-a", removedVideoId: "video-a", occurrenceId: "a" },
  ]);
  assert.deepEqual(plain(adapter.planRemove(items, { editable: true }).blocked), [{ occurrenceId: "missing", reason: "missing setVideoId or videoId" }]);
  assert.deepEqual(plain(adapter.planMove([items[1]], items[0], { editable: true }).actions), [
    { action: "ACTION_MOVE_VIDEO_BEFORE", setVideoId: "set-a", movedSetVideoIdSuccessor: "set-b", occurrenceId: "a" },
  ]);
  assert.equal(adapter.planSort(items.slice(0, 2), "title", "asc", { editable: true }).actions[0].setVideoId, "set-a");
  assert.deepEqual(plain(adapter.planCopy(items, "PL-destination", { editable: true, dedupe: true }).actions), [
    { action: "ACTION_ADD_VIDEO", addedVideoId: "video-b", occurrenceId: "b" },
    { action: "ACTION_ADD_VIDEO", addedVideoId: "video-a", occurrenceId: "a" },
  ]);
  assert.equal(adapter.planRemove(items).actions.length, 0);
});

test("readPlaylist follows continuations and rejects a truncated known total", async () => {
  const calls = [];
  const first = {
    responseContext: {},
    header: { musicEditablePlaylistDetailHeaderRenderer: { title: { simpleText: "Owned" } } },
    metadata: { numVideosText: { simpleText: "2 songs" } },
    contents: { musicPlaylistShelfRenderer: {
      contents: [item("video-a", "set-a", "Alpha")],
      continuations: [{ nextContinuationData: { continuation: "next-page" } }],
    } },
  };
  const second = {
    responseContext: {},
    continuationContents: { musicPlaylistShelfContinuation: {
      contents: [item("video-b", "set-b", "Beta")],
    } },
  };
  const adapter = load({ fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return { ok: true, json: async () => calls.length === 1 ? first : second };
  } });
  const progress = [];
  const playlist = await adapter.readPlaylist("VLPL-source", { onProgress: (event) => progress.push(event) });
  assert.equal(playlist.id, "PL-source");
  assert.equal(playlist.owned, true);
  assert.equal(playlist.editable, true);
  assert.deepEqual(plain(playlist.items.map((entry) => entry.occurrenceId)), ["set-a", "set-b"]);
  assert.deepEqual(calls.map((body) => body.browseId || body.continuation), ["VLPL-source", "next-page"]);
  assert.equal(progress.at(-1).loaded, 2);

  const truncated = load({ fetch: async () => ({ ok: true, json: async () => ({ responseContext: {}, metadata: { numVideosText: { simpleText: "2 songs" } }, contents: { musicPlaylistShelfRenderer: { contents: [item("video-a", "set-a", "Alpha")] } } }) }) });
  await assert.rejects(() => truncated.readPlaylist("PL-source"), /pagination incomplete/);
});

test("parser keeps unavailable occurrences and menu setVideoId metadata", () => {
  const adapter = load();
  const unavailable = {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Song deleted" }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Artist", navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Album", navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } } } } }] } } },
      ],
      fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { simpleText: "3:21" } } }],
      musicItemRendererDisplayPolicy: "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT",
      menu: { menuRenderer: { items: [{ menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { actions: [{ setVideoId: "set-deleted", removedVideoId: "video-deleted" }] } } } }] } },
    },
  };
  const state = { occurrenceNumbers: new Map(), usedIds: new Set(), originalIndex: 0 };
  const parsed = adapter._test.parsePage({ secondaryContents: { musicPlaylistShelfRenderer: { contents: [unavailable] } } }, state);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].setVideoId, "set-deleted");
  assert.equal(parsed[0].isAvailable, false);
  assert.equal(parsed[0].album, "Album");
  assert.equal(parsed[0].durationSeconds, 201);
  assert.equal(parsed[0].originalIndex, 0);
});

test("modern continuation actions load every page without including suggestions", async () => {
  const continuation = (token) => ({ continuationItemRenderer: { continuationEndpoint: {
    commandExecutorCommand: { commands: [{ continuationCommand: { token, request: "CONTINUATION_REQUEST_TYPE_BROWSE" } }] },
  } } });
  const pages = [
    { responseContext: {}, contents: { musicPlaylistShelfRenderer: { contents: [item("a", "sa", "A"), continuation("p2")] } },
      unrelated: { musicShelfRenderer: { contents: [item("noise", "noise", "Suggested")] } } },
    { responseContext: {}, onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [item("b", "sb", "B"), continuation("p3")] } }] },
    { responseContext: {}, onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [item("c", "sc", "C")] } }] },
  ];
  let calls = 0;
  const adapter = load({ fetch: async () => ({ ok: true, json: async () => pages[calls++] }) });
  const playlist = await adapter.readPlaylist("PL-source");
  assert.deepEqual(plain(playlist.items.map((entry) => entry.videoId)), ["a", "b", "c"]);
  assert.equal(calls, 3);
});

test("transfer never removes a source occurrence when destination add is uncertain", async () => {
  const calls = [];
  const adapter = load({ fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1
      ? { ok: true, json: async () => ({ responseContext: {}, status: "STATUS_SUCCEEDED" }) }
      : { ok: false, status: 409, json: async () => ({}) };
  } });
  const source = [{ occurrenceId: "a", setVideoId: "set-a", videoId: "video-a", title: "A", isAvailable: true }];
  const plan = adapter.planTransfer(source, "PL-destination", { sourcePlaylistId: "PL-source", sourceEditable: true, destinationEditable: true });
  const result = await adapter.executeTransfer(plan, { snapshotFingerprint: plan.snapshotFingerprint });
  assert.equal(result.copied, 1);
  assert.equal(result.removed, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(calls.map((body) => body.playlistId), ["PL-destination", "PL-source"]);
  assert.equal(result.results[0].copied, true);
  assert.equal(result.results[0].removed, false);
});

test("mutation batches are serialized and report failed batches", async () => {
  const calls = [];
  const adapter = load({ fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 2) return { ok: false, status: 409, json: async () => ({}) };
    return { ok: true, json: async () => ({ responseContext: {}, status: "STATUS_SUCCEEDED" }) };
  } });
  const plan = { kind: "remove", editable: true, actions: [
    { action: "ACTION_REMOVE_VIDEO", setVideoId: "set-a", removedVideoId: "video-a", occurrenceId: "a" },
    { action: "ACTION_REMOVE_VIDEO", setVideoId: "set-b", removedVideoId: "video-b", occurrenceId: "b" },
  ], blocked: [], snapshotFingerprint: adapter.snapshotFingerprint([
    { occurrenceId: "a", setVideoId: "set-a", videoId: "video-a" },
    { occurrenceId: "b", setVideoId: "set-b", videoId: "video-b" },
  ]) };
  const first = adapter.executePlan(plan, { playlistId: "PL-source", snapshotFingerprint: plan.snapshotFingerprint });
  const second = adapter.executePlan({ ...plan, actions: [plan.actions[0]] }, { playlistId: "PL-source", snapshotFingerprint: plan.snapshotFingerprint });
  const [result1, result2] = await Promise.all([first, second]);
  assert.equal(result1.succeeded, 2);
  assert.equal(result1.failed, 0);
  assert.equal(result1.ok, true);
  assert.equal(result2.ok, false);
  assert.deepEqual(calls.map((body) => body.actions[0].setVideoId), ["set-a", "set-a"]);
});


test("position moves preserve occurrence identity and original relative order", () => {
  const api = load();
  const items = Array.from({ length: 8 }, (_, i) => ({ occurrenceId: `entry-${i}`, setVideoId: `set-${i}`, videoId: i % 2 ? "duplicate" : `video-${i}` }));
  for (const [selected, position, expected] of [
    [[5, 2], 1, [2, 5, 0, 1, 3, 4, 6, 7]],
    [[1, 2], 7, [0, 3, 4, 5, 6, 7, 1, 2]],
    [[0, 7], 3, [1, 2, 0, 7, 3, 4, 5, 6]],
  ]) {
    const plan = api.planPosition(items, selected.map(i => `entry-${i}`), position, { editable: true });
    assert.ok(plan.actions.length <= selected.length);
    const order = items.slice();
    for (const action of plan.actions) {
      const from = order.findIndex(item => item.setVideoId === action.setVideoId);
      const [moved] = order.splice(from, 1);
      const to = action.movedSetVideoIdSuccessor ? order.findIndex(item => item.setVideoId === action.movedSetVideoIdSuccessor) : order.length;
      assert.ok(to >= 0);
      order.splice(to, 0, moved);
    }
    assert.deepEqual(order.map(item => Number(item.occurrenceId.slice(6))), expected);
  }
  assert.throws(() => api.planPosition(items, ["entry-0"], 0, { editable: true }), /starting position/);
  assert.throws(() => api.planPosition(items, ["entry-0"], 9, { editable: true }), /starting position/);
  assert.equal(api.planPosition(items, ["entry-0"], 2, { editable: false }).editable, false);
  assert.equal(api.planPosition(items, ["entry-0"], 1, { editable: true }).actions.length, 0);
});


test("transfer skips destination songs and repeated selections with exact counts", () => {
  const api = load();
  const items = Array.from({ length: 10 }, (_, i) => ({ occurrenceId: `s${i}`, setVideoId: `s${i}`, videoId: `v${i}`, isAvailable: true }));
  const plan = api.planTransfer(items, "PLdest", { sourcePlaylistId: "PLsource", sourceEditable: true, destinationEditable: true, dedupe: true, destinationVideoIds: ["v0", "v1", "v2", "v3"] });
  assert.equal(plan.selectedCount, 10);
  assert.equal(plan.entries.length, 6);
  assert.equal(plan.blocked.filter(item => item.reason === "already in destination").length, 4);
  assert.ok(plan.entries.every(entry => !["s0", "s1", "s2", "s3"].includes(entry.occurrenceId)));
  const missing = api.planTransfer([{ ...items[5], setVideoId: null }], "PLdest", { sourcePlaylistId: "PLsource", sourceEditable: true, destinationEditable: true });
  assert.equal(missing.entries.length, 0);
});

test("move batches 60 songs in order and removes only after confirmed copies", async () => {
  const calls = [];
  const api = load({ fetch: async (_, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ status: "STATUS_SUCCEEDED" }) };
  } });
  const items = Array.from({ length: 60 }, (_, i) => ({ occurrenceId: `s${i}`, setVideoId: `s${i}`, videoId: `v${i}`, isAvailable: true }));
  const plan = api.planTransfer(items, "PLdest", { sourcePlaylistId: "PLsource", sourceEditable: true, destinationEditable: true });
  const result = await api.executeTransfer(plan, { snapshotFingerprint: plan.snapshotFingerprint });
  assert.equal(result.copied, 60);
  assert.equal(result.removed, 60);
  assert.deepEqual(calls.map(call => call.actions.length), [25, 25, 25, 25, 10, 10]);
  assert.deepEqual(calls.map(call => call.playlistId), ["PLdest", "PLsource", "PLdest", "PLsource", "PLdest", "PLsource"]);
  assert.deepEqual(calls.filter(call => call.playlistId === "PLdest").flatMap(call => call.actions.map(action => action.addedVideoId)), items.map(item => item.videoId));
});

test("ambiguous copy batch stops without source removal or replay", async () => {
  let calls = 0;
  const api = load({ fetch: async () => { calls++; throw new Error("connection lost"); } });
  const items = Array.from({ length: 40 }, (_, i) => ({ occurrenceId: `s${i}`, setVideoId: `s${i}`, videoId: `v${i}`, isAvailable: true }));
  const plan = api.planTransfer(items, "PLdest", { sourcePlaylistId: "PLsource", sourceEditable: true, destinationEditable: true });
  const result = await api.executeTransfer(plan, { snapshotFingerprint: plan.snapshotFingerprint });
  assert.equal(calls, 1);
  assert.equal(result.copied, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 25);
  assert.match(result.results[0].error, /connection lost/);
});

test("cancellation after copying keeps all source occurrences", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = load({ fetch: async () => {
    calls++; controller.abort();
    return { ok: true, json: async () => ({ status: "STATUS_SUCCEEDED" }) };
  } });
  const items = [{ occurrenceId: "s", setVideoId: "s", videoId: "v", isAvailable: true }];
  const plan = api.planTransfer(items, "PLdest", { sourcePlaylistId: "PLsource", sourceEditable: true, destinationEditable: true });
  const result = await api.executeTransfer(plan, { snapshotFingerprint: plan.snapshotFingerprint, signal: controller.signal });
  assert.equal(calls, 1);
  assert.equal(result.copied, 1);
  assert.equal(result.removed, 0);
  assert.equal(result.cancelled, true);
});


test("partial batch status never authorizes source deletion", async () => {
  let calls = 0;
  const api = load({ fetch: async () => {
    calls++;
    return { ok: true, json: async () => ({ status: "STATUS_SUCCEEDED", playlistEditResults: [{ status: "STATUS_FAILED" }] }) };
  } });
  const plan = api.planTransfer([{ occurrenceId: "s", setVideoId: "s", videoId: "v" }], "PLdest", { sourcePlaylistId: "PLsource", sourceEditable: true, destinationEditable: true });
  const result = await api.executeTransfer(plan, { snapshotFingerprint: plan.snapshotFingerprint });
  assert.equal(calls, 1);
  assert.equal(result.removed, 0);
  assert.match(result.results[0].error, /partial batch failure/);
});

test("playlist artwork accepts HTTPS thumbnails only", () => {
  const api = load();
  const parse = url => api._test.parseItem({ videoId: "v", title: "Song", thumbnail: { thumbnails: [{ url }] } }, new Map(), new Set(), 0);
  assert.equal(parse("https://i.ytimg.com/vi/v/default.jpg").thumbnail, "https://i.ytimg.com/vi/v/default.jpg");
  assert.equal(parse("javascript:alert(1)").thumbnail, null);
});
