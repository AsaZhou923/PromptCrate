import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSelectionTracker,
  findInsertTarget,
  insertTextAtSavedSelection,
  SavedSelection,
} from "../../src/content/input-target";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("DOM text insertion", () => {
  it("appends to email inputs without calling unsupported selection APIs", () => {
    const input = document.createElement("input");
    input.type = "email";
    input.value = "qa@example.test";
    document.body.append(input);
    input.focus();
    const tracker = createSelectionTracker();
    try {
      const savedSelection = tracker.rememberCurrentSelection();
      expect(savedSelection).toMatchObject({ start: 15, end: 15 });
      const setSelection = vi.spyOn(input, "setSelectionRange");
      const onInput = vi.fn();
      input.addEventListener("input", onInput);

      expect(insertTextAtSavedSelection(savedSelection, ".au")).toBe(true);
      expect(input.value).toBe("qa@example.test.au");
      expect(setSelection).not.toHaveBeenCalled();
      expect(onInput).toHaveBeenCalledOnce();
    } finally {
      tracker.destroy();
    }
  });

  it.each(["input", "textarea"] as const)("rejects blocked %s targets and clears an earlier saved target", (tag) => {
    const editable = document.createElement("input");
    const blocked = document.createElement(tag);
    blocked.readOnly = true;
    blocked.value = "Cannot edit";
    document.body.append(editable, blocked);
    const tracker = createSelectionTracker();
    try {
      editable.focus();
      expect(tracker.getSavedSelection()?.target).toBe(editable);
      blocked.focus();
      expect(findInsertTarget(blocked)).toBeNull();
      expect(tracker.rememberCurrentSelection()).toBeNull();
      expect(tracker.getSavedSelection()).toBeNull();
      blocked.readOnly = false;
      blocked.disabled = true;
      expect(findInsertTarget(blocked)).toBeNull();
    } finally {
      tracker.destroy();
    }
  });

  it.each(["input", "textarea"] as const)("rechecks %s editability before inserting and after beforeinput", (tag) => {
    for (const attribute of ["readOnly", "disabled"] as const) {
      for (const changeDuringEvent of [false, true]) {
        const target = document.createElement(tag);
        target.value = "Cannot edit";
        document.body.append(target);
        const savedSelection: SavedSelection = {
          kind: "text-control", target, start: 0, end: 0,
        };
        const onInput = vi.fn();
        const onBeforeInput = vi.fn(() => { target[attribute] = true; });
        target.addEventListener("input", onInput);
        if (changeDuringEvent) {
          target.addEventListener("beforeinput", onBeforeInput);
        } else {
          target[attribute] = true;
        }

        expect(insertTextAtSavedSelection(savedSelection, "replace")).toBe(false);
        expect(target.value).toBe("Cannot edit");
        expect(onInput).not.toHaveBeenCalled();
        expect(onBeforeInput).toHaveBeenCalledTimes(changeDuringEvent ? 1 : 0);
        target.remove();
      }
    }
  });

  it("rejects controls disabled by a fieldset while allowing the first legend", () => {
    document.body.innerHTML = '<fieldset disabled><legend><input id="allowed"></legend><input id="blocked"></fieldset>';
    const blocked = document.querySelector<HTMLInputElement>("#blocked")!;
    expect(findInsertTarget(blocked)).toBeNull();
    expect(insertTextAtSavedSelection({ kind: "text-control", target: blocked, start: 0, end: 0 }, "text")).toBe(false);
    expect(findInsertTarget(document.querySelector("#allowed"))).not.toBeNull();
  });

  it.each([true, false])("sends composed Shadow DOM events with InputEvent available: %s", (useInputEvent) => {
    if (!useInputEvent) {
      vi.stubGlobal("InputEvent", undefined);
    }
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.value = "Shadow ";
    root.append(input);
    document.body.append(host);
    const hostEvents: Event[] = [];
    const documentEvents: Event[] = [];
    const recordDocumentEvent = (event: Event) => { documentEvents.push(event); };
    for (const type of ["beforeinput", "input"]) {
      host.addEventListener(type, (event) => { hostEvents.push(event); });
      document.addEventListener(type, recordDocumentEvent);
    }
    const savedSelection: SavedSelection = {
      kind: "text-control", target: input, start: 7, end: 7,
    };
    try {
      expect(insertTextAtSavedSelection(savedSelection, "text")).toBe(true);
      expect(input.value).toBe("Shadow text");
      expect(hostEvents.map((event) => event.type)).toEqual(["beforeinput", "input"]);
      expect(documentEvents).toEqual(hostEvents);
      expect(hostEvents.every((event) => event.composed && event.bubbles && event.target === host)).toBe(true);
      expect(hostEvents[0].cancelable).toBe(true);
      expect(hostEvents[1].cancelable).toBe(false);
      if (useInputEvent) {
        expect(hostEvents[1]).toMatchObject({ data: "text", inputType: "insertText" });
      }

      hostEvents.length = 0;
      documentEvents.length = 0;
      host.addEventListener("beforeinput", (event) => event.preventDefault());
      expect(insertTextAtSavedSelection(savedSelection, "canceled")).toBe(false);
      expect(input.value).toBe("Shadow text");
      expect(hostEvents.map((event) => event.type)).toEqual(["beforeinput"]);
      expect(documentEvents).toEqual(hostEvents);
    } finally {
      for (const type of ["beforeinput", "input"]) {
        document.removeEventListener(type, recordDocumentEvent);
      }
    }
  });

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
