import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";

const RESERVED_SHORTCUTS = new Set([
  "Alt+Shift+P",
  "Option+Shift+P",
  "Ctrl+P",
  "Ctrl+Shift+P",
  "Ctrl+Shift+Y",
  "Command+P",
  "Command+Shift+P",
  "Command+Shift+Y",
]);

describe("extension manifest", () => {
  it("uses a prompt menu shortcut that avoids known browser conflicts", () => {
    const suggestedKey =
      manifest.commands["open-prompt-menu"].suggested_key;

    expect(suggestedKey.default).toBe("Ctrl+Shift+2");
    expect(suggestedKey.mac).toBe("Command+Shift+2");
    expect(Object.values(suggestedKey)).not.toContainEqual(
      expect.stringMatching(/^(Alt|Option)\+Shift\+P$/),
    );

    for (const shortcut of Object.values(suggestedKey)) {
      expect(RESERVED_SHORTCUTS.has(shortcut)).toBe(false);
    }
  });
});
