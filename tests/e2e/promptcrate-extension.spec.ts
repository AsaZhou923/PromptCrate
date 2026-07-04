import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";

type PromptTemplateRecord = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

type TemplateExportPayloadRecord = {
  schemaVersion: number;
  exportedAt: string;
  templates: PromptTemplateRecord[];
};

type ManifestRecord = {
  permissions?: string[];
  host_permissions?: string[];
};

type BrowserScope = Page | Frame;

const repoRoot = process.cwd();
const distDir = path.join(repoRoot, "dist");
const extensionHostId = "promptcrate-menu-host";
let staticServer: { server: Server; baseURL: string };
let shortcutOpensMenu: boolean | null = process.env.PROMPTCRATE_E2E_USE_SHORTCUT === "1"
  ? null
  : false;
let lastOpenPromptDiagnostics = "";

test.beforeAll(async () => {
  staticServer = await startStaticServer(repoRoot);
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    staticServer.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

test("inserts templates into fixture textarea, input, contenteditable, Shadow DOM, and iframe targets", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-fixture"));

  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await expectRegisteredShortcut(options);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await installEventCounters(page);

    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        active.blur();
      }
    });
    await openPromptMenu(page, page, app);
    await expectMenuText(page).toContain("Focus a text field before opening PromptCrate.");
    await clickMenuButton(page, "Close");
    await waitForMenuClosed(page);

    await page.locator("#textarea").evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = "Before ";
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Rewrite clearer", { text: "Playwright variable" });
    await expect(page.locator("#textarea")).toHaveValue(
      "Before Rewrite the following text so it is clearer, shorter, and keeps the original meaning:\n\nPlaywright variable",
    );
    await expect.poll(() => readEventCount(page, "textarea")).toBeGreaterThan(0);

    await page.locator("#text-input").evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "Keep REPLACE";
      input.focus();
      input.setSelectionRange(5, input.value.length);
    });
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect(page.locator("#text-input")).toHaveValue(
      "Keep Summarize the key ideas from this page in concise bullets.",
    );
    await expect.poll(() => readEventCount(page, "textInput")).toBeGreaterThan(0);

    await page.locator("#editable").evaluate((element) => {
      const editable = element as HTMLElement;
      editable.textContent = "Editable:";
      editable.focus();
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect(page.locator("#editable")).toContainText(
      "Editable:Summarize the key ideas from this page in concise bullets.",
    );
    await expect.poll(() => readEventCount(page, "editable")).toBeGreaterThan(0);

    await page.evaluate(() => {
      const shadowInput = document
        .getElementById("shadow-host")
        ?.shadowRoot?.querySelector<HTMLInputElement>("#shadow-input");

      if (!shadowInput) {
        throw new Error("Shadow input not found.");
      }

      shadowInput.value = "Shadow ";
      shadowInput.focus();
      shadowInput.setSelectionRange(shadowInput.value.length, shadowInput.value.length);
    });
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect
      .poll(() =>
        page.evaluate(() => {
          return document
            .getElementById("shadow-host")
            ?.shadowRoot?.querySelector<HTMLInputElement>("#shadow-input")
            ?.value;
        }),
      )
      .toBe("Shadow Summarize the key ideas from this page in concise bullets.");
    await expect.poll(() => readEventCount(page, "shadowInput")).toBeGreaterThan(0);

    const iframe = await getFixtureIframe(page);
    await iframe.locator("#iframe-textarea").evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = "Frame ";
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    await openPromptMenu(page, iframe, app);
    await insertTemplateFromMenu(iframe, "Summarize page");
    await expect(iframe.locator("#iframe-textarea")).toHaveValue(
      "Frame Summarize the key ideas from this page in concise bullets.",
    );

    await page.locator("#text-input").focus();
    await openPromptMenu(page, page, app);
    await page.mouse.click(12, 12);
    await waitForMenuClosed(page);

    const screenshotPath = testInfo.outputPath("fixture-final.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach("fixture-final", {
      path: screenshotPath,
      contentType: "image/png",
    });
  } finally {
    await app.context.close();
  }
});

