import { afterEach, describe, expect, it } from "vitest";
import {
  detectFocusedInsertTarget,
  selectPromptMenuFrameIds,
  type FrameProbeResult,
} from "../../src/background/frame-targeting";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("prompt menu frame targeting", () => {
  it.each(["input", "textarea"] as const)("excludes readonly and disabled %s targets, including Shadow DOM", (tag) => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const target = document.createElement(tag);
    root.append(target);
    document.body.append(host);
    target.focus();
    expect(detectFocusedInsertTarget().hasFocusedInsertTarget).toBe(true);
    target.readOnly = true;
    expect(detectFocusedInsertTarget().hasFocusedInsertTarget).toBe(false);
    target.readOnly = false;
    target.disabled = true;
    expect(detectFocusedInsertTarget().hasFocusedInsertTarget).toBe(false);
  });

  it("recognizes email inputs as supported targets", () => {
    const input = document.createElement("input");
    input.type = "email";
    document.body.append(input);
    input.focus();
    expect(detectFocusedInsertTarget().hasFocusedInsertTarget).toBe(true);
  });

  it("excludes inputs disabled through a fieldset", () => {
    document.body.innerHTML = '<fieldset><input></fieldset>';
    document.querySelector("input")!.focus();
    document.querySelector("fieldset")!.disabled = true;
    expect(detectFocusedInsertTarget().hasFocusedInsertTarget).toBe(false);
  });

  it("targets frames with a focused insert field", () => {
    const results: FrameProbeResult[] = [
      { frameId: 0, result: { hasFocusedInsertTarget: false } },
      { frameId: 12, result: { hasFocusedInsertTarget: true } },
      { frameId: 12, result: { hasFocusedInsertTarget: true } },
    ];

    expect(selectPromptMenuFrameIds(results)).toEqual([12]);
  });

  it("falls back to the top frame when no focused insert field is found", () => {
    expect(
      selectPromptMenuFrameIds([
        { frameId: 0, result: { hasFocusedInsertTarget: false } },
        { frameId: 12, result: { hasFocusedInsertTarget: false } },
      ]),
    ).toEqual([0]);
  });

  it("detects focused inputs inside open shadow roots", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.type = "text";
    shadow.append(input);
    document.body.append(host);

    input.focus();

    expect(detectFocusedInsertTarget()).toEqual({
      hasFocusedInsertTarget: true,
    });
  });
});
