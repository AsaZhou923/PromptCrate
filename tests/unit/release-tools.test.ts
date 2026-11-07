import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { crc32, inflateRawSync } from "node:zlib";
import { createZip } from "../../scripts/zip.mjs";
import { startDevWatch } from "../../scripts/dev-watch.mjs";
import { repoRoot, resolveBuildDestination } from "../../scripts/build-extension.mjs";

const directories: string[] = [];
const links: string[] = [];

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "promptcrate-release-tools-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const link of links.splice(0)) {
    if (!resolve(link).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test link cleanup path");
    await unlink(link);
  }
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

function unpackZip(archive: Buffer): Map<string, Buffer> {
  expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
  const count = archive.readUInt16LE(archive.length - 12);
  let directory = archive.readUInt32LE(archive.length - 6);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(directory)).toBe(0x02014b50);
    expect(archive.readUInt16LE(directory + 8) & 0x0800).toBe(0x0800);
    expect(archive.readUInt16LE(directory + 10)).toBe(8);
    const nameLength = archive.readUInt16LE(directory + 28);
    const extraLength = archive.readUInt16LE(directory + 30);
    const commentLength = archive.readUInt16LE(directory + 32);
    const name = archive.subarray(directory + 46, directory + 46 + nameLength).toString("utf8");
    const local = archive.readUInt32LE(directory + 42);
    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    expect(archive.readUInt16LE(local + 6)).toBe(archive.readUInt16LE(directory + 8));
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    expect(archive.subarray(local + 30, local + 30 + localNameLength).toString("utf8")).toBe(name);
    const compressedSize = archive.readUInt32LE(directory + 20);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const content = inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize));
    expect(content.length).toBe(archive.readUInt32LE(directory + 24));
    expect(crc32(content)).toBe(archive.readUInt32LE(directory + 16));
    expect(archive.readUInt32LE(local + 14)).toBe(archive.readUInt32LE(directory + 16));
    expect(archive.readUInt32LE(local + 18)).toBe(compressedSize);
    files.set(name, content);
    directory += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe("portable ZIP format", () => {
  it("round-trips nested UTF-8 paths and binary data with standard headers and CRC", () => {
    const archive = createZip([
      { name: "manifest.json", data: Buffer.from('{"manifest_version":3}') },
      { name: "icons/图标.png", data: Buffer.from([0, 255, 7, 0, 128]) },
      { name: "empty.txt", data: Buffer.alloc(0) },
      { name: "checksum.txt", data: Buffer.from("123456789") },
    ]);
    const files = unpackZip(archive);
    expect([...files.keys()]).toEqual(["manifest.json", "icons/图标.png", "empty.txt", "checksum.txt"]);
    expect(files.get("icons/图标.png")).toEqual(Buffer.from([0, 255, 7, 0, 128]));
    expect(files.get("empty.txt")).toHaveLength(0);
    expect(crc32(files.get("checksum.txt")!)).toBe(0xcbf43926);
    expect(createZip([{ name: "same.txt", data: Buffer.from("same") }]))
      .toEqual(createZip([{ name: "same.txt", data: Buffer.from("same") }]));
  });

  it.each(["../escape", "icons\\icon.png", "/absolute", "C:/absolute", "a//b", "./file", "file\0name"])(
    "rejects unsafe archive names: %s", (name) => {
      expect(() => createZip([{ name, data: Buffer.from("content") }])).toThrow("Unsafe ZIP entry");
    },
  );

  it("rejects duplicate entries and archives requiring ZIP64", () => {
    const entry = { name: "duplicate", data: Buffer.alloc(0) };
    expect(() => createZip([entry, entry])).toThrow("Duplicate ZIP entry");
    expect(() => createZip(Array(0x10000).fill(entry))).toThrow("ZIP64");
  });
});

