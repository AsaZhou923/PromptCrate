import { build } from "vite";
import { basename, dirname, parse, resolve, sep } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve an existing directory or its nearest existing physical ancestor without writing.
 * @param {string} directory
 */
export async function resolveOutputDirectory(directory) {
  const requested = resolve(directory);
  let ancestor = requested;
  const suffix = [];
  while (true) {
    const existing = await lstat(ancestor).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (existing) {
      if (ancestor === requested && existing.isSymbolicLink()) {
        throw new Error("Output directory must not be a symbolic link or junction.");
      }
      const actualAncestor = await realpath(ancestor);
      if (!(await stat(actualAncestor)).isDirectory()) throw new Error("Output path must be a directory.");
      return resolve(actualAncestor, ...suffix);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Output directory has no existing filesystem ancestor.");
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
}

/** @param {string} candidate @param {string} directory */
export function isWithinDirectory(candidate, directory) {
  const compare = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const child = compare(resolve(candidate));
  const parent = compare(resolve(directory));
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Resolve parent aliases before allowing Vite to write or empty a generated directory.
 * @param {string} outDir
 */
export async function resolveBuildDestination(outDir) {
  const destination = await resolveOutputDirectory(outDir);
  const actualRepo = await realpath(repoRoot);
  if (destination === parse(destination).root || isWithinDirectory(actualRepo, destination)) {
    throw new Error("Build output must not be a filesystem root, repository root, or its ancestor.");
  }
  if (isWithinDirectory(destination, actualRepo) &&
    !["dist", "output", "release"].some((name) => isWithinDirectory(destination, resolve(actualRepo, name)))) {
    throw new Error("Build output inside the repository must stay within generated dist, output, or release directories.");
  }
  return destination;
}

/** @param {{outDir?: string}} [options] */
export async function buildExtension({ outDir = resolve(repoRoot, "dist") } = {}) {
  const destination = await resolveBuildDestination(outDir);
  await build({
    root: repoRoot,
    configFile: resolve(repoRoot, "vite.config.ts"),
    build: { outDir: destination },
  });
  await build({
    root: repoRoot,
    configFile: resolve(repoRoot, "vite.content.config.ts"),
    build: { outDir: destination },
  });
  return destination;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
    await buildExtension({ outDir: values["out-dir"] });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