test("manages templates through Options CRUD, import, export, and persistence", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-options"));

  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await expectRegisteredShortcut(options);
    await expect(options.locator(".status")).toContainText("7 templates loaded.");

    await options.getByRole("button", { name: "New" }).click();
    await options.getByLabel("ID").fill("empty-check");
    await options.getByRole("button", { name: "Save" }).click();
    await expect(options.locator(".status")).toContainText("Title is required.");
    await expect(options.locator(".status")).toContainText("Body is required.");
    await expect.poll(() => readTemplates(options).then((items) => items.length)).toBe(7);

    await options.getByLabel("ID").fill("e2e-insert-template");
    await options.getByLabel("Title").fill("E2E Insert Template");
    await options.getByLabel("Tags").fill("e2e, playwright");
    await options.getByLabel("Body").fill("E2E body for {{name}}");
    await options.getByRole("button", { name: "Save" }).click();
    await expect(options.locator(".status")).toContainText('Saved "E2E Insert Template".');
    await expect.poll(() => readTemplates(options).then((items) => items.length)).toBe(8);

    await options.getByRole("button", { name: "Favorite" }).click();
    await expect(options.locator(".status")).toContainText("Favorite updated.");
    await expect(options.locator(".template-row").first()).toContainText("* E2E Insert Template");

    await options.getByLabel("Body").fill("E2E edited body for {{name}}");
    await options.getByRole("button", { name: "Save" }).click();
    await expect(options.locator(".status")).toContainText('Saved "E2E Insert Template".');

    await options.getByRole("button", { name: "Copy" }).click();
    await expect(options.locator(".status")).toContainText('Copied "E2E Insert Template".');
    await expect(options.getByLabel("ID")).toHaveValue("e2e-insert-template-copy");

    options.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await options.getByRole("button", { name: "Delete" }).click();
    await expect(options.locator(".status")).toContainText('Deleted "E2E Insert Template copy".');
    await expect.poll(() => readTemplates(options).then((items) => items.length)).toBe(8);

    const [download] = await Promise.all([
      options.waitForEvent("download"),
      options.getByRole("button", { name: "Export JSON" }).click(),
    ]);
    const exportedPath = testInfo.outputPath("promptcrate-export.json");
    await download.saveAs(exportedPath);
    const exportedPayload = JSON.parse(
      await fs.readFile(exportedPath, "utf8"),
    ) as TemplateExportPayloadRecord;
    expect(exportedPayload.schemaVersion).toBe(1);
    expect(typeof exportedPayload.exportedAt).toBe("string");
    expect(exportedPayload.templates.some((template) => template.id === "e2e-insert-template")).toBe(true);

    const invalidPath = testInfo.outputPath("invalid-import.json");
    await fs.writeFile(invalidPath, "{ invalid json", "utf8");
    await options.locator('input[type="file"]').setInputFiles(invalidPath);
    await expect(options.locator(".status")).toContainText("The selected file is not valid JSON.");
    await expect.poll(() => readTemplates(options).then((items) => items.length)).toBe(8);

    const mergePath = testInfo.outputPath("merge-import.json");
    await writeImportFile(mergePath, [
      createTemplate("e2e-merged-template", "E2E Merged Template", "Merged {{value}}", [
        "e2e",
        "import",
      ]),
    ]);
    await options.locator('input[type="file"]').setInputFiles(mergePath);
    await expect(options.locator(".status")).toContainText("1 templates ready to import.");
    await options.getByRole("button", { name: "Merge" }).click();
    await expect(options.locator(".status")).toContainText("Imported 1 new and 0 updated templates.");
    await expect.poll(() => readTemplates(options).then((items) => items.length)).toBe(9);

    const fixturePage = await app.context.newPage();
    await fixturePage.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await primePromptCrateContentScript(fixturePage, app);
    const fixtureTextarea = fixturePage.locator("#textarea");
    await fixturePage.bringToFront();
    await fixtureTextarea.fill("");
    await focusEditableAtEnd(fixtureTextarea);
    await expect(fixtureTextarea).toHaveAttribute(
      "data-promptcrate-e2e-focus-target",
      "true",
    );
    await openPromptMenu(fixturePage, fixturePage, app);
    await insertTemplateFromMenu(fixturePage, "E2E Insert Template", { name: "Options sync" });
    await expect(fixturePage.locator("#textarea")).toHaveValue("E2E edited body for Options sync");
    await fixturePage.close();

    const overwritePath = testInfo.outputPath("overwrite-import.json");
    await writeImportFile(overwritePath, [
      createTemplate("e2e-overwrite-only", "E2E Overwrite Only", "Overwrite body", [
        "e2e",
      ]),
    ]);
    await options.locator('input[type="file"]').setInputFiles(overwritePath);
    await expect(options.locator(".status")).toContainText("1 templates ready to import.");
    options.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await options.getByRole("button", { name: "Overwrite" }).click();
    await expect(options.locator(".status")).toContainText("Imported 1 templates by overwrite.");
    await expect.poll(() => readTemplates(options).then((items) => items.length)).toBe(1);

    await options.reload();
    await expect(options.locator(".status")).toContainText("1 templates loaded.");
    await expect(options.getByRole("button", { name: /E2E Overwrite Only/ })).toBeVisible();
  } finally {
    await app.context.close();
  }
});

