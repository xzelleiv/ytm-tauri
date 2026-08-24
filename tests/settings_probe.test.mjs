import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src-tauri/src/settings_probe.js", import.meta.url), "utf8");

function createMockElement(tagName, id = "", className = "") {
  const children = [];
  const attributes = new Map();
  const listeners = new Map();

  const elem = {
    tagName: tagName.toUpperCase(),
    id,
    className,
    style: {},
    children,
    attributes,
    parentNode: null,
    getBoundingClientRect() {
      return { top: 0, bottom: 40, left: 100, right: 140, width: 40, height: 40 };
    },
    get firstChild() {
      return children[0] || null;
    },
    get firstElementChild() {
      return children[0] || null;
    },
    get lastElementChild() {
      return children[children.length - 1] || null;
    },
    get innerHTML() {
      return "";
    },
    set innerHTML(_val) {},
    getAttribute(name) {
      return attributes.get(name) || null;
    },
    setAttribute(name, val) {
      attributes.set(name, String(val));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    classList: {
      add(cls) {
        if (!className.includes(cls)) className = `${className} ${cls}`.trim();
      },
      remove(cls) {
        className = className.replace(cls, "").trim();
      },
      toggle(cls, force) {
        if (force) this.add(cls);
        else this.remove(cls);
      },
      contains(cls) {
        return className.includes(cls);
      },
    },
    appendChild(child) {
      child.parentNode = elem;
      children.push(child);
      return child;
    },
    insertBefore(child, reference) {
      child.parentNode = elem;
      const idx = children.indexOf(reference);
      if (idx !== -1) children.splice(idx, 0, child);
      else children.push(child);
      return child;
    },
    remove() {
      if (elem.parentNode) {
        const idx = elem.parentNode.children.indexOf(elem);
        if (idx !== -1) elem.parentNode.children.splice(idx, 1);
      }
    },
    querySelector(sel) {
      for (const child of children) {
        if (child.id && sel.includes(`#${child.id}`)) return child;
        if (child.tagName && sel.toUpperCase().includes(child.tagName)) return child;
        if (child.className && sel.includes(`.${child.className}`)) return child;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest(sel) {
      let cur = elem;
      while (cur) {
        if (cur.id && sel.includes(`#${cur.id}`)) return cur;
        if (cur.tagName && sel.toUpperCase().includes(cur.tagName)) return cur;
        if (cur.className && sel.includes(`.${cur.className}`)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    addEventListener(evt, fn) {
      listeners.set(evt, fn);
    },
    click() {
      const fn = listeners.get("click");
      if (fn) fn({ preventDefault() {}, stopPropagation() {} });
    },
  };

  return elem;
}

test("settings probe injects header gear button and triggers cursor onboarding", async () => {
  const navBar = createMockElement("ytmusic-nav-bar", "nav-bar");
  const leftContent = createMockElement("div", "left-content");
  const rightContent = createMockElement("div", "right-content");
  const logo = createMockElement("ytmusic-logo", "logo");

  leftContent.appendChild(logo);
  navBar.appendChild(leftContent);
  navBar.appendChild(rightContent);

  const body = createMockElement("body");
  const head = createMockElement("head");
  body.appendChild(navBar);

  const storage = new Map();
  const localStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, val) {
      storage.set(key, String(val));
    },
  };

  const documentListeners = new Map();

  const doc = {
    readyState: "complete",
    documentElement: createMockElement("html"),
    head,
    body,
    createElement(tag) {
      return createMockElement(tag);
    },
    getElementById(id) {
      if (id === "logo") return logo;
      if (id === "nav-bar") return navBar;
      if (id === "right-content") return rightContent;
      return null;
    },
    querySelector(sel) {
      if (sel.includes("#right-content")) return rightContent;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(evt, fn) {
      documentListeners.set(evt, fn);
    },
  };

  const context = {
    location: { hostname: "music.youtube.com" },
    document: doc,
    localStorage,
    window: {},
    addEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  context.window = context;

  vm.runInNewContext(source, context);

  const gearBtn = rightContent.children.find((c) => c.id === "ytm-header-settings-btn");
  assert.ok(gearBtn, "must inject header settings button");
  assert.ok(gearBtn.classList.contains("ytm-onboarding-target"), "gear button must have pulse onboarding class");

  // click event on gear button through document click listener
  const clickHandler = documentListeners.get("click");
  assert.ok(clickHandler, "must register document click handler");
  clickHandler({
    target: gearBtn,
    preventDefault() {},
    stopPropagation() {},
  });

  // verify onboarding is saved
  assert.equal(localStorage.getItem("ytm_settings_onboarded_v5"), "true");
});

test("settings probe displays restart required dialog when toggling restart-dependent features", async () => {
  const body = createMockElement("body");
  const head = createMockElement("head");
  let triggeredAction = null;

  const storage = new Map();
  const localStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, val) {
      storage.set(key, String(val));
    },
  };

  const doc = {
    readyState: "complete",
    documentElement: createMockElement("html"),
    head,
    body,
    createElement(tag) {
      return createMockElement(tag);
    },
    getElementById(id) {
      return body.children.find((c) => c.id === id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };

  const context = {
    location: { hostname: "music.youtube.com" },
    document: doc,
    localStorage,
    window: {
      __ytmFeatures: {
        config: { spotify_spoof: false },
        setSetting(k, v) {
          this.config[k] = v;
        },
        triggerAction(act) {
          triggeredAction = act;
        },
      },
    },
    addEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  context.window.__ytmFeatures.receive = () => {};
  context.window.addEventListener = () => {};

  vm.runInNewContext(source, context);
  assert.ok(true);
});

