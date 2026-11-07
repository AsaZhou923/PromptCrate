import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createVersionFields } from "./manifest-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Check the extension and return the regular archive entries, relative to its root.
 * @param {string} directory
 * @param {{packageVersion?: string, requireNotices?: boolean}} [options]
 * @returns {Promise<string[]>}
 */
export async function verifyDist(directory, { packageVersion, requireNotices = false } = {}) {
  const root = resolve(directory);
  /** @type {string[]} */
  const files = [];
  /** @param {string} relative */
  const walk = async (relative) => {
    const location = resolve(root, ...relative.split("/"));
    const info = await lstat(location);
    if (info.isSymbolicLink()) throw new Error(`Release paths must not be symbolic links: ${relative || "."}`);
    if (info.isDirectory()) {
      const entries = await readdir(location, { withFileTypes: true });
      for (const entry of entries) await walk(relative ? `${relative}/${entry.name}` : entry.name);
    } else if (info.isFile()) {
      assertSafePath(relative);
      files.push(relative);
    } else {
      throw new Error(`Unsupported release file: ${relative}`);
    }
  };
  await walk("");
  files.sort();
  const available = new Set(files);
  /** @param {string} name */
  const requireFile = (name) => {
    assertSafePath(name);
    if (!available.has(name)) throw new Error(`Missing extension file: ${name}`);
  };
  requireFile("manifest.json");
  requireFile("content-entry.js");
  if (requireNotices) {
    requireFile("LICENSE");
    requireFile("THIRD_PARTY_NOTICES.txt");
  }
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3) throw new Error("Expected a Manifest V3 extension.");
  if (typeof manifest.version !== "string" || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(manifest.version) ||
    manifest.version.split(".").some((part) => Number(part) > 65535) ||
    manifest.version.split(".").every((part) => Number(part) === 0)) {
    throw new Error("Invalid Chrome manifest version.");
  }
  if (packageVersion !== undefined) {
    const expected = createVersionFields(packageVersion);
    if (manifest.version !== expected.version || manifest.version_name !== expected.version_name) {
      throw new Error("Built manifest version does not match package.json.");
    }
  }
  /** @param {unknown} value @param {string} [from] */
  const reference = (value, from = "") => {
    if (typeof value !== "string" || !value) throw new Error("Invalid extension file reference.");
    const raw = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    if (!raw || raw.includes("\\") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(raw) || raw.startsWith("//")) {
      throw new Error(`Invalid local extension reference: ${value}`);
    }
    const name = posix.normalize(raw.startsWith("/") ? raw.slice(1) : posix.join(posix.dirname(from), raw));
    requireFile(name);
  };
  /** @param {unknown} value */
  const icons = (value) => {
    if (value === undefined) return;
    if (typeof value === "string") reference(value);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach((entry) => reference(entry));
    else throw new Error("Invalid icon references.");
  };
  reference(manifest.background?.service_worker);
  reference(manifest.options_ui?.page ?? manifest.options_page);
  icons(manifest.icons);
  icons(manifest.action?.default_icon);
  if (manifest.action?.default_popup !== undefined) reference(manifest.action.default_popup);
  if (manifest.side_panel?.default_path !== undefined) reference(manifest.side_panel.default_path);
  for (const item of manifest.content_scripts ?? []) {
    for (const file of [...(item.js ?? []), ...(item.css ?? [])]) reference(file);
  }
  for (const file of Object.values(manifest.chrome_url_overrides ?? {})) reference(file);
  for (const name of files) {
    if (name.endsWith(".html")) {
      const html = await readFile(resolve(root, ...name.split("/")), "utf8");
      for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        reference(match[1], name);
      }
    } else if (name.endsWith(".js") || name.endsWith(".mjs")) {
      const code = await readFile(resolve(root, ...name.split("/")), "utf8");
      // Vite emits literal relative imports for shared chunks; bare runtime modules are bundled.
      const patterns = [
        /\b(?:import|export)\s*(?:\{[^}]*\}|\*\s*(?:as\s+\w+)?|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s*from\s*["']([^"']+)["']/g,
        /\bimport\s*["']([^"']+)["']/g,
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      ];
      for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) {
          if (match[1].startsWith(".") || match[1].startsWith("/")) reference(match[1], name);
        }
      }
    } else if (name.endsWith(".css")) {
      const css = await readFile(resolve(root, ...name.split("/")), "utf8");
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        if (!match[1].startsWith("data:")) reference(match[1].trim(), name);
      }
    }
  }
  return files;
}

/** @param {string} name */
function assertSafePath(name) {
  if (!name || name.includes("\\") || name.includes(":") || [...name].some((character) => character.charCodeAt(0) < 32) ||
    name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe extension path: ${name}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { "dist-dir": { type: "string" } } });
    const metadata = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
    const files = await verifyDist(values["dist-dir"] ?? resolve(repoRoot, "dist"), {
      packageVersion: metadata.version, requireNotices: true,
    });
    console.log(`Verified ${files.length} extension files for ${metadata.version}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
