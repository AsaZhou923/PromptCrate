import { afterEach, describe, expect, it } from "vitest";
import {
  createSelectionTracker,
  insertTextAtSavedSelection,
} from "../../src/content/input-target";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("selection tracking around extension UI", () => {
  it.each(["input", "textarea"] as const)("preserves a %s selection through nested extension shadow inputs", (tag) => {
    const target = document.createElement(tag);
    target.value = "Before REPLACE after";
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const search = document.createElement("input");
    const nestedHost = document.createElement("div");
    const nestedShadow = nestedHost.attachShadow({ mode: "open" });
    const variable = document.createElement("input");
    nestedShadow.append(variable);
    shadow.append(search, nestedHost);
    document.body.append(target, host);

    const tracker = createSelectionTracker(document, (element) => element === host);
    try {
      target.focus();
      target.setSelectionRange(7, 14);
      const original = tracker.rememberCurrentSelection();
      for (const input of [search, variable]) {
        input.focus();
        document.dispatchEvent(new Event("selectionchange"));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true }));
        expect(tracker.rememberCurrentSelection()).toBe(original);
        expect(tracker.getSavedSelection()).toBe(original);
      }
      expect(insertTextAtSavedSelection(tracker.getSavedSelection(), "inserted")).toBe(true);
      expect(target.value).toBe("Before inserted after");
    } finally {
      tracker.destroy();
    }
  });

  it("does not invent a target from extension UI when no page target was saved", () => {
    const host = document.createElement("div");
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(input);
    document.body.append(host);
    const tracker = createSelectionTracker(document, (element) => element === host);
    try {
      input.focus();
      expect(tracker.rememberCurrentSelection()).toBeNull();
      expect(tracker.getSavedSelection()).toBeNull();
    } finally {
      tracker.destroy();
    }
  });

  it("discards a disconnected page target without falling back to extension UI", () => {
    const target = document.createElement("textarea");
    const host = document.createElement("div");
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(input);
    document.body.append(target, host);
    const tracker = createSelectionTracker(document, (element) => element === host);
    try {
      target.focus();
      expect(tracker.getSavedSelection()?.target).toBe(target);
      input.focus();
      target.remove();
      expect(tracker.getSavedSelection()).toBeNull();
    } finally {
      tracker.destroy();
    }
  });

  it("continues to track ordinary page shadow inputs", () => {
    const extensionHost = document.createElement("div");
    const pageHost = document.createElement("div");
    const input = document.createElement("input");
    input.value = "Page REPLACE";
    pageHost.attachShadow({ mode: "open" }).append(input);
    document.body.append(extensionHost, pageHost);
    const tracker = createSelectionTracker(document, (element) => element === extensionHost);
    try {
      input.focus();
      input.setSelectionRange(5, 12);
      expect(tracker.rememberCurrentSelection()).toMatchObject({
        target: input, start: 5, end: 12,
      });
      expect(insertTextAtSavedSelection(tracker.getSavedSelection(), "shadow")).toBe(true);
      expect(input.value).toBe("Page shadow");
    } finally {
      tracker.destroy();
    }
  });
});
