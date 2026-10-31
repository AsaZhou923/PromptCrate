import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSelectionTracker,
  findEditableTarget,
  findInsertTarget,
  insertTextAtSavedSelection,
  SavedSelection,
} from "../../src/content/input-target";

const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  document.body.innerHTML = "";
});

function setComputedEditable(element: HTMLElement, value: boolean | (() => boolean)): void {
  // jsdom does not calculate this browser property; native inheritance is covered by E2E.
  Object.defineProperty(element, "isContentEditable", {
    configurable: true,
    get: typeof value === "function" ? value : () => value,
  });
}

function mockExecCommand(implementation: (command: string, showUI?: boolean, value?: string) => boolean) {
  const command = vi.fn(implementation);
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
  return command;
}

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
      const execCommand = mockExecCommand(() => { throw new Error("Unsupported email command"); });

      expect(insertTextAtSavedSelection(savedSelection, ".au")).toBe(true);
      expect(input.value).toBe("qa@example.test.au");
      expect(setSelection).not.toHaveBeenCalled();
      expect(onInput).toHaveBeenCalledOnce();
      expect(execCommand).not.toHaveBeenCalled();
    } finally {
      tracker.destroy();
    }
  });

  it.each(["input", "textarea"] as const)("restores a saved %s selection for native editing and delivers one input event", (tag) => {
    const target = document.createElement(tag);
    target.value = "Before REPLACE after";
    document.body.append(target);
    target.setSelectionRange(0, 0);
    const events: Event[] = [];
    target.addEventListener("beforeinput", (event) => { events.push(event); });
    target.addEventListener("input", (event) => { events.push(event); });
    const nativeInput = new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "inserted" });
    const execCommand = mockExecCommand(() => {
      expect(document.activeElement).toBe(target);
      expect([target.selectionStart, target.selectionEnd]).toEqual([7, 14]);
      target.setRangeText("inserted", 7, 14, "end");
      target.dispatchEvent(nativeInput);
      return true;
    });

    expect(insertTextAtSavedSelection({ kind: "text-control", target, start: 7, end: 14 }, "inserted")).toBe(true);
    expect(execCommand).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "inserted");
    expect(target.value).toBe("Before inserted after");
    expect(events.map((event) => event.type)).toEqual(["beforeinput", "input"]);
    expect(events[0]).toMatchObject({ bubbles: true, composed: true, cancelable: true });
    expect(events[1]).toBe(nativeInput);
  });

  it.each(["input", "textarea"] as const)("keeps the saved %s replacement range when beforeinput moves the caret", (tag) => {
    const target = document.createElement(tag);
    target.value = "Before REPLACE after";
    document.body.append(target);
    target.addEventListener("beforeinput", () => {
      target.setSelectionRange(target.value.length, target.value.length);
    });
    let nativeSelection: (number | null)[] = [];
    mockExecCommand(() => {
      nativeSelection = [target.selectionStart, target.selectionEnd];
      target.setRangeText("inserted", target.selectionStart!, target.selectionEnd!, "end");
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "inserted" }));
      return true;
    });

    expect(insertTextAtSavedSelection({ kind: "text-control", target, start: 7, end: 14 }, "inserted")).toBe(true);
    expect(nativeSelection).toEqual([7, 14]);
    expect(target.value).toBe("Before inserted after");
  });

  it.each(["input", "textarea"] as const)("rejects an oversized %s insertion before changing the field", (tag) => {
    const target = document.createElement(tag);
    target.value = "abcde";
    target.maxLength = 5;
    document.body.append(target);
    const execCommand = mockExecCommand(() => true);
    const onInput = vi.fn();
    target.addEventListener("input", onInput);

    expect(insertTextAtSavedSelection({ kind: "text-control", target, start: 2, end: 3 }, "XY")).toBe(false);
    expect(target.value).toBe("abcde");
    expect(execCommand).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea"] as const)("allows a %s replacement that exactly fits maxlength", (tag) => {
    const target = document.createElement(tag);
    target.value = "abcde";
    target.maxLength = 6;
    document.body.append(target);
    const execCommand = mockExecCommand(() => {
      target.setRangeText("XY", target.selectionStart!, target.selectionEnd!, "end");
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "XY" }));
      return true;
    });

    expect(insertTextAtSavedSelection({ kind: "text-control", target, start: 4, end: 5 }, "XY")).toBe(true);
    expect(target.value).toBe("abcdXY");
    expect(execCommand).toHaveBeenCalledOnce();
  });

  it.each(["false", "throw"] as const)("falls back without duplicate events when the editing command returns %s", (outcome) => {
    const target = document.createElement("textarea");
    target.value = "Before REPLACE after";
    document.body.append(target);
    const onInput = vi.fn();
    const onBeforeInput = vi.fn();
    target.addEventListener("input", onInput);
    target.addEventListener("beforeinput", onBeforeInput);
    const execCommand = mockExecCommand(() => {
      if (outcome === "throw") {
        throw new Error("Native editing unavailable");
      }
      return false;
    });

    expect(insertTextAtSavedSelection({ kind: "text-control", target, start: 7, end: 14 }, "inserted")).toBe(true);
    expect(target.value).toBe("Before inserted after");
    expect(execCommand).toHaveBeenCalledOnce();
    expect(onBeforeInput).toHaveBeenCalledOnce();
    expect(onInput).toHaveBeenCalledOnce();
    expect(target.selectionStart).toBe(15);
  });

  it("does not run native editing when beforeinput is canceled", () => {
    const target = document.createElement("textarea");
    target.value = "Keep this";
    document.body.append(target);
    const execCommand = mockExecCommand(() => true);
    const onInput = vi.fn();
    target.addEventListener("beforeinput", (event) => event.preventDefault());
    target.addEventListener("input", onInput);

    expect(insertTextAtSavedSelection({ kind: "text-control", target, start: 0, end: 4 }, "Replace")).toBe(false);
    expect(target.value).toBe("Keep this");
    expect(execCommand).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
  });

  it.each(["false", "throw"] as const)("does not repeat an edit already delivered when the native command ends with %s", (outcome) => {
    const target = document.createElement("textarea");
    target.value = "Before REPLACE after";
    document.body.append(target);
    const onInput = vi.fn();
    target.addEventListener("input", onInput);
    mockExecCommand(() => {
      target.setRangeText("inserted", 7, 14, "end");
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "inserted" }));
      if (outcome === "throw") {
        throw new Error("Command failed after delivering its edit");
      }
      return false;
    });

    expect(insertTextAtSavedSelection({ kind: "text-control", target, start: 7, end: 14 }, "inserted")).toBe(true);
    expect(target.value).toBe("Before inserted after");
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("finds the contiguous editable root and stops at a noneditable island", () => {
    const outer = document.createElement("div");
    const inherited = document.createElement("span");
    const blocked = document.createElement("div");
    const reenabled = document.createElement("div");
    const child = document.createElement("span");
    outer.setAttribute("contenteditable", "");
    blocked.setAttribute("contenteditable", "false");
    reenabled.setAttribute("contenteditable", "true");
    setComputedEditable(outer, true);
    setComputedEditable(inherited, true);
    setComputedEditable(blocked, false);
    setComputedEditable(reenabled, true);
    setComputedEditable(child, true);
    outer.append(inherited, blocked);
    blocked.append(reenabled);
    reenabled.append(child);
    document.body.append(outer);

    expect(findEditableTarget(inherited)).toBe(outer);
    expect(findInsertTarget(blocked)).toBeNull();
    expect(findEditableTarget(child)).toBe(reenabled);
  });

  it("clears an earlier saved text control when a noneditable island gains focus", () => {
    const input = document.createElement("input");
    const outer = document.createElement("div");
    const blocked = document.createElement("div");
    outer.setAttribute("contenteditable", "true");
    blocked.setAttribute("contenteditable", "false");
    blocked.tabIndex = 0;
    setComputedEditable(outer, true);
    setComputedEditable(blocked, false);
    outer.append(blocked);
    document.body.append(input, outer);
    const tracker = createSelectionTracker();
    try {
      input.focus();
      expect(tracker.getSavedSelection()?.target).toBe(input);
      blocked.focus();
      expect(tracker.rememberCurrentSelection()).toBeNull();
      expect(tracker.getSavedSelection()).toBeNull();
    } finally {
      tracker.destroy();
    }
  });

  it.each([false, true])("rejects contenteditable revoked during beforeinput: %s", (duringEvent) => {
    const target = document.createElement("div");
    target.setAttribute("contenteditable", "true");
    target.tabIndex = 0;
    target.textContent = "Keep this";
    let editable = duringEvent;
    setComputedEditable(target, () => editable);
    document.body.append(target);
    const execCommand = mockExecCommand(() => true);
    const onInput = vi.fn();
    const onBeforeInput = vi.fn(() => { editable = false; });
    target.addEventListener("beforeinput", onBeforeInput);
    target.addEventListener("input", onInput);

    expect(insertTextAtSavedSelection({ kind: "contenteditable", target, range: null }, "Replace")).toBe(false);
    expect(target.textContent).toBe("Keep this");
    expect(execCommand).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
    expect(onBeforeInput).toHaveBeenCalledTimes(duringEvent ? 1 : 0);
  });

  it("uses contenteditable native input without dispatching it twice", () => {
    const target = document.createElement("div");
    target.setAttribute("contenteditable", "true");
    target.tabIndex = 0;
    target.textContent = "Original";
    setComputedEditable(target, true);
    document.body.append(target);
    const events: Event[] = [];
    target.addEventListener("beforeinput", (event) => { events.push(event); });
    target.addEventListener("input", (event) => { events.push(event); });
    const nativeInput = new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "Inserted" });
    mockExecCommand(() => {
      target.textContent = "OriginalInserted";
      target.dispatchEvent(nativeInput);
      return true;
    });

    expect(insertTextAtSavedSelection({ kind: "contenteditable", target, range: null }, "Inserted")).toBe(true);
    expect(target.textContent).toBe("OriginalInserted");
    expect(events.map((event) => event.type)).toEqual(["beforeinput", "input"]);
    expect(events[1]).toBe(nativeInput);
  });

  it("keeps the saved contenteditable range when beforeinput moves the selection", () => {
    const target = document.createElement("div");
    target.setAttribute("contenteditable", "true");
    target.tabIndex = 0;
    target.textContent = "Before REPLACE after";
    setComputedEditable(target, true);
    document.body.append(target);
    const range = document.createRange();
    range.setStart(target.firstChild!, 7);
    range.setEnd(target.firstChild!, 14);
    target.addEventListener("beforeinput", () => {
      const movedRange = document.createRange();
      movedRange.selectNodeContents(target);
      movedRange.collapse(false);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(movedRange);
    });
    let replacedText = "";
    mockExecCommand(() => {
      const nativeRange = document.getSelection()!.getRangeAt(0);
      replacedText = nativeRange.toString();
      nativeRange.deleteContents();
      nativeRange.insertNode(document.createTextNode("inserted"));
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "inserted" }));
      return true;
    });

    expect(insertTextAtSavedSelection({ kind: "contenteditable", target, range }, "inserted")).toBe(true);
    expect(replacedText).toBe("REPLACE");
    expect(target.textContent).toBe("Before inserted after");
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
    setComputedEditable(editable, true);
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
