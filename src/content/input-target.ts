export type TextControlTarget = HTMLInputElement | HTMLTextAreaElement;
export type EditableTarget = HTMLElement;
export type InsertTarget = TextControlTarget | EditableTarget;

export type SavedSelection =
  | {
      kind: "text-control";
      target: TextControlTarget;
      start: number;
      end: number;
    }
  | {
      kind: "contenteditable";
      target: EditableTarget;
      range: Range | null;
    };

const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
]);

export function isTextControlTarget(
  element: EventTarget | null,
): element is TextControlTarget {
  if (element instanceof HTMLTextAreaElement) {
    return !element.readOnly && !element.matches(":disabled");
  }

  return (
    element instanceof HTMLInputElement &&
    !element.readOnly &&
    !element.matches(":disabled") &&
    TEXT_INPUT_TYPES.has(element.type.toLocaleLowerCase())
  );
}

export function findEditableTarget(element: EventTarget | null): EditableTarget | null {
  if (!(element instanceof HTMLElement) || !element.isContentEditable) {
    return null;
  }

  let editable = element;
  while (editable.parentElement?.isContentEditable) {
    editable = editable.parentElement;
  }

  return editable;
}

export function findInsertTarget(element: EventTarget | null): InsertTarget | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return isTextControlTarget(element) ? element : null;
  }

  return findEditableTarget(element);
}

export function createSelectionTracker(
  rootDocument: Document = document,
  isIgnoredElement: (element: Element) => boolean = () => false,
) {
  let savedSelection: SavedSelection | null = null;

  function rememberTarget(target: InsertTarget | null): SavedSelection | null {
    if (!target || !isConnected(target)) {
      return savedSelection;
    }

    if (isTextControlTarget(target)) {
      savedSelection = {
        kind: "text-control",
        target,
        start: target.selectionStart ?? target.value.length,
        end: target.selectionEnd ?? target.value.length,
      };
      return savedSelection;
    }

    const selection = rootDocument.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (range && targetContainsNode(target, range.commonAncestorContainer) && !isEditableRange(target, range)) {
      savedSelection = null;
      return null;
    }

    savedSelection = {
      kind: "contenteditable",
      target,
      range: cloneSelectionRange(rootDocument, target),
    };
    return savedSelection;
  }

  function rememberCurrentSelection(): SavedSelection | null {
    const activeElement = getDeepActiveElement(rootDocument);
    // Ignore extension UI, including descendants in nested shadow roots.
    let ancestor = activeElement;
    while (ancestor) {
      if (isIgnoredElement(ancestor)) {
        return savedSelection;
      }
      const root = ancestor.getRootNode();
      ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }

    const activeTarget = findInsertTarget(activeElement);
    if (
      !activeTarget &&
      (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement ||
        activeElement?.closest("[contenteditable]"))
    ) {
      savedSelection = null;
    }
    return rememberTarget(activeTarget);
  }

  function getSavedSelection(): SavedSelection | null {
    if (savedSelection && isConnected(savedSelection.target)) {
      return savedSelection;
    }

    savedSelection = null;
    return rememberCurrentSelection();
  }

  function handleFocusIn(): void {
    rememberCurrentSelection();
  }

  function handleSelectionChange(): void {
    rememberCurrentSelection();
  }

  function handlePointerOrKey(): void {
    rememberCurrentSelection();
  }

  rootDocument.addEventListener("focusin", handleFocusIn, true);
  rootDocument.addEventListener("selectionchange", handleSelectionChange);
  rootDocument.addEventListener("keyup", handlePointerOrKey, true);
  rootDocument.addEventListener("mouseup", handlePointerOrKey, true);

  return {
    getSavedSelection,
    rememberCurrentSelection,
    destroy() {
      rootDocument.removeEventListener("focusin", handleFocusIn, true);
      rootDocument.removeEventListener("selectionchange", handleSelectionChange);
      rootDocument.removeEventListener("keyup", handlePointerOrKey, true);
      rootDocument.removeEventListener("mouseup", handlePointerOrKey, true);
    },
  };
}

function getDeepActiveElement(rootDocument: Document): Element | null {
  let activeElement = rootDocument.activeElement;

  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }

  return activeElement;
}

export function insertTextAtSavedSelection(
  savedSelection: SavedSelection | null,
  text: string,
): boolean {
  if (!savedSelection || !isConnected(savedSelection.target)) {
    return false;
  }

  if (savedSelection.kind === "text-control") {
    return insertIntoTextControl(savedSelection, text);
  }

  return insertIntoContentEditable(savedSelection, text);
}

