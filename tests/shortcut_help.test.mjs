import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../src-tauri/src/shortcut_help_probe.js", import.meta.url),
  "utf8"
);

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = {};
    this.style = {};
    this.id = "";
    this.className = "";
    this.textContent = "";
    this.type = "";
    this.classList = { add() {}, remove() {} };
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatchEvent(type, event = {}) {
    this.listeners.get(type)?.({ target: this, ...event });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  closest(selector) {
    const tags = selector.split(",").map((item) => item.trim().split(" ").at(-1).split("[")[0].toUpperCase());
    return tags.includes(this.tagName) ? this : null;
  }

  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }

  querySelector(selector) {
    if (selector.startsWith("#")) return this.find((child) => child.id === selector.slice(1));
    if (selector === "button") return this.find((child) => child.tagName === "BUTTON");
    return null;
  }
}

function createRuntime(hostname = "music.youtube.com") {
  const document = {
    activeElement: null,
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    head: null,
    body: null,
    documentElement: null,
    listeners: new Map(),
    addEventListener(type, listener) {
      document.listeners.set(type, listener);
    },
    getElementById(id) {
      return document.body.find((child) => child.id === id) || document.head.find((child) => child.id === id);
    },
  };
  document.head = new FakeElement("head", document);
  document.body = new FakeElement("body", document);
  document.documentElement = new FakeElement("html", document);
  const focusAnchor = new FakeElement("button", document);
  document.body.appendChild(focusAnchor);
  document.activeElement = focusAnchor;
  const context = {
    document,
    location: { hostname },
    window: null,
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { context, document, focusAnchor };
}

function keydown(document, target, key, modifiers = {}) {
  let prevented = false;
  let stopped = false;
  const event = {
    key,
    target,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
    ...modifiers,
  };
  document.listeners.get("keydown")(event);
  return { prevented, stopped };
}

test("shortcut help only installs on the exact YouTube Music host", () => {
  assert.ok(createRuntime().context.window.__ytmShortcutHelp);
  assert.equal(createRuntime("music.youtube.com.evil.test").context.window.__ytmShortcutHelp, undefined);
  assert.equal(createRuntime("www.youtube.com").context.window.__ytmShortcutHelp, undefined);
});

test("shortcut list mirrors native media and local controls", () => {
  const { context } = createRuntime();
  assert.deepEqual([...context.window.__ytmShortcutHelp.list()].map(({ key }) => key), [
    "Ctrl+Alt+A", "Ctrl+Alt+S", "Ctrl+Alt+D", "Ctrl+R", "Ctrl+=", "Ctrl+-",
    "Ctrl+0", "Ctrl+Shift+Delete", "F12", "Ctrl+Shift+I", "Ctrl+H",
  ]);
});

test("Ctrl+H opens an accessible dialog and restores focus on close", () => {
  const { context, document, focusAnchor } = createRuntime();
  const result = keydown(document, focusAnchor, "h", { ctrlKey: true });
  assert.deepEqual(result, { prevented: true, stopped: true });
  const overlay = document.body.find((child) => child.id === "ytm-shortcut-help");
  const dialog = overlay.children[0];
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(document.activeElement.tagName, "BUTTON");

  keydown(document, document.activeElement, "Escape");
  assert.equal(document.body.find((child) => child.id === "ytm-shortcut-help"), null);
  assert.equal(document.activeElement, focusAnchor);
  assert.equal(context.window.__ytmShortcutHelp.list().length, 11);
});

test("shortcut help does not intercept typing and closes on backdrop click", () => {
  const { context, document, focusAnchor } = createRuntime();
  const input = document.createElement("input");
  const typing = keydown(document, input, "h", { ctrlKey: true });
  assert.deepEqual(typing, { prevented: false, stopped: false });
  const browserShortcut = keydown(document, focusAnchor, "h", { ctrlKey: true, altKey: true });
  assert.deepEqual(browserShortcut, { prevented: false, stopped: false });

  context.window.__ytmShortcutHelp.show();
  const overlay = document.body.find((child) => child.id === "ytm-shortcut-help");
  overlay.dispatchEvent("click");
  assert.equal(document.body.find((child) => child.id === "ytm-shortcut-help"), null);
  assert.equal(document.activeElement, focusAnchor);
});