test("real web smoke covers at least three public input surfaces @real", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-real-web"));
  const results: Array<{ site: string; ok: boolean; detail: string }> = [];

  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await expectRegisteredShortcut(options);

    for (const scenario of realWebScenarios) {
      const page = await app.context.newPage();

      try {
        await page.goto(scenario.url, { waitUntil: "domcontentloaded" });
        await primePromptCrateContentScript(page, app);
        const target = await firstVisible(page, scenario.selectors);
        await scenario.prepare(target);
        await page.bringToFront();
        await focusEditableAtEnd(target);
        await openPromptMenu(page, page, app);
        await insertTemplateFromMenu(page, "Summarize page");
        const value = await readEditableValue(target);
        expect(value).toContain("Summarize the key ideas from this page in concise bullets.");
        results.push({ site: scenario.name, ok: true, detail: value.slice(0, 120) });
      } catch (error) {
        results.push({
          site: scenario.name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await page.close();
      }
    }

    const realWebResultsPath = testInfo.outputPath("real-web-smoke-results.json");
    await fs.writeFile(realWebResultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    await testInfo.attach("real-web-smoke-results", {
      path: realWebResultsPath,
      contentType: "application/json",
    });

    expect(results.filter((result) => result.ok).length, JSON.stringify(results, null, 2)).toBeGreaterThanOrEqual(3);
  } finally {
    await app.context.close();
  }
});

const realWebScenarios: Array<{
  name: string;
  url: string;
  selectors: string[];
  prepare: (target: Locator) => Promise<void>;
}> = [
  {
    name: "httpbin textarea",
    url: "https://httpbin.org/forms/post",
    selectors: ['textarea[name="comments"]', "textarea"],
    prepare: async (target) => {
      await target.fill("Smoke ");
    },
  },
  {
    name: "Wikipedia search",
    url: "https://www.wikipedia.org/",
    selectors: ['input[name="search"]', 'input[type="search"]'],
    prepare: async (target) => {
      await target.fill("Smoke ");
    },
  },
  {
    name: "DuckDuckGo search",
    url: "https://duckduckgo.com/",
    selectors: ['input[name="q"]', 'textarea[name="q"]'],
    prepare: async (target) => {
      await target.fill("Smoke ");
    },
  },
  {
    name: "Perplexity textbox",
    url: "https://www.perplexity.ai/",
    selectors: ['textarea', '[contenteditable="true"]', '[role="textbox"]'],
    prepare: async (target) => {
      await target.click();
    },
  },
];

async function launchPromptCrate(userDataDir: string): Promise<{
  context: BrowserContext;
  extensionId: string;
}> {
  await fs.rm(userDataDir, { force: true, recursive: true });
  await fs.mkdir(userDataDir, { recursive: true });
  const extensionDir = await prepareE2eExtensionDir(path.dirname(userDataDir));

  const chromeExecutablePath = findChromeExecutablePath();
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: chromeExecutablePath ? undefined : "chromium",
    executablePath: chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  return { context, extensionId };
}

async function prepareE2eExtensionDir(parentDir: string): Promise<string> {
  const extensionDir = path.join(parentDir, "extension-under-test");
  await fs.rm(extensionDir, { force: true, recursive: true });
  await fs.cp(distDir, extensionDir, { recursive: true });

  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ManifestRecord;
  // Test copy only: automated extension API dispatch does not reliably grant activeTab.
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), "tabs"])];
  manifest.host_permissions = [
    "http://127.0.0.1/*",
    "https://duckduckgo.com/*",
    "https://httpbin.org/*",
    "https://www.perplexity.ai/*",
    "https://www.wikipedia.org/*",
  ];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return extensionDir;
}

