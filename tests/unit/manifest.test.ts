import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import packageJson from "../../package.json";
import { createExtensionManifest, createVersionFields } from "../../scripts/manifest-version.mjs";

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
  it("generates its version from package.json rather than maintaining a second source", () => {
    expect(manifest).not.toHaveProperty("version");
    expect(manifest).not.toHaveProperty("version_name");
    const generated = createExtensionManifest(manifest, packageJson.version);
    expect(generated).toMatchObject(createVersionFields(packageJson.version));
    expect(generated.version_name).toBe(packageJson.version);
    expect(generated.permissions).toEqual(manifest.permissions);
  });

  it.each([
    ["0.1.0", "0.1.0"],
    ["1.2.3-alpha.4+build.005", "1.2.3"],
    ["65535.65535.65535", "65535.65535.65535"],
  ])("maps SemVer %s to numeric version %s", (version, numeric) => {
    expect(createVersionFields(version)).toEqual({ version: numeric, version_name: version });
  });

  it.each([
    "0.0.0", "0.0.0-phase10", "65536.0.0", "1.65536.0", "1.0.65536",
    "01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3.4", "v1.2.3", " 1.2.3",
    "1.2.3\n", "1.2.3\r\n", "1.2.3\t",
    "1.2.3-01", "1.2.3-alpha..1", "1.2.3+build..1", "1.2.3-", "1.2.3+",
  ])("rejects invalid or Chrome-incompatible package version %s", (version) => {
    expect(() => createVersionFields(version)).toThrow();
  });

  it("replaces stale template metadata without mutating the source", () => {
    const source = { ...manifest, version: "9.9.9", version_name: "stale" };
    expect(createExtensionManifest(source, "1.2.3-rc.1")).toMatchObject({
      version: "1.2.3", version_name: "1.2.3-rc.1",
    });
    expect(source.version).toBe("9.9.9");
    expect(source.version_name).toBe("stale");
  });

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

  it("keeps permissions limited to the documented local-first surface", () => {
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest).not.toHaveProperty("host_permissions");
  });
});
