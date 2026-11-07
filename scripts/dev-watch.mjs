import { build } from "vite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { repoRoot, resolveBuildDestination } from "./build-extension.mjs";

/** @typedef {{on: (name: string, listener: (event: {code: string, error?: unknown, result?: {close?: () => unknown}}) => void) => unknown, close: () => unknown}} DevWatcher */

/**
 * @param {{outDir?: string, build?: (config: import('vite').InlineConfig) => Promise<unknown>, signal?: AbortSignal, onError?: (error: unknown) => void}} [options]
 */
export async function startDevWatch({
  outDir = resolve(repoRoot, "dist"), build: buildFn = build, signal, onError = console.error,
} = {}) {
  const destination = await resolveBuildDestination(outDir);
  /** @type {DevWatcher[]} */
  const watchers = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled(watchers.map((watcher) => Promise.resolve().then(() => watcher.close())));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };

  const start = async (configFile) => {
    if (signal?.aborted) throw new Error("Development watch stopped.");
    const result = await buildFn({
      root: repoRoot,
      configFile: resolve(repoRoot, configFile),
      // Both builds share dist: neither watcher may clear the other build's files.
      build: { outDir: destination, emptyOutDir: false, watch: {} },
    });
    if (!result || typeof result !== "object" || !("on" in result) || typeof result.on !== "function" ||
      !("close" in result) || typeof result.close !== "function") {
      throw new Error("Vite did not create a build watcher.");
    }
    const watcher = /** @type {DevWatcher} */ (result);
    watchers.push(watcher);
    await new Promise((resolveReady, reject) => {
      let ready = false;
      const onAbort = () => reject(new Error("Development watch stopped."));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      watcher.on("event", (event) => {
        if (event.code === "BUNDLE_END" && event.result?.close) {
          void Promise.resolve().then(() => event.result.close()).catch(onError);
        }
        if (event.code === "ERROR") {
          if (ready) onError(event.error);
          else {
            signal?.removeEventListener("abort", onAbort);
            reject(event.error);
          }
        } else if (event.code === "END" && !ready) {
          ready = true;
          signal?.removeEventListener("abort", onAbort);
          resolveReady(undefined);
        }
      });
    });
  };

  try {
    await start("vite.config.ts");
    await start("vite.content.config.ts");
    return { close };
  } catch (error) {
    await close().catch(onError);
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let watching;
  try {
    const { values } = parseArgs({ options: { once: { type: "boolean", default: false } } });
    watching = await startDevWatch({ signal: controller.signal });
    if (values.once) {
      console.log("Both development watch builds completed.");
    } else {
      console.log("Watching extension and content outputs. Press Ctrl+C to stop.");
      if (!controller.signal.aborted) {
        await new Promise((resolveStopped) => controller.signal.addEventListener("abort", resolveStopped, { once: true }));
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error);
      process.exitCode = 1;
    }
  } finally {
    await watching?.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