describe("build output safety", () => {
  it.each([repoRoot, dirname(repoRoot), parse(repoRoot).root])("refuses to empty unsafe destination %s", async (outDir) => {
    await expect(resolveBuildDestination(outDir)).rejects.toThrow("Build output must not be");
  });

  it("rejects a parent junction that aliases the repository root in builds and development watch", async () => {
    const directory = await scratch();
    const link = join(directory, "linked-parent");
    await symlink(dirname(repoRoot), link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
    const outDir = join(link, basename(repoRoot));
    await expect(resolveBuildDestination(outDir)).rejects.toThrow("repository root");
    await expect(resolveBuildDestination(join(outDir, "scripts"))).rejects.toThrow("generated");
    const build = vi.fn();
    await expect(startDevWatch({ outDir, build })).rejects.toThrow("repository root");
    expect(build).not.toHaveBeenCalled();
  });

  it.each(["src", "docs", "scripts", ".github"])("refuses source directory %s without invoking a watcher builder", async (name) => {
    const build = vi.fn();
    await expect(startDevWatch({ outDir: join(repoRoot, name), build })).rejects.toThrow("generated");
    expect(build).not.toHaveBeenCalled();
  });

  it("allows generated repository subdirectories without creating them", async () => {
    const actualRepo = await realpath(repoRoot);
    for (const name of ["dist", "output", "release"]) {
      expect(await resolveBuildDestination(join(repoRoot, name, "custom-build")))
        .toBe(join(actualRepo, name, "custom-build"));
    }
  });

  it("rejects direct output links and existing non-directory destinations", async () => {
    const directory = await scratch();
    const actual = join(directory, "actual");
    await mkdir(actual);
    const link = join(directory, "linked-output");
    await symlink(actual, link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
    await expect(resolveBuildDestination(link)).rejects.toThrow("symbolic link or junction");
    const file = join(directory, "not-a-directory");
    await writeFile(file, "Keep this file");
    await expect(resolveBuildDestination(file)).rejects.toThrow("must be a directory");
    await expect(resolveBuildDestination(join(file, "dist"))).rejects.toThrow("must be a directory");
    expect(await readFile(file, "utf8")).toBe("Keep this file");
  });

  it("resolves safe parent aliases and nonexistent output suffixes before starting watchers", async () => {
    const directory = await scratch();
    const actual = join(directory, "actual");
    await mkdir(actual);
    const link = join(directory, "safe-parent");
    await symlink(actual, link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
    const outDir = join(link, "new", "dist");
    const expected = join(await realpath(actual), "new", "dist");
    expect(await resolveBuildDestination(outDir)).toBe(expected);
    const build = vi.fn<(config: import("vite").InlineConfig) => Promise<FakeWatcher>>(async () => {
      const watcher = new FakeWatcher();
      setTimeout(() => watcher.emit("event", { code: "END" }), 0);
      return watcher;
    });
    const watching = await startDevWatch({ outDir, build });
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls.every(([config]) => config.build?.outDir === expected)).toBe(true);
    await watching.close();
  });
});

class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => undefined);
}

