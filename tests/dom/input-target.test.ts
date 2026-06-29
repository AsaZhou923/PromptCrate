import { afterEach, describe, expect, it } from "vitest";
import {
  insertTextAtSavedSelection,
  SavedSelection,
} from "../../src/content/input-target";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DOM text insertion", () => {
  it("inserts into textarea at the saved selection", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello world";
    document.body.append(textarea);
    const events: string[] = [];
    textarea.addEventListener("beforeinput", () => {
      events.push("beforeinput");
    });
    textarea.addEventListener("input", () => {
      events.push("input");
    });

    const savedSelection: SavedSelection = {
      kind: "text-control",
      target: textarea,
      start: 6,
      end: 11,
    };

    expect(insertTextAtSavedSelection(savedSelection, "PromptCrate")).toBe(true);
    expect(textarea.value).toBe("hello PromptCrate");
    expect(textarea.selectionStart).toBe("hello PromptCrate".length);
    expect(events).toEqual(["beforeinput", "input"]);
  });

  it("inserts into text input at the saved selection", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "ask now";
    document.body.append(input);

    const savedSelection: SavedSelection = {
      kind: "text-control",
      target: input,
      start: 4,
      end: 7,
    };

    expect(insertTextAtSavedSelection(savedSelection, "later")).toBe(true);
    expect(input.value).toBe("ask later");
  });

  it("uses the native value setter so controlled inputs observe the input event", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "ask now";
    document.body.append(input);

    let ownSetterCalls = 0;
    const nativeDescriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );

    if (!nativeDescriptor?.get || !nativeDescriptor.set) {
      throw new Error("Missing native input value descriptor");
    }

    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return nativeDescriptor.get?.call(this);
      },
      set(value: string) {
        ownSetterCalls += 1;
        nativeDescriptor.set?.call(this, value);
      },
    });

    const savedSelection: SavedSelection = {
      kind: "text-control",
      target: input,
      start: 4,
      end: 7,
    };

    expect(insertTextAtSavedSelection(savedSelection, "later")).toBe(true);
    expect(input.value).toBe("ask later");
    expect(ownSetterCalls).toBe(0);
  });

  it("does not insert when beforeinput is canceled", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello world";
    document.body.append(textarea);
    textarea.addEventListener("beforeinput", (event) => {
      event.preventDefault();
    });

    const savedSelection: SavedSelection = {
      kind: "text-control",
      target: textarea,
      start: 6,
      end: 11,
    };

    expect(insertTextAtSavedSelection(savedSelection, "PromptCrate")).toBe(false);
    expect(textarea.value).toBe("hello world");
  });

  it("inserts into contenteditable at the saved range", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.textContent = "hello world";
    document.body.append(editable);
    const textNode = editable.firstChild;
    if (!textNode) {
      throw new Error("Missing text node");
    }
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 11);
    let inputEvents = 0;
    editable.addEventListener("input", () => {
      inputEvents += 1;
    });

    const savedSelection: SavedSelection = {
      kind: "contenteditable",
      target: editable,
      range,
    };

    expect(insertTextAtSavedSelection(savedSelection, "PromptCrate")).toBe(true);
    expect(editable.textContent).toBe("hello PromptCrate");
    expect(inputEvents).toBe(1);
  });

  it("does not modify text controls when insertion fails", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "abc";
    input.setSelectionRange = () => {
      throw new Error("cannot set selection");
    };
    document.body.append(input);

    const savedSelection: SavedSelection = {
      kind: "text-control",
      target: input,
      start: 1,
      end: 2,
    };

    expect(insertTextAtSavedSelection(savedSelection, "x")).toBe(false);
    expect(input.value).toBe("abc");
  });
});
