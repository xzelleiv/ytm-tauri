import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../src-tauri/src/auth_recovery_probe.js", import.meta.url),
  "utf8"
);

function createRuntime({ hostname, pathname = "/", search = "", bodyText = "", activeInput = false, errorSelectors = [] }) {
  let replacedUrl = null;
  let timerCallbacks = [];

  const context = {
    URLSearchParams,
    location: {
      hostname,
      pathname,
      search,
      hash: "",
      replace(url) {
        replacedUrl = url;
      },
    },
    window: {
      history: {
        replaceState(state, title, url) {
          context.location.pathname = url;
          context.location.search = "";
        },
      },
    },
    document: {
      readyState: "complete",
      addEventListener() {},
      activeElement: activeInput ? { tagName: "INPUT" } : null,
      body: {
        innerText: bodyText,
      },
      querySelectorAll(selector) {
        if (activeInput && selector.includes("password")) {
          return [{ offsetParent: {}, disabled: false }];
        }
        return [];
      },
      querySelector(selector) {
        if (errorSelectors.includes(selector)) {
          return { textContent: "Something went wrong. Please try again." };
        }
        return null;
      },
    },
    setTimeout(cb) {
      timerCallbacks.push(cb);
      return timerCallbacks.length;
    },
  };
  context.window.location = context.location;
  context.window.document = context.document;

  vm.runInNewContext(source, context);

  return {
    context,
    getReplacedUrl: () => replacedUrl,
    runTimers: () => {
      for (const cb of timerCallbacks) {
        cb();
      }
    },
  };
}

test("cleans action_handle_signin on music.youtube.com", () => {
  const { context } = createRuntime({
    hostname: "music.youtube.com",
    pathname: "/",
    search: "?action_handle_signin=true",
  });

  assert.equal(context.location.pathname, "/");
  assert.equal(context.location.search, "");
});

test("does not execute recovery logic on Google authentication pages", () => {
  const runtime = createRuntime({
    hostname: "accounts.youtube.com",
    pathname: "/accounts/SetSID",
  });

  runtime.runTimers();
  assert.equal(runtime.getReplacedUrl(), null);
});

test("does not redirect when user is actively filling in password", () => {
  const runtime = createRuntime({
    hostname: "accounts.google.com",
    pathname: "/signin/v2/identifier",
    activeInput: true,
  });

  runtime.runTimers();
  assert.equal(runtime.getReplacedUrl(), null);
});

test("does not redirect Google authentication error screens", () => {
  const runtime = createRuntime({
    hostname: "accounts.google.com",
    pathname: "/signin",
    bodyText: "Couldn't sign you in. Something went wrong.",
  });

  runtime.runTimers();
  assert.equal(runtime.getReplacedUrl(), null);
});

test("redirects from oops page to music.youtube.com", () => {
  const runtime = createRuntime({
    hostname: "music.youtube.com",
    pathname: "/oops",
  });

  runtime.runTimers();
  assert.equal(runtime.getReplacedUrl(), "https://music.youtube.com/");
});

test("does not redirect ordinary YouTube pages", () => {
  const runtime = createRuntime({
    hostname: "www.youtube.com",
    pathname: "/",
  });

  runtime.runTimers();
  assert.equal(runtime.getReplacedUrl(), null);
});

test("does not redirect when user is on AccountChooser selection screen", () => {
  const runtime = createRuntime({
    hostname: "accounts.google.com",
    pathname: "/AccountChooser",
  });

  runtime.runTimers();
  assert.equal(runtime.getReplacedUrl(), null);
});