async function resetExtensionStorage(
  extensionId: string,
  context: BrowserContext,
): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.evaluate(() => chrome.storage.local.clear());
  await options.reload();
  await expect(options.locator(".status")).toContainText("templates loaded.");
  return options;
}

async function expectRegisteredShortcut(extensionPage: Page): Promise<void> {
  const shortcut = await extensionPage.evaluate(async () => {
    const command = (await chrome.commands.getAll()).find(
      (item) => item.name === "open-prompt-menu",
    );
    return command?.shortcut;
  });

  expect(shortcut).toBe("Ctrl+Shift+2");
}

async function primePromptCrateContentScript(
  page: Page,
  app: { context: BrowserContext; extensionId: string },
): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
  await openPromptMenu(page, page, app);
  await clickMenuButton(page, "Close");
  await waitForMenuClosed(page);
}

async function openPromptMenu(
  triggerPage: Page,
  menuScope: BrowserScope,
  app: { context: BrowserContext; extensionId: string },
): Promise<void> {
  const shortcutCandidates = ["Control+Shift+Digit2", "Control+Shift+2", "Control+Shift+P"];

  await triggerPage.bringToFront();

  if (shortcutOpensMenu !== false) {
    for (const shortcut of shortcutCandidates) {
      try {
        await triggerPage.keyboard.press(shortcut);
        await waitForMenu(menuScope, 1_000);
        shortcutOpensMenu = true;
        return;
      } catch {
        continue;
      }
    }

    shortcutOpensMenu = false;
  }

  await openPromptMenuViaExtensionApi(triggerPage, menuScope, app);
}

