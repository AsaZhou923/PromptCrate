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
    return true;
  }

  return (
    element instanceof HTMLInputElement &&
    TEXT_INPUT_TYPES.has(element.type.toLocaleLowerCase())
  );
}

export function findEditableTarget(element: EventTarget | null): EditableTarget | null {
  if (!(element instanceof Element)) {
    return null;
  }

  const editable = element.closest<HTMLElement>(
    '[contenteditable="true"], [contenteditable="plaintext-only"]',
  );

  return editable;
}

export function findInsertTarget(element: EventTarget | null): InsertTarget | null {
  if (isTextControlTarget(element)) {
    return element;
  }

  return findEditableTarget(element);
}

export function createSelectionTracker(rootDocument: Document = document) {
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

    savedSelection = {
      kind: "contenteditable",
      target,
      range: cloneSelectionRange(rootDocument, target),
    };
    return savedSelection;
  }

  function rememberCurrentSelection(): SavedSelection | null {
    const activeTarget = findInsertTarget(rootDocument.activeElement);
    return rememberTarget(activeTarget);
  }

  function getSavedSelection(): SavedSelection | null {
    if (savedSelection && isConnected(savedSelection.target)) {
      return savedSelection;
    }

    savedSelection = null;
    return rememberCurrentSelection();
  }

  function handleFocusIn(event: FocusEvent): void {
    rememberTarget(findInsertTarget(event.target));
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
  const originalValue = target.value;
  const start = clampSelectionIndex(savedSelection.start, originalValue.length);
  const end = clampSelectionIndex(savedSelection.end, originalValue.length);

  try {
    target.focus();
    target.value = `${originalValue.slice(0, start)}${text}${originalValue.slice(end)}`;
    const nextCaret = start + text.length;
    target.setSelectionRange(nextCaret, nextCaret);
    dispatchInputEvent(target, text);
    return true;
  } catch {
    target.value = originalValue;
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

  try {
    target.focus();

    const range = getUsableRange(savedSelection, target, ownerDocument);
    range.deleteContents();

    const textNode = ownerDocument.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);

    const selection = ownerDocument.getSelection();
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

function isConnected(target: InsertTarget): boolean {
  return target.isConnected;
}

function clampSelectionIndex(index: number, max: number): number {
  return Math.min(Math.max(index, 0), max);
}

function dispatchInputEvent(target: InsertTarget, text: string): void {
  const event = typeof InputEvent === "function"
    ? new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    : new Event("input", { bubbles: true });

  target.dispatchEvent(event);
}

