// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { verifyDist } from "../../scripts/verify-dist.mjs";

const owned: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "promptcrate-verify-"));
  owned.push(root);
  await mkdir(join(root, "icons"));
  await mkdir(join(root, "_locales", "en"), { recursive: true });
  await writeFile(join(root, "_locales", "en", "messages.json"), JSON.stringify({ name: { message: "Fixture" } }));
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "__MSG_name__", default_locale: "en", version: "0.1.0", version_name: "0.1.0",
    background: { service_worker: "service-worker.js" }, options_ui: { page: "options.html" },
    icons: { "16": "icons/icon.png" },
  }));
  await writeFile(join(root, "options.html"), '<script type="module" src="/options.js"></script>');
  for (const file of ["service-worker.js", "options.js", "content-entry.js"]) {
    await writeFile(join(root, file), "export {};\n");
  }
  await writeFile(join(root, "icons", "icon.png"), Buffer.from([137, 80, 78, 71]));
  return root;
}

afterEach(async () => {
  const parent = await realpath(tmpdir());
  for (const root of owned.splice(0)) {
    const actual = await realpath(root);
    if (!actual.startsWith(parent + sep) || !actual.includes("promptcrate-verify-")) throw new Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

describe("extension distribution validation", () => {
  it("validates generated references and returns sorted archive-root paths", async () => {
    const files = await verifyDist(await fixture(), { packageVersion: "0.1.0" });
    expect(files).toEqual(["_locales/en/messages.json", "content-entry.js", "icons/icon.png", "manifest.json", "options.html", "options.js", "service-worker.js"]);
    expect(files.every((file) => !file.includes("\\") && !file.startsWith("/"))).toBe(true);
  });

  it("rejects version drift and the old all-zero Chrome version", async () => {
    const root = await fixture();
    await expect(verifyDist(root, { packageVersion: "0.2.0" })).rejects.toThrow("does not match");
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.version = "0.0.0";
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyDist(root)).rejects.toThrow("Invalid Chrome manifest version");
  });

  it.each(["content-entry.js", "service-worker.js", "options.html", "icons/icon.png"])(
    "rejects a missing shipped dependency: %s", async (file) => {
      const root = await fixture();
      await rm(join(root, file));
      await expect(verifyDist(root)).rejects.toThrow("Missing extension file");
    },
  );

  it.each(['import "./missing.js";', 'import { x } from "./missing.js";', 'export { x } from "./missing.js";', 'import("./missing.js");'])(
    "checks generated module chunk references: %s", async (code) => {
      const root = await fixture();
      await writeFile(join(root, "service-worker.js"), code);
      await expect(verifyDist(root)).rejects.toThrow("missing.js");
    },
  );

  it("checks linked styles and their resources", async () => {
    const root = await fixture();
    await writeFile(join(root, "options.html"), '<link rel="stylesheet" href="theme.css">');
    await writeFile(join(root, "theme.css"), 'body{background:url("icons/missing.png")}');
    await expect(verifyDist(root)).rejects.toThrow("icons/missing.png");
  });

  it.each(["../outside.png", "icons\\icon.png", "https://example.test/icon.png", "%2e%2e/outside.png"])(
    "rejects unsafe or nonlocal references: %s", async (reference) => {
      const root = await fixture();
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      manifest.icons["16"] = reference;
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(verifyDist(root)).rejects.toThrow(/Unsafe|Invalid local/);
    },
  );

  it("requires license notices for release validation", async () => {
    const root = await fixture();
    await expect(verifyDist(root, { requireNotices: true })).rejects.toThrow("LICENSE");
    await writeFile(join(root, "LICENSE"), "MIT License");
    await writeFile(join(root, "THIRD_PARTY_NOTICES.txt"), "Runtime license notices");
    await expect(verifyDist(root, { requireNotices: true })).resolves.toContain("LICENSE");
  });

  it("rejects a directory link instead of packaging files outside the output", async () => {
    const root = await fixture();
    const other = await fixture();
    await symlink(resolve(other), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(verifyDist(root)).rejects.toThrow("symbolic links");
  });

  it.each([undefined, null, "../en", "en/../../outside", "en\\US", "en%2fUS", ""]) (
    "rejects missing or unsafe default locale: %j", async (locale) => {
      const root = await fixture();
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      manifest.default_locale = locale;
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(verifyDist(root)).rejects.toThrow("default_locale");
    },
  );

  it("requires the default locale catalog", async () => {
    const root = await fixture();
    await rm(join(root, "_locales", "en", "messages.json"));
    await expect(verifyDist(root)).rejects.toThrow("_locales/en/messages.json");
  });

  it("resolves manifest messages recursively with Chrome's case insensitive keys", async () => {
    const root = await fixture();
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.name = "__MSG_NAME__";
    manifest.commands = { open: { description: "__MSG_NAME__ __MSG_nAmE__" } };
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyDist(root)).resolves.toContain("_locales/en/messages.json");
    manifest.commands.open.description = "__MSG_missing_command__";
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyDist(root)).rejects.toThrow("Missing default locale message: missing_command");
  });

  it.each([
    [], null, { name: "Fixture" }, { name: {} }, { name: { message: 123 } },
    { name: { message: "Fixture", description: [] } },
    { name: { message: "One" }, NAME: { message: "Two" } },
    { name: { message: "$VALUE$" } },
    { name: { message: "$VALUE$", placeholders: {} } },
    { name: { message: "$VALUE$", placeholders: { value: { content: 1 } } } },
    { name: { message: "$VALUE$", placeholders: { value: { content: "$1", example: 123 } } } },
    { name: { message: "$VALUE$", placeholders: { value: { content: "$1" }, VALUE: { content: "$2" } } } },
  ])("rejects malformed message catalogs: %j", async (catalog) => {
    const root = await fixture();
    await writeFile(join(root, "_locales", "en", "messages.json"), JSON.stringify(catalog));
    await expect(verifyDist(root)).rejects.toThrow(/Invalid locale|Missing locale/);
  });

  it("accepts named placeholder metadata and validates additional shipped catalogs", async () => {
    const root = await fixture();
    await writeFile(join(root, "_locales", "en", "messages.json"), JSON.stringify({
      name: { message: "Fixture $VALUE$", description: "App name", placeholders: { value: { content: "$1", example: "One" } } },
    }));
    await expect(verifyDist(root)).resolves.toContain("_locales/en/messages.json");
    await mkdir(join(root, "_locales", "zh_CN"));
    await writeFile(join(root, "_locales", "zh_CN", "messages.json"), JSON.stringify({ name: { message: false } }));
    await expect(verifyDist(root)).rejects.toThrow("Invalid locale message: _locales/zh_CN/messages.json");
  });
});
