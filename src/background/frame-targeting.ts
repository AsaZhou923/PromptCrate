export type FocusedInsertProbe = {
  hasFocusedInsertTarget: boolean;
};

export type FrameProbeResult = {
  frameId?: number;
  result?: FocusedInsertProbe;
};

export function detectFocusedInsertTarget(): FocusedInsertProbe {
  const textInputTypes = new Set([
    "",
    "text",
    "search",
    "email",
    "url",
    "tel",
    "password",
  ]);
  const activeElement = getDeepActiveElement(document);

  return {
    hasFocusedInsertTarget: isInsertTarget(activeElement),
  };

  function getDeepActiveElement(rootDocument: Document): Element | null {
    let currentActiveElement = rootDocument.activeElement;

    while (currentActiveElement?.shadowRoot?.activeElement) {
      currentActiveElement = currentActiveElement.shadowRoot.activeElement;
    }

    return currentActiveElement;
  }

  function isInsertTarget(element: Element | null): boolean {
    if (!element) {
      return false;
    }

    if (element instanceof HTMLTextAreaElement) {
      return true;
    }

    if (
      element instanceof HTMLInputElement &&
      textInputTypes.has(element.type.toLocaleLowerCase())
    ) {
      return true;
    }

    return Boolean(
      element.closest('[contenteditable="true"], [contenteditable="plaintext-only"]'),
    );
  }
}

export function selectPromptMenuFrameIds(results: FrameProbeResult[]): number[] {
  const focusedFrameIds = results
    .filter((item) => item.result?.hasFocusedInsertTarget === true)
    .map((item) => item.frameId)
    .filter((frameId): frameId is number => typeof frameId === "number");

  return focusedFrameIds.length > 0 ? [...new Set(focusedFrameIds)] : [0];
}
