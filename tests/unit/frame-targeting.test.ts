import { describe, expect, it } from "vitest";
import {
  detectFocusedInsertTarget,
  selectPromptMenuFrameIds,
} from "../../src/background/frame-targeting";

describe("prompt menu frame targeting", () => {
  it("targets frames with a focused insert field", () => {
    expect(
      selectPromptMenuFrameIds([
        { frameId: 0, result: { hasFocusedInsertTarget: false } },
        { frameId: 12, result: { hasFocusedInsertTarget: true } },
      ]),
    ).toEqual([12]);
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
