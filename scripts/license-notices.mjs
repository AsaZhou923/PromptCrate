import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

/** @param {string} root @returns {import("vite").Plugin} */
export function createLicensePlugin(root) {
  const require = createRequire(resolve(root, "package.json"));
  const react = require.resolve("react/package.json");
  const reactDOM = require.resolve("react-dom/package.json");
  const scheduler = createRequire(reactDOM).resolve("scheduler/package.json");
  const licenses = [
    { name: "React", packagePath: react },
    { name: "ReactDOM", packagePath: reactDOM },
    { name: "Scheduler", packagePath: scheduler },
  ];
  const projectLicense = resolve(root, "LICENSE");
  return {
    name: "promptcrate-license-notices",
    buildStart() {
      this.addWatchFile(projectLicense);
      for (const entry of licenses) this.addWatchFile(resolve(dirname(entry.packagePath), "LICENSE"));
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "LICENSE", source: readFileSync(projectLicense, "utf8") });
      const notices = licenses.map((entry) => {
        const metadata = JSON.parse(readFileSync(entry.packagePath, "utf8"));
        const license = readFileSync(resolve(dirname(entry.packagePath), "LICENSE"), "utf8");
        return `${entry.name} ${metadata.version}\n${"=".repeat(40)}\n${license.trim()}\n`;
      }).join("\n");
      this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.txt", source: notices });
    },
  };
}
