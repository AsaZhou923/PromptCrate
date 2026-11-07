// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { build } from "vite";
import { createManifestPlugin } from "../../scripts/manifest-version.mjs";

describe("generated manifest watch updates", () => {
  it("regenerates version and template fields in a custom output directory", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "promptcrate-manifest-"));
    const packagePath = join(fixture, "metadata.json");
    const manifestPath = join(fixture, "manifest-template.json");
    const entry = join(fixture, "entry.js");
    const outDir = join(fixture, "built");
    let watcher: { close(): Promise<void> } | undefined;
    try {
      await writeFile(packagePath, JSON.stringify({ version: "1.2.3" }));
      await writeFile(manifestPath, JSON.stringify({ manifest_version: 3, name: "Initial" }));
      await writeFile(entry, 'console.log("fixture");');
      const result = await build({
        configFile: false,
        root: fixture,
        logLevel: "silent",
        plugins: [createManifestPlugin({ manifestPath, packagePath })],
        build: { watch: {}, outDir, rollupOptions: { input: entry } },
      });
      if (!("close" in result)) throw new Error("Vite did not return a watcher.");
      watcher = result;
      const emitted = async () => JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
      await vi.waitFor(async () => expect(await emitted()).toMatchObject({
        version: "1.2.3", version_name: "1.2.3", name: "Initial",
      }));
      await writeFile(packagePath, JSON.stringify({ version: "1.2.4-rc.1+build.7" }));
      await vi.waitFor(async () => expect(await emitted()).toMatchObject({
        version: "1.2.4", version_name: "1.2.4-rc.1+build.7",
      }));
      await writeFile(manifestPath, JSON.stringify({ manifest_version: 3, name: "Updated" }));
      await vi.waitFor(async () => expect(await emitted()).toMatchObject({
        name: "Updated", version: "1.2.4",
      }));
    } finally {
      await watcher?.close();
      await removeFixture(fixture);
    }
  });
});

async function removeFixture(fixture: string) {
  const actual = await realpath(fixture);
  const parent = await realpath(tmpdir());
  if (dirname(actual) !== parent || basename(actual) !== basename(fixture)) {
    throw new Error("Unexpected fixture cleanup path.");
  }
  await rm(actual, { recursive: true, force: true });
}