describe("portable development watch lifecycle", () => {
  it("initializes builds in order without allowing either to erase shared output", async () => {
    const first = new FakeWatcher();
    const second = new FakeWatcher();
    const build = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const pending = startDevWatch({ build });
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
    expect(build.mock.calls[0][0]).toMatchObject({
      configFile: expect.stringContaining("vite.config.ts"), build: { emptyOutDir: false, watch: {} },
    });
    first.emit("event", { code: "END" });
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(build.mock.calls[1][0]).toMatchObject({
      configFile: expect.stringContaining("vite.content.config.ts"), build: { emptyOutDir: false, watch: {} },
    });
    second.emit("event", { code: "END" });
    const watching = await pending;
    await watching.close();
    await watching.close();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("closes an initialized watcher when the other build fails", async () => {
    const first = new FakeWatcher();
    const build = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("Second build failed"));
    const pending = startDevWatch({ build });
    const rejected = expect(pending).rejects.toThrow("Second build failed");
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
    first.emit("event", { code: "END" });
    await rejected;
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("closes startup watchers after a build error or cancellation", async () => {
    for (const aborted of [false, true]) {
      const first = new FakeWatcher();
      const build = vi.fn().mockResolvedValue(first);
      const controller = new AbortController();
      const pending = startDevWatch({ build, signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow(aborted ? "Development watch stopped" : "Invalid source");
      await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
      if (aborted) controller.abort();
      else first.emit("event", { code: "ERROR", error: new Error("Invalid source") });
      await rejected;
      expect(build).toHaveBeenCalledOnce();
      expect(first.close).toHaveBeenCalledOnce();
    }
  });

  it("keeps watching after rebuild errors and reports them", async () => {
    const watchers: FakeWatcher[] = [];
    const build = vi.fn(async () => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      setTimeout(() => watcher.emit("event", { code: "END" }), 0);
      return watcher;
    });
    const onError = vi.fn();
    const watching = await startDevWatch({ build, onError });
    const failure = new Error("Rebuild failed");
    watchers[0].emit("event", { code: "ERROR", error: failure });
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(watchers[0].close).not.toHaveBeenCalled();
    await watching.close();
  });
});

async function writeFixture(distDir: string) {
  const metadata = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
  await mkdir(join(distDir, "icons"), { recursive: true });
  await writeFile(join(distDir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Fixture", version: metadata.version.split("-")[0], version_name: metadata.version,
    background: { service_worker: "service-worker.js", type: "module" }, options_ui: { page: "options.html" },
    icons: { "16": "icons/icon.png" },
  }));
  await writeFile(join(distDir, "service-worker.js"), 'import "./shared.js";');
  await writeFile(join(distDir, "content-entry.js"), "console.log('content');");
  await writeFile(join(distDir, "options.html"), '<script type="module" src="./options.js"></script>');
  await writeFile(join(distDir, "options.js"), 'import "./shared.js";');
  await writeFile(join(distDir, "shared.js"), "export const ready = true;");
  await writeFile(join(distDir, "icons/icon.png"), Buffer.from([0, 255, 7]));
  await writeFile(join(distDir, "LICENSE"), "MIT fixture license");
  await writeFile(join(distDir, "THIRD_PARTY_NOTICES.txt"), "Fixture third-party notices");
}

describe("release packaging", () => {
  it.each(["", "nested"])("refuses archive output inside build output (%s) before calling the builder", async (nested) => {
    const { packageExtension } = await import("../../scripts/package-release.mjs");
    const root = await scratch();
    const distDir = join(root, "dist");
    const outputDir = join(distDir, nested);
    const metadata = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
    await mkdir(outputDir, { recursive: true });
    const previous = join(outputDir, `promptcrate-${metadata.version}.zip`);
    await writeFile(previous, "previous archive");
    const build = vi.fn(async () => { throw new Error("Would clear output and then fail"); });
    await expect(packageExtension({ distDir, outputDir, build })).rejects.toThrow("outside the build directory");
    expect(build).not.toHaveBeenCalled();
    expect(await readFile(previous, "utf8")).toBe("previous archive");
    expect(await readdir(outputDir)).toHaveLength(1);
  });

  it("detects archive/build overlap through a parent junction before building", async () => {
    const { packageExtension } = await import("../../scripts/package-release.mjs");
    const root = await scratch();
    const distDir = join(root, "dist");
    const actualOutput = join(distDir, "archives");
    await mkdir(actualOutput, { recursive: true });
    const link = join(root, "archive-parent");
    await symlink(distDir, link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
    const metadata = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
    const previous = join(actualOutput, `promptcrate-${metadata.version}.zip`);
    await writeFile(previous, "previous archive");
    const build = vi.fn(async () => { throw new Error("Would clear output and then fail"); });
    await expect(packageExtension({ distDir, outputDir: join(link, "archives"), build }))
      .rejects.toThrow("outside the build directory");
    expect(build).not.toHaveBeenCalled();
    expect(await readFile(previous, "utf8")).toBe("previous archive");
  });

  it("builds fresh and places only validated files at the archive root", async () => {
    const { packageExtension } = await import("../../scripts/package-release.mjs");
    const root = await scratch();
    const distDir = join(root, "dist");
    const outputDir = join(root, "release");
    const build = vi.fn(async ({ outDir }: { outDir: string }) => writeFixture(outDir));
    const archive = await packageExtension({ distDir, outputDir, build });
    expect(build).toHaveBeenCalledExactlyOnceWith({ outDir: distDir });
    const files = unpackZip(await readFile(archive));
    expect([...files.keys()]).toContain("manifest.json");
    expect([...files.keys()]).toContain("content-entry.js");
    expect([...files.keys()]).toContain("icons/icon.png");
    expect([...files.keys()].some((name) => name.startsWith("dist/") || name.includes("\\"))).toBe(false);
    expect(files.get("shared.js")!.toString()).toBe("export const ready = true;");
    expect(await readdir(outputDir)).toEqual([archive.slice(archive.lastIndexOf(sep) + 1)]);
  });

  it.each(["build", "validation"])("preserves the previous archive after %s failure", async (failure) => {
    const { packageExtension } = await import("../../scripts/package-release.mjs");
    const root = await scratch();
    const distDir = join(root, "dist");
    const outputDir = join(root, "release");
    const metadata = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
    await mkdir(outputDir);
    await mkdir(distDir);
    const previous = join(outputDir, `promptcrate-${metadata.version}.zip`);
    await writeFile(previous, "previous archive");
    const build = vi.fn(async () => {
      if (failure === "build") throw new Error("Build failed");
    });
    await expect(packageExtension({ distDir, outputDir, build })).rejects.toThrow();
    expect(await readFile(previous, "utf8")).toBe("previous archive");
    expect(await readdir(outputDir)).toHaveLength(1);
  });
});
