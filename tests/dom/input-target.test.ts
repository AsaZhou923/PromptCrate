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
    let inputEvents = 0;
    textarea.addEventListener("input", () => {
      inputEvents += 1;
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
    expect(inputEvents).toBe(1);
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

