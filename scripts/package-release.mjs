import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { buildExtension, isWithinDirectory, repoRoot, resolveBuildDestination, resolveOutputDirectory } from "./build-extension.mjs";
import { verifyDist } from "./verify-dist.mjs";
import { createZip } from "./zip.mjs";

/**
 * @param {{distDir?: string, outputDir?: string, build?: (options: {outDir: string}) => Promise<unknown>}} [options]
 */
export async function packageExtension({
  distDir = resolve(repoRoot, "dist"),
  outputDir = resolve(repoRoot, "release"),
  build = buildExtension,
} = {}) {
  const destination = await resolveBuildDestination(distDir);
  const output = await resolveOutputDirectory(outputDir);
  if (isWithinDirectory(output, destination)) {
    throw new Error("Archive output must be outside the build directory.");
  }
  const metadata = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
  if (typeof metadata.version !== "string" || !/^[0-9A-Za-z.+-]+$/u.test(metadata.version)) {
    throw new Error("Invalid package version for release filename.");
  }
  await build({ outDir: destination });
  const names = await verifyDist(destination, { packageVersion: metadata.version, requireNotices: true });
  const entries = [];
  for (const name of names) {
    const file = resolve(destination, ...name.split("/"));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular release file: ${name}`);
    entries.push({ name, data: await readFile(file) });
  }
  const archive = createZip(entries);
  await mkdir(output, { recursive: true });
  const archivePath = resolve(output, `promptcrate-${metadata.version}.zip`);
  const temporaryPath = resolve(output, `.promptcrate-${randomUUID()}.zip.tmp`);
  try {
    await writeFile(temporaryPath, archive, { flag: "wx" });
    await rename(temporaryPath, archivePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return archivePath;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      "dist-dir": { type: "string" }, "output-dir": { type: "string" },
    } });
    console.log(`Created ${await packageExtension({ distDir: values["dist-dir"], outputDir: values["output-dir"] })}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
