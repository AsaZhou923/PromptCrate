/**
 * Convert the package's SemVer into Chrome's numeric update version and display name.
 * @param {string} packageVersion
 * @returns {{ version: string; version_name: string }}
 */
export function createVersionFields(packageVersion) {
  if (typeof packageVersion !== "string") {
    throw new Error("Package version must be a SemVer string.");
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(packageVersion);
  if (!match || match[0] !== packageVersion || !validIdentifiers(match[4], true) || !validIdentifiers(match[5], false)) {
    throw new Error(`Invalid package SemVer: ${packageVersion}`);
  }
  const components = match.slice(1, 4).map(Number);
  if (components.some((component) => component > 65535) || components.every((component) => component === 0)) {
    throw new Error(`Package version cannot be represented as a Chrome extension version: ${packageVersion}`);
  }
  return { version: components.join("."), version_name: packageVersion };
}

/** @param {string | undefined} value @param {boolean} rejectLeadingZeroNumbers */
function validIdentifiers(value, rejectLeadingZeroNumbers) {
  return value === undefined || value.split(".").every((identifier) =>
    /^[0-9A-Za-z-]+$/.test(identifier) &&
    !(rejectLeadingZeroNumbers && /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")));
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} template
 * @param {string} packageVersion
 * @returns {Omit<T, "version" | "version_name"> & { version: string; version_name: string }}
 */
export function createExtensionManifest(template, packageVersion) {
  return { ...template, ...createVersionFields(packageVersion) };
}
import { readFileSync } from "node:fs";


/**
 * @param {{ manifestPath: string; packagePath: string }} paths
 * @returns {import("vite").Plugin}
 */
export function createManifestPlugin({ manifestPath, packagePath }) {
  return {
    name: "promptcrate-manifest",
    buildStart() {
      this.addWatchFile(manifestPath);
      this.addWatchFile(packagePath);
    },
    generateBundle() {
      // Read on every build so watch mode never emits cached version metadata.
      const template = JSON.parse(readFileSync(manifestPath, "utf8"));
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(createExtensionManifest(template, packageJson.version), null, 2)}\n`,
      });
    },
  };
}