function insertIntoTextControl(
  savedSelection: Extract<SavedSelection, { kind: "text-control" }>,
  text: string,
): boolean {
  const { target } = savedSelection;
  if (!isTextControlTarget(target)) {
    return false;
  }

  const originalValue = target.value;
  const supportsSelection = target.selectionStart !== null && target.selectionEnd !== null;
  // Email inputs have no selection API, so append instead of guessing a caret position.
  const start = supportsSelection
    ? clampSelectionIndex(savedSelection.start, originalValue.length)
    : originalValue.length;
  const end = supportsSelection
    ? clampSelectionIndex(savedSelection.end, originalValue.length)
    : originalValue.length;
  const nextValue = `${originalValue.slice(0, start)}${text}${originalValue.slice(end)}`;
  // Native commands can report success after truncating (or rejecting) an oversized edit.
  if (target.maxLength >= 0 && nextValue.length > target.maxLength) {
    return false;
  }

  try {
    target.focus();
    if (supportsSelection) {
      target.setSelectionRange(start, end);
    }
    // Chromium's insertText command emits input, but needs this separate cancelable check.
    if (
      !isTextControlTarget(target) ||
      !dispatchBeforeInputEvent(target, text) ||
      !isTextControlTarget(target) ||
      !isConnected(target)
    ) {
      return false;
    }

    if (getDeepActiveElement(target.ownerDocument) !== target) {
      return false;
    }
    // Page beforeinput handlers may have moved the caret; keep the user's saved insertion range.
    if (supportsSelection) {
      target.setSelectionRange(start, end);
    }
    // Email inputs cannot restore a caret, so keep their documented append fallback.
    if (supportsSelection && tryExecCommandInsertText(target, text)) {
      return true;
    }

    setTextControlValue(target, nextValue);
    const nextCaret = start + text.length;
    if (supportsSelection) {
      target.setSelectionRange(nextCaret, nextCaret);
    }
    dispatchInputEvent(target, text);
    return true;
  } catch {
    setTextControlValue(target, originalValue);
    return false;
  }
}

function insertIntoContentEditable(
  savedSelection: Extract<SavedSelection, { kind: "contenteditable" }>,
  text: string,
): boolean {
  const { target } = savedSelection;
  const originalHtml = target.innerHTML;
  const ownerDocument = target.ownerDocument;
  if (!target.isContentEditable) {
    return false;
  }

  try {
    target.focus();

    const range = getUsableRange(savedSelection, target, ownerDocument);
    if (!isEditableRange(target, range)) {
      return false;
    }
    const selection = ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    if (!dispatchBeforeInputEvent(target, text) || !target.isContentEditable || !isConnected(target)) {
      return false;
    }

    if (target.innerHTML !== originalHtml) {
      dispatchInputEvent(target, text);
      return true;
    }

    if (getDeepActiveElement(ownerDocument) !== target || !isEditableRange(target, range)) {
      return false;
    }
    selection?.removeAllRanges();
    selection?.addRange(range);

    if (tryExecCommandInsertText(target, text)) {
      return true;
    }

    range.deleteContents();

    const textNode = ownerDocument.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    dispatchInputEvent(target, text);
    return true;
  } catch {
    target.innerHTML = originalHtml;
    return false;
  }
}

function getUsableRange(
  savedSelection: Extract<SavedSelection, { kind: "contenteditable" }>,
  target: EditableTarget,
  ownerDocument: Document,
): Range {
  if (
    savedSelection.range &&
    targetContainsNode(target, savedSelection.range.commonAncestorContainer)
  ) {
    return savedSelection.range.cloneRange();
  }

  const range = ownerDocument.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  return range;
}

function cloneSelectionRange(
  rootDocument: Document,
  target: EditableTarget,
): Range | null {
  const selection = rootDocument.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  return targetContainsNode(target, range.commonAncestorContainer)
    ? range.cloneRange()
    : null;
}

function targetContainsNode(target: EditableTarget, node: Node): boolean {
  return node === target || target.contains(node);
}

function isEditableRange(target: EditableTarget, range: Range): boolean {
  return [range.startContainer, range.endContainer].every((node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return targetContainsNode(target, node) && findEditableTarget(element) === target;
  });
}

function isConnected(target: InsertTarget): boolean {
  return target.isConnected;
}

function clampSelectionIndex(index: number, max: number): number {
  return Math.min(Math.max(index, 0), max);
}

function setTextControlValue(target: TextControlTarget, value: string): void {
  const prototype = target instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor?.set) {
    descriptor.set.call(target, value);
    return;
  }

  target.value = value;
}

function dispatchBeforeInputEvent(target: InsertTarget, text: string): boolean {
  const event = typeof InputEvent === "function"
    ? new InputEvent("beforeinput", {
        bubbles: true,
        composed: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      })
    : new Event("beforeinput", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });

  return target.dispatchEvent(event);
}

function dispatchInputEvent(target: InsertTarget, text: string): void {
  const event = typeof InputEvent === "function"
    ? new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: text,
      })
    : new Event("input", { bubbles: true, composed: true });

  target.dispatchEvent(event);
}

function tryExecCommandInsertText(target: InsertTarget, text: string): boolean {
  const readValue = () => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    ? target.value
    : target.innerHTML;
  const originalValue = readValue();
  let receivedInput = false;
  const recordInput = () => { receivedInput = true; };
  target.addEventListener("input", recordInput, true);
  let didExecute = false;
  try {
    didExecute = target.ownerDocument.execCommand?.("insertText", false, text) === true;
  } catch {
    // Some editors reject native commands; use the existing fallback if nothing was inserted.
  } finally {
    target.removeEventListener("input", recordInput, true);
  }
  if (didExecute || receivedInput) {
    return true;
  }
  if (readValue() !== originalValue) {
    dispatchInputEvent(target, text);
    return true;
  }
  return false;
}