async function openPromptMenuViaExtensionApi(
  triggerPage: Page,
  menuScope: BrowserScope,
  app: { context: BrowserContext; extensionId: string },
): Promise<void> {
  await triggerPage.bringToFront();
  const worker = app.context.serviceWorkers()[0] ?? await app.context.waitForEvent("serviceworker");

  const diagnostics = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      const targetTab = tabs.find((tab) => tab.url === targetUrl) ??
        tabs.find((tab) => tab.active);

      if (typeof targetTab?.id !== "number") {
        throw new Error(`Target tab not found for ${targetUrl}`);
      }

      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id, allFrames: true },
        files: ["content-entry.js"],
      });

      return {
        chosenUrl: targetTab.url ?? "",
        injectedOnly: true,
        targetUrl,
        tabs: tabs.map((tab) => ({
          active: Boolean(tab.active),
          id: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? "",
        })),
      };
    }, triggerPage.url());

  if (menuScope === triggerPage) {
    const markedTarget = triggerPage.locator(
      '[data-promptcrate-e2e-focus-target="true"]',
    );

    if (await markedTarget.count()) {
      await markedTarget.click({ force: true });
    }

    await triggerPage.evaluate(() => {
      const markedTarget = document.querySelector<HTMLElement>(
        '[data-promptcrate-e2e-focus-target="true"]',
      );

      if (markedTarget) {
        markedTarget.focus();

        if (
          markedTarget instanceof HTMLInputElement ||
          markedTarget instanceof HTMLTextAreaElement
        ) {
          markedTarget.setSelectionRange(
            markedTarget.value.length,
            markedTarget.value.length,
          );
        }
      }

      window.dispatchEvent(
        new CustomEvent("promptcrate:open-menu", {
          detail: {
            focusSelector: '[data-promptcrate-e2e-focus-target="true"]',
          },
        }),
      );
    });
    lastOpenPromptDiagnostics = JSON.stringify(diagnostics, null, 2);
    await waitForMenu(menuScope);
    return;
  }

  const frameDiagnostics = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      const targetTab = tabs.find((tab) => tab.url === targetUrl) ??
        tabs.find((tab) => tab.active);

      if (typeof targetTab?.id !== "number") {
        throw new Error(`Target tab not found for ${targetUrl}`);
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id, allFrames: true },
        func: () => {
          const textInputTypes = new Set([
            "",
            "text",
            "search",
            "email",
            "url",
            "tel",
            "password",
          ]);
          const target = findPromptCrateTarget();
          const hasFocusedInsertTarget = Boolean(target);

          if (target) {
            focusTarget(target);
            window.dispatchEvent(
              new CustomEvent("promptcrate:open-menu", {
                detail: {
                  focusSelector: '[data-promptcrate-e2e-focus-target="true"]',
                },
              }),
            );
          }

          return {
            activeTag: document.activeElement?.tagName ?? "",
            didOpen: Boolean(target),
            hasFocusedInsertTarget,
            markerCount: document.querySelectorAll(
              '[data-promptcrate-e2e-focus-target="true"]',
            ).length,
          };

          function findPromptCrateTarget(): HTMLElement | null {
            const markedTarget = document.querySelector<HTMLElement>(
              '[data-promptcrate-e2e-focus-target="true"]',
            );

            if (markedTarget) {
              return markedTarget;
            }

            let activeElement = document.activeElement;

            while (activeElement?.shadowRoot?.activeElement) {
              activeElement = activeElement.shadowRoot.activeElement;
            }

            if (isInsertTarget(activeElement) && activeElement instanceof HTMLElement) {
              return activeElement;
            }

            return null;
          }

          function focusTarget(target: HTMLElement): void {
            target.focus();

            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              target.setSelectionRange(target.value.length, target.value.length);
              return;
            }

            if (target.isContentEditable) {
              const range = document.createRange();
              range.selectNodeContents(target);
              range.collapse(false);
              const selection = document.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
          }

          function isInsertTarget(element: Element | null): boolean {
            return Boolean(
              element instanceof HTMLTextAreaElement ||
                (element instanceof HTMLInputElement &&
                  textInputTypes.has(element.type.toLocaleLowerCase())) ||
                element?.closest(
                  '[contenteditable="true"], [contenteditable="plaintext-only"]',
                ),
            );
          }
        },
      });
      const openedFrameIds = results
        .filter((result) => result.result?.didOpen === true)
        .map((result) => result.frameId)
        .filter((frameId): frameId is number => typeof frameId === "number");

      if (openedFrameIds.length === 0) {
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id, frameIds: [0] },
          func: () => {
            window.dispatchEvent(new Event("promptcrate:open-menu"));
          },
        });
      }

      return {
        chosenUrl: targetTab.url ?? "",
        frameIds: openedFrameIds.length > 0 ? openedFrameIds : [0],
        frameProbe: results.map((result) => ({
          frameId: result.frameId,
          result: result.result,
        })),
        targetUrl,
        tabs: tabs.map((tab) => ({
          active: Boolean(tab.active),
          id: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? "",
        })),
      };
    }, triggerPage.url());
  lastOpenPromptDiagnostics = JSON.stringify(frameDiagnostics, null, 2);
  await waitForMenu(menuScope);
}

async function waitForMenu(scope: BrowserScope, timeout = 7_000): Promise<void> {
  await scope.waitForFunction(
    (hostId) => {
      const host = document.getElementById(hostId) as HTMLDivElement | null;
      return Boolean(
        host &&
          host.style.display !== "none" &&
          host.shadowRoot?.querySelector(".panel"),
      );
    },
    extensionHostId,
    { timeout },
  );
}

async function waitForMenuClosed(scope: BrowserScope): Promise<void> {
  await scope.waitForFunction((hostId) => {
    const host = document.getElementById(hostId) as HTMLDivElement | null;
    return !host || host.style.display === "none" || !host.shadowRoot?.querySelector(".panel");
  }, extensionHostId);
}

function expectMenuText(scope: BrowserScope) {
  return expect.poll(() =>
    scope.evaluate((hostId) => {
      return document.getElementById(hostId)?.shadowRoot?.textContent ?? "";
    }, extensionHostId),
  );
}

async function insertTemplateFromMenu(
  scope: BrowserScope,
  title: string,
  values: Record<string, string> = {},
): Promise<void> {
  await fillMenuSearch(scope, title);
  await scope.evaluate(
    ({ hostId, templateTitle }) => {
      const shadow = document.getElementById(hostId)?.shadowRoot;
      const item = [...(shadow?.querySelectorAll<HTMLElement>(".template-item") ?? [])]
        .find((candidate) =>
          candidate.querySelector(".template-title")?.textContent?.includes(templateTitle),
        );

      if (!item) {
        throw new Error(`Template not found: ${templateTitle}`);
      }

      item.click();
    },
    { hostId: extensionHostId, templateTitle: title },
  );

  if (Object.keys(values).length === 0) {
    await waitForMenuClosed(scope);
    return;
  }

  await scope.waitForFunction((hostId) => {
    return Boolean(document.getElementById(hostId)?.shadowRoot?.querySelector(".variable-form"));
  }, extensionHostId);

  for (const [name, value] of Object.entries(values)) {
    await scope.evaluate(
      ({ hostId, variableName, variableValue }) => {
        const shadow = document.getElementById(hostId)?.shadowRoot;
        const labels = [...(shadow?.querySelectorAll<HTMLElement>(".field") ?? [])];
        const label = labels.find((candidate) =>
          candidate.querySelector("span")?.textContent?.startsWith(variableName),
        );
        const input = label?.querySelector<HTMLInputElement>("input");

        if (!input) {
          throw new Error(`Variable input not found: ${variableName}`);
        }

        input.value = variableValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      { hostId: extensionHostId, variableName: name, variableValue: value },
    );
  }

  await clickMenuButton(scope, "Insert");
  await waitForMenuClosed(scope);
}

async function fillMenuSearch(scope: BrowserScope, value: string): Promise<void> {
  await scope.evaluate(
    ({ diagnostics, hostId, query }) => {
      const shadow = document.getElementById(hostId)?.shadowRoot;
      const searchInput = shadow?.querySelector<HTMLInputElement>("input.search");

      if (!searchInput) {
        const menuText = shadow?.querySelector(".panel")?.textContent ??
          shadow?.textContent ??
          "<missing shadow>";
        throw new Error(
          `PromptCrate search input not found. Menu text: ${menuText}\nOpen diagnostics: ${diagnostics}`,
        );
      }

      searchInput.value = query;
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { diagnostics: lastOpenPromptDiagnostics, hostId: extensionHostId, query: value },
  );
  await expectMenuText(scope).toContain(value);
}

async function clickMenuButton(scope: BrowserScope, label: string): Promise<void> {
  await scope.evaluate(
    ({ hostId, buttonLabel }) => {
      const button = [...(document
        .getElementById(hostId)
        ?.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((candidate) =>
          candidate.textContent === buttonLabel ||
          candidate.getAttribute("aria-label") === buttonLabel,
        );

      if (!button) {
        throw new Error(`PromptCrate button not found: ${buttonLabel}`);
      }

      button.click();
    },
    { hostId: extensionHostId, buttonLabel: label },
  );
}

async function installEventCounters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as Window & {
      __promptCrateEventCounts?: Record<string, number>;
    };
    state.__promptCrateEventCounts = {
      editable: 0,
      shadowInput: 0,
      textInput: 0,
      textarea: 0,
    };

    const watch = (key: string, target: EventTarget | null | undefined) => {
      target?.addEventListener("input", () => {
        const counts = state.__promptCrateEventCounts;
        if (counts) {
          counts[key] = (counts[key] ?? 0) + 1;
        }
      });
    };

    watch("textarea", document.getElementById("textarea"));
    watch("textInput", document.getElementById("text-input"));
    watch("editable", document.getElementById("editable"));
    watch(
      "shadowInput",
      document
        .getElementById("shadow-host")
        ?.shadowRoot?.querySelector<HTMLInputElement>("#shadow-input"),
    );
  });
}

async function readEventCount(page: Page, key: string): Promise<number> {
  return page.evaluate((counterKey) => {
    const state = window as Window & {
      __promptCrateEventCounts?: Record<string, number>;
    };
    return state.__promptCrateEventCounts?.[counterKey] ?? 0;
  }, key);
}

async function getFixtureIframe(page: Page): Promise<Frame> {
  const frameHandle = await page.locator("#iframe-input").elementHandle();
  const frame = await frameHandle?.contentFrame();

  if (!frame) {
    throw new Error("Fixture iframe not found.");
  }

  return frame;
}

async function readTemplates(page: Page): Promise<PromptTemplateRecord[]> {
  return page.evaluate(async () => {
    const result = await chrome.storage.local.get(["promptCrate.templates"]);
    return (result["promptCrate.templates"] ?? []) as PromptTemplateRecord[];
  });
}

async function writeImportFile(
  filePath: string,
  templates: PromptTemplateRecord[],
): Promise<void> {
  const payload: TemplateExportPayloadRecord = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    templates,
  };

  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createTemplate(
  id: string,
  title: string,
  body: string,
  tags: string[],
): PromptTemplateRecord {
  const now = new Date().toISOString();

  return {
    id,
    title,
    body,
    tags,
    isFavorite: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      await expect(locator).toBeVisible({ timeout: 8_000 });
      return locator;
    } catch {
      continue;
    }
  }

  throw new Error(`No visible selector found: ${selectors.join(", ")}`);
}

async function readEditableValue(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return element.value;
    }

    return element.textContent ?? "";
  });
}

async function focusEditableAtEnd(locator: Locator): Promise<void> {
  await locator.click({ force: true });
  await locator.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.setAttribute("data-promptcrate-e2e-focus-target", "true");
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      return;
    }

    if (element instanceof HTMLElement) {
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  });
}

async function startStaticServer(rootDir: string): Promise<{
  server: Server;
  baseURL: string;
}> {
  const server = createServer((request, response) => {
    void serveStaticFile(rootDir, request.url ?? "/", response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    baseURL: `http://127.0.0.1:${address.port}`,
  };
}

async function serveStaticFile(
  rootDir: string,
  requestUrl: string,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const relativePath = url.pathname === "/" ? "/fixtures/manual-inputs.html" : url.pathname;
  const filePath = path.resolve(rootDir, `.${decodeURIComponent(relativePath)}`);

  if (!filePath.startsWith(rootDir + path.sep)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    response.writeHead(200, { "content-type": getContentType(filePath) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase();

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }

  if (extension === ".png") {
    return "image/png";
  }

  return "application/octet-stream";
}

function findChromeExecutablePath(): string | undefined {
  const explicitPath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH;
  if (explicitPath && fsSync.existsSync(explicitPath)) {
    return explicitPath;
  }

  return undefined;
}
