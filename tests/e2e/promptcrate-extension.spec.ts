import {
  chromium,
  selectors,
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
import { build } from "vite";
import { detectFocusedInsertTarget } from "../../src/background/frame-targeting";

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

test.beforeAll(async () => {
  await selectors.register("promptMenu", () => {
    const getRoot = (root: Node) => {
      const document = (root.nodeType === Node.DOCUMENT_NODE ? root : root.ownerDocument) as Document;
      return document.getElementById("promptcrate-menu-host")?.shadowRoot;
    };
    return {
      query: (root: Node, selector: string) => getRoot(root)?.querySelector(selector) ?? null,
      queryAll: (root: Node, selector: string) => [...(getRoot(root)?.querySelectorAll(selector) ?? [])],
    };
  }, { contentScript: false });
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

test("ranked token search and tag filters work in the menu and Options with bounded results", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-ranked-search"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const templates = [
      createTemplate("prefix", "Rewrite concise", "A short prompt", ["writing"]),
      createTemplate("guide", "Rewrite guide", "Another prompt", ["writing"]),
      { ...createTemplate("body", "Body favorite", "rewrite writing in the body", ["other"]), isFavorite: true },
    ];
    await options.evaluate((records) => chrome.storage.local.set({ "promptCrate.templates": records }), templates);
    await options.locator("input.search").fill("rewrite writing");
    await expect(options.locator(".template-row")).toHaveCount(3);
    await expect(options.locator(".template-row").first()).toContainText("Rewrite concise");
    await options.locator("input.search").fill("#writing rewrite");
    await expect(options.locator(".template-row")).toHaveCount(2);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    const menu = menuPanel(page);
    await menu.locator("input.search").fill("rewrite writing");
    await expect(menu.getByRole("option")).toHaveCount(3);
    await expect(menu.getByRole("option").first()).toContainText("Rewrite concise");
    await menu.locator("input.search").fill("#writing rewrite");
    await expect(menu.getByRole("option")).toHaveCount(2);
    await menu.locator("input.search").fill("rwt");
    await expect(menu.getByRole("option")).toHaveCount(2);
    await clickMenuButton(page, "Close");
    const many = Array.from({ length: 250 }, (_, index) =>
      createTemplate(`item-${index}`, `Item ${String(index).padStart(3, "0")}`, `Value ${index}`, []));
    await options.evaluate((records) => chrome.storage.local.set({ "promptCrate.templates": records }), many);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await expect(menu.getByRole("option")).toHaveCount(100);
    await expect(menu.getByRole("status")).toContainText("first 100 of 250");
    for (let index = 0; index < 105; index += 1) await page.keyboard.press("ArrowDown");
    await expect(menu.locator('[aria-selected="true"]')).toContainText("Item 099");
    await menu.locator("input.search").fill("Item 249");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await waitForMenuClosed(page);
    await expect(page.locator("#textarea")).toHaveValue("Value 249");
  } finally {
    await app.context.close();
  }
});

test("menu placement stays near its target and themes follow preference and system changes", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-placement-theme"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.getByRole("combobox", { name: /Theme/ }).selectOption("dark");
    await expect(options.locator("html")).toHaveAttribute("data-theme", "dark");
    const optionsScreenshot = testInfo.outputPath("options-dark.png");
    await options.screenshot({ path: optionsScreenshot, fullPage: true });
    await testInfo.attach("options-dark", { path: optionsScreenshot, contentType: "image/png" });
    const page = await app.context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 900, height: 700 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.evaluate(() => {
      document.documentElement.style.colorScheme = "dark";
      document.body.style.background = "#10191d";
      document.body.style.color = "#e2edef";
      const target = document.createElement("textarea");
      target.id = "bottom-target";
      target.style.cssText = "position:fixed;right:30px;bottom:24px;width:300px;height:76px;z-index:1";
      document.body.append(target);
      target.focus();
    });
    await openPromptMenu(page, page, app);
    const panel = menuPanel(page);
    await expect(page.locator(`#${extensionHostId}`)).toHaveAttribute("data-theme", "dark");
    expect(await panel.evaluate((node) => getComputedStyle(node).colorScheme)).toBe("dark");
    const bounds = async () => {
      const box = await panel.boundingBox();
      const target = await page.locator("#bottom-target").boundingBox();
      const viewport = page.viewportSize()!;
      return Boolean(box && target && box.x >= 11 && box.y >= 11 &&
        box.x + box.width <= viewport.width - 11 && box.y + box.height <= viewport.height - 11 &&
        box.y + box.height <= target.y - 6);
    };
    await expect.poll(bounds).toBe(true);
    const screenshotPath = testInfo.outputPath("menu-dark-position.png");
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("menu-dark-position", { path: screenshotPath, contentType: "image/png" });
    await page.setViewportSize({ width: 520, height: 440 });
    await expect.poll(bounds).toBe(true);
    const originalPanel = await panel.elementHandle();
    await options.getByRole("combobox", { name: /Theme/ }).selectOption("light");
    await expect(page.locator(`#${extensionHostId}`)).toHaveAttribute("data-theme", "light");
    expect(await panel.evaluate((node) => getComputedStyle(node).colorScheme)).toBe("light");
    await options.getByRole("combobox", { name: /Theme/ }).selectOption("system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator(`#${extensionHostId}`)).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator(`#${extensionHostId}`)).toHaveAttribute("data-theme", "light");
    expect(await originalPanel!.evaluate((node) => node.isConnected)).toBe(true);
    expect(errors).toEqual([]);
    await clickMenuButton(page, "Close");
    await options.addInitScript(() => {
      chrome.commands.getAll = (async () => [{ name: "open-prompt-menu", shortcut: "" }]) as typeof chrome.commands.getAll;
    });
    await options.reload();
    await expect(options.getByRole("region", { name: "Preferences" })).toContainText("Shortcut not assigned");
    const created = app.context.waitForEvent("page");
    await options.getByRole("button", { name: "Configure shortcut", exact: true }).click();
    const shortcuts = await created;
    await shortcuts.waitForURL("chrome://extensions/shortcuts");
  } finally {
    await app.context.close();
  }
});

test("favorite markers are labelled and invalid variables receive focus and an alert", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-accessible-errors"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.evaluate((record) => chrome.storage.local.set({ "promptCrate.templates": [record] }), {
      ...createTemplate("accessible", "Accessible template", "First {{a}} Second {{b}}", []), isFavorite: true,
    });
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await expect(menuPanel(page).getByRole("img", { name: "Favorite", exact: true })).toHaveCount(1);
    await chooseTemplateFromMenu(page, "Accessible template");
    await menuPanel(page).getByLabel("a", { exact: true }).fill("Value");
    await menuPanel(page).getByLabel("b", { exact: true }).fill("   ");
    await clickMenuButton(page, "Insert");
    await expect(menuPanel(page).getByRole("alert")).toContainText("Fill b before inserting.");
    await expect(menuPanel(page).getByLabel("b", { exact: true })).toBeFocused();
    await expect(menuPanel(page).getByLabel("a", { exact: true })).toHaveValue("Value");
    await menuPanel(page).getByLabel("b", { exact: true }).fill("OK");
    await page.keyboard.press("Control+Enter");
    await waitForMenuClosed(page);
    await expect(page.locator("#textarea")).toHaveValue("First Value Second OK");
  } finally {
    await app.context.close();
  }
});

test("page scripts cannot read, reopen, or synthetically operate the private menu", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-private-menu"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.getByRole("button", { name: "New", exact: true }).click();
    await options.getByLabel("Title").fill("Private trigger");
    await options.getByLabel("Body").fill("PRIVATE TEMPLATE: {{value}}");
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Private trigger".');
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.evaluate(() => {
      const scope = window as Window & { __capturedMenuRoots?: ShadowRoot[] };
      scope.__capturedMenuRoots = [];
      const originalAttach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(this: Element, init: ShadowRootInit) {
        const root = originalAttach.call(this, init);
        if (this.id === "promptcrate-menu-host") scope.__capturedMenuRoots!.push(root);
        return root;
      };
      const fake = document.createElement("div");
      fake.id = "promptcrate-menu-host";
      fake.style.display = "none";
      fake.attachShadow({ mode: "open" }).textContent = "Page-owned impostor";
      document.documentElement.append(fake);
      document.querySelector<HTMLTextAreaElement>("#textarea")!.focus();
    });
    const worker = app.context.serviceWorkers()[0] ?? await app.context.waitForEvent("serviceworker");
    expect(await worker.evaluate(() => chrome.action.onClicked.hasListeners())).toBe(true);
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
      await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, files: ["content-entry.js"] });
    }, page.url());
    // No debugger bridge is installed in this test. All page-side privacy assertions use native DOM access.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("promptcrate:open-menu", {
      detail: { focusSelector: "#text-input" },
    })));
    expect(await page.evaluate(() => ({
      display: document.getElementById("promptcrate-menu-host")!.style.display,
      text: document.getElementById("promptcrate-menu-host")!.shadowRoot?.textContent,
      focused: document.activeElement?.id,
    }))).toEqual({ display: "none", text: "Page-owned impostor", focused: "textarea" });

    await sendMenuOpen(page, page, app);
    await page.waitForFunction(() => document.getElementById("promptcrate-menu-host")?.style.display === "block");
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById("promptcrate-menu-host")!;
      const roots = (window as Window & { __capturedMenuRoots?: ShadowRoot[] }).__capturedMenuRoots!;
      return {
        root: host.shadowRoot,
        privateInPage: document.documentElement.textContent?.includes("PRIVATE TEMPLATE"),
        visibleBodies: document.querySelectorAll(".template-body").length,
        captured: roots.length,
        impostorConnected: roots[0].host.isConnected,
      };
    })).toEqual({ root: null, privateInPage: false, visibleBodies: 0, captured: 1, impostorConnected: false });
    const session = await menuDebugger(page);
    let root = (await inspectMenuRoots(page))[0];
    const inspect = async (fn: string) => (await session.send("Runtime.callFunctionOn", {
      objectId: root.objectId, functionDeclaration: fn, returnByValue: true,
    })).result.value;
    await expect.poll(() => inspect('function() { return !!this.querySelector(".search"); }')).toBe(true);
    expect(await inspect(`function() {
      this.querySelector(".template-item").click();
      this.querySelector(".search").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
      this.querySelector('[aria-label="Close"]').click();
      return { display: this.host.style.display, form: !!this.querySelector(".variable-form") };
    }`)).toEqual({ display: "block", form: false });
    await expect(page.locator("#textarea")).toHaveValue("");
    // Removing the owned host and forging its ID must not cause adoption of the page's open root.
    await page.evaluate(() => {
      document.getElementById("promptcrate-menu-host")!.remove();
      const fake = document.createElement("div");
      fake.id = "promptcrate-menu-host";
      fake.attachShadow({ mode: "open" }).textContent = "Second impostor";
      document.documentElement.append(fake);
    });
    await sendMenuOpen(page, page, app);
    await page.waitForFunction(() => document.getElementById("promptcrate-menu-host")?.style.display === "block");
    expect(await page.evaluate(() => document.getElementById("promptcrate-menu-host")!.shadowRoot)).toBeNull();
    root = (await inspectMenuRoots(page))[0];
    const search = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input.search" });
    await session.send("DOM.focus", { nodeId: search.nodeId });
    await page.keyboard.insertText("Private trigger");
    await expect.poll(() => inspect('function() { return this.querySelectorAll(".template-item").length; }')).toBe(1);
    await page.keyboard.press("Enter");
    await expect.poll(() => inspect('function() { return !!this.querySelector(".variable-form"); }')).toBe(true);
    const variable = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "textarea" });
    await session.send("DOM.focus", { nodeId: variable.nodeId });
    await page.keyboard.insertText("User-approved value");
    expect(await inspect(`function() {
      this.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return this.host.style.display;
    }`)).toBe("block");
    await expect(page.locator("#textarea")).toHaveValue("");
    expect(await page.evaluate(() => document.getElementById("promptcrate-menu-host")!.shadowRoot)).toBeNull();
    await page.keyboard.press("Control+Enter");
    await waitForMenuClosed(page);
    await expect(page.locator("#textarea")).toHaveValue("PRIVATE TEMPLATE: User-approved value");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("promptcrate:open-menu", {
      detail: { focusSelector: "#text-input" },
    })));
    expect(await page.evaluate(() => ({
      display: document.getElementById("promptcrate-menu-host")!.style.display,
      focused: document.activeElement?.id,
      root: document.getElementById("promptcrate-menu-host")!.shadowRoot,
    }))).toEqual({ display: "none", focused: "textarea", root: null });
    await expect.poll(async () => (await readTemplates(options)).filter((item) => item.lastUsedAt).length).toBe(1);
    const iframe = await getFixtureIframe(page);
    await iframe.locator("#iframe-textarea").focus();
    await sendMenuOpen(page, iframe, app);
    await iframe.waitForFunction(() => document.getElementById("promptcrate-menu-host")?.style.display === "block");
    await iframe.waitForFunction(() => document.activeElement?.id === "promptcrate-menu-host");
    await expect.poll(() => iframe.evaluate(detectFocusedInsertTarget)).toEqual({ hasFocusedInsertTarget: true });
    expect(await iframe.evaluate(() => document.getElementById("promptcrate-menu-host")!.shadowRoot)).toBeNull();
    await page.keyboard.press("Escape");
    await waitForMenuClosed(iframe);
  } finally {
    await app.context.close();
  }
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

test("appends plain and variable templates to email inputs without selection APIs", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-email"));

  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await primePromptCrateContentScript(page, app);
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "email-regression";
      input.type = "email";
      input.addEventListener("input", () => {
        input.dataset.inputCount = String(Number(input.dataset.inputCount ?? 0) + 1);
      });
      document.body.prepend(input);
    });

    const scenarios: Array<{ title: string; values: Record<string, string>; inserted: string }> = [
      {
        title: "Summarize page",
        values: {},
        inserted: "Summarize the key ideas from this page in concise bullets.",
      },
      {
        title: "Rewrite clearer",
        values: { text: "Email variable" },
        inserted: "Rewrite the following text so it is clearer, shorter, and keeps the original meaning:Email variable",
      },
    ];
    for (const scenario of scenarios) {
      const target = page.locator("#email-regression");
      await target.evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "original@example.com";
        input.dataset.inputCount = "0";
        input.focus();
      });
      await openPromptMenu(page, page, app);
      await insertTemplateFromMenu(page, scenario.title, scenario.values);
      await expect(target).toHaveValue(`original@example.com${scenario.inserted}`);
      await expect(target).toHaveAttribute("data-input-count", "1");
    }
  } finally {
    await app.context.close();
  }
});

test("rejects readonly controls and controls made readonly or disabled while the menu is open", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-noneditable"));

  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await primePromptCrateContentScript(page, app);

    for (const tag of ["input", "textarea"] as const) {
      await page.evaluate((tagName) => {
        document.getElementById("noneditable-regression")?.remove();
        const target = document.createElement(tagName);
        target.id = "noneditable-regression";
        target.value = "Original value";
        target.readOnly = true;
        target.dataset.inputCount = "0";
        target.addEventListener("input", () => {
          target.dataset.inputCount = String(Number(target.dataset.inputCount) + 1);
        });
        document.body.prepend(target);
        target.focus();
      }, tag);
      const target = page.locator("#noneditable-regression");
      await openPromptMenu(page, page, app);
      await expectMenuText(page).toContain("Focus a text field before opening PromptCrate.");
      await expect(target).toHaveValue("Original value");
      await expect(target).toHaveAttribute("data-input-count", "0");
      await clickMenuButton(page, "Close");
      await waitForMenuClosed(page);

      for (const property of ["readOnly", "disabled"] as const) {
        await target.evaluate((element) => {
          const control = element as HTMLInputElement | HTMLTextAreaElement;
          control.readOnly = false;
          control.disabled = false;
          control.focus();
          control.setSelectionRange(control.value.length, control.value.length);
        });
        await openPromptMenu(page, page, app);
        await target.evaluate((element, key) => {
          (element as HTMLInputElement | HTMLTextAreaElement)[key] = true;
        }, property);
        await chooseTemplateFromMenu(page, "Summarize page");
        await expectMenuText(page).toContain("PromptCrate could not insert into this field.");
        await expect(target).toHaveValue("Original value");
        await expect(target).toHaveAttribute("data-input-count", "0");
        await clickMenuButton(page, "Close");
        await waitForMenuClosed(page);
      }
    }
  } finally {
    await app.context.close();
  }
});

test("composes Shadow DOM insertion events and honors document beforeinput cancellation", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-shadow-events"));

  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await primePromptCrateContentScript(page, app);
    await page.evaluate(() => {
      const host = document.getElementById("shadow-host")!;
      const input = host.shadowRoot!.querySelector<HTMLInputElement>("#shadow-input")!;
      for (const [scope, target] of [["host", host], ["document", document]] as const) {
        for (const type of ["beforeinput", "input"]) {
          target.addEventListener(type, (event) => {
            if (event.composedPath().includes(input)) {
              host.setAttribute(`data-${scope}-events`,
                `${host.getAttribute(`data-${scope}-events`) ?? ""}${type}:${event.composed}|`);
              if (scope === "document" && type === "beforeinput" && host.dataset.cancel === "true") {
                event.preventDefault();
              }
            }
          });
        }
      }
    });

    for (const cancel of [false, true]) {
      await page.evaluate((shouldCancel) => {
        const host = document.getElementById("shadow-host")!;
        host.setAttribute("data-host-events", "");
        host.setAttribute("data-document-events", "");
        host.dataset.cancel = String(shouldCancel);
        const input = host.shadowRoot!.querySelector<HTMLInputElement>("#shadow-input")!;
        input.value = "Shadow ";
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, cancel);
      await openPromptMenu(page, page, app);
      await chooseTemplateFromMenu(page, "Summarize page");
      if (cancel) {
        await expectMenuText(page).toContain("PromptCrate could not insert into this field.");
      } else {
        await waitForMenuClosed(page);
      }
      await expect(page.locator("#shadow-input")).toHaveValue(cancel
        ? "Shadow "
        : "Shadow Summarize the key ideas from this page in concise bullets.");
      const events = cancel ? "beforeinput:true|" : "beforeinput:true|input:true|";
      await expect(page.locator("#shadow-host")).toHaveAttribute("data-host-events", events);
      await expect(page.locator("#shadow-host")).toHaveAttribute("data-document-events", events);
      if (cancel) {
        await clickMenuButton(page, "Close");
        await waitForMenuClosed(page);
      }
    }
  } finally {
    await app.context.close();
  }
});

test("native template insertion delivers one input event and supports undo and redo", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-native-undo"));
  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    const original = "Before REPLACE after";
    const summary = "Summarize the key ideas from this page in concise bullets.";
    for (const selector of ["#textarea", "#text-input", "#shadow-input", "#editable"]) {
      const target = page.locator(selector);
      await target.evaluate((element, value) => {
        element.addEventListener("beforeinput", (event) => {
          const events = JSON.parse((element as HTMLElement).dataset.editEvents ?? "[]") as unknown[];
          events.push({ type: event.type, trusted: event.isTrusted });
          (element as HTMLElement).dataset.editEvents = JSON.stringify(events);
          if ((event as InputEvent).inputType === "insertText") {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              element.setSelectionRange(element.value.length, element.value.length);
            } else {
              const moved = document.createRange();
              moved.selectNodeContents(element);
              moved.collapse(false);
              document.getSelection()!.removeAllRanges();
              document.getSelection()!.addRange(moved);
            }
          }
        });
        element.addEventListener("input", (event) => {
          const events = JSON.parse((element as HTMLElement).dataset.editEvents ?? "[]") as unknown[];
          events.push({ type: event.type, trusted: event.isTrusted });
          (element as HTMLElement).dataset.editEvents = JSON.stringify(events);
        });
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = value;
          element.focus();
          element.setSelectionRange(7, 14);
        } else {
          element.textContent = value;
          (element as HTMLElement).focus();
          const range = document.createRange();
          range.setStart(element.firstChild!, 7);
          range.setEnd(element.firstChild!, 14);
          document.getSelection()!.removeAllRanges();
          document.getSelection()!.addRange(range);
        }
        (element as HTMLElement).dataset.editEvents = "[]";
      }, original);
      await openPromptMenu(page, page, app);
      await insertTemplateFromMenu(page, "Summarize page");
      expect(await readEditableValue(target)).toBe(`Before ${summary} after`);
      expect(JSON.parse(await target.getAttribute("data-edit-events") ?? "[]")).toEqual([
        { type: "beforeinput", trusted: false }, { type: "input", trusted: true },
      ]);
      await page.keyboard.press("Control+z");
      await expect.poll(() => readEditableValue(target)).toBe(original);
      await page.keyboard.press("Control+Shift+z");
      await expect.poll(() => readEditableValue(target)).toBe(`Before ${summary} after`);
    }

    await page.evaluate(() => {
      const textarea = document.createElement("textarea");
      textarea.id = "history-textarea";
      document.body.prepend(textarea);
    });
    const textarea = page.locator("#history-textarea");
    await textarea.pressSequentially("Earlier typing");
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect(textarea).toHaveValue(`Earlier typing${summary}`);
    await page.keyboard.press("Control+z");
    await expect(textarea).toHaveValue("Earlier typing");
    await page.keyboard.press("Control+z");
    await expect(textarea).toHaveValue("");

    for (const selector of ["#textarea", "#text-input"]) {
      for (const value of ["abcde", "abc"]) {
        const constrained = page.locator(selector);
        await constrained.evaluate((element, text) => {
          const control = element as HTMLInputElement | HTMLTextAreaElement;
          control.maxLength = 5;
          control.value = text;
          control.focus();
          control.setSelectionRange(text.length, text.length);
        }, value);
        await openPromptMenu(page, page, app);
        await chooseTemplateFromMenu(page, "Summarize page");
        await expectMenuText(page).toContain("PromptCrate could not insert into this field.");
        await expect(constrained).toHaveValue(value);
        await clickMenuButton(page, "Close");
        await waitForMenuClosed(page);
      }
    }
  } finally {
    await app.context.close();
  }
});

test("native insertion and undo update React controlled inputs", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-react-inputs"));
  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    const fixtureDirectory = testInfo.outputPath("react-fixture");
    await build({
      configFile: false,
      publicDir: false,
      logLevel: "error",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: fixtureDirectory,
        emptyOutDir: true,
        lib: {
          entry: path.join(repoRoot, "tests/e2e/fixtures/react-controlled.ts"),
          name: "ReactControlledFixture",
          formats: ["iife"],
          fileName: () => "react-controlled.js",
        },
      },
    });
    await page.addScriptTag({ path: path.join(fixtureDirectory, "react-controlled.js") });
    for (const selector of ["#react-input", "#react-textarea"]) {
      const target = page.locator(selector);
      await expect(target).toHaveValue("Before REPLACE after");
      await target.evaluate((element) => {
        const control = element as HTMLInputElement | HTMLTextAreaElement;
        control.focus();
        control.setSelectionRange(7, 14);
      });
      await openPromptMenu(page, page, app);
      await insertTemplateFromMenu(page, "Summarize page");
      await expect(target).toHaveValue("Before Summarize the key ideas from this page in concise bullets. after");
      await page.keyboard.press("Control+z");
      await expect(target).toHaveValue("Before REPLACE after");
    }
  } finally {
    await app.context.close();
  }
});

test("computed editable targets accept legal attributes and reject noneditable islands", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-editable-attributes"));
  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.evaluate(() => {
      const container = document.createElement("section");
      container.innerHTML = '<div id="ce-bare" contenteditable>Before REPLACE after</div>' +
        '<div id="ce-upper" contenteditable="TRUE">Before REPLACE after</div>' +
        '<div id="ce-plain" contenteditable="plaintext-only">Before REPLACE after</div>' +
        '<div id="ce-inherited" contenteditable=""><span>Before REPLACE after</span></div>' +
        '<div id="ce-outer" contenteditable="true">Outer <div id="ce-blocked" contenteditable="false" tabindex="0">Locked ' +
        '<div id="ce-reenabled" contenteditable="true" tabindex="0">Before REPLACE after</div></div></div>';
      document.body.prepend(container);
    });
    const summary = "Summarize the key ideas from this page in concise bullets.";
    for (const selector of ["#ce-bare", "#ce-upper", "#ce-plain", "#ce-inherited", "#ce-reenabled"]) {
      const target = page.locator(selector);
      await target.evaluate((element) => {
        (element as HTMLElement).focus();
        const text = element.querySelector("span")?.firstChild ?? element.firstChild!;
        const range = document.createRange();
        range.setStart(text, 7);
        range.setEnd(text, 14);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
      });
      // Evaluate the actual production probe as a serialized function, as executeScript does.
      expect(await page.evaluate(detectFocusedInsertTarget)).toEqual({ hasFocusedInsertTarget: true });
      await openPromptMenu(page, page, app);
      await insertTemplateFromMenu(page, "Summarize page");
      await expect(target).toHaveText(`Before ${summary} after`);
    }
    const protectedHtml = await page.locator("#ce-outer").innerHTML();
    await page.locator("#ce-blocked").focus();
    expect(await page.evaluate(detectFocusedInsertTarget)).toEqual({ hasFocusedInsertTarget: false });
    await openPromptMenu(page, page, app);
    await expectMenuText(page).toContain("Focus a text field before opening PromptCrate.");
    await clickMenuButton(page, "Close");
    await waitForMenuClosed(page);
    expect(await page.locator("#ce-outer").innerHTML()).toBe(protectedHtml);

    // A selection inside an immutable island must also be rejected if its editable parent retains focus.
    await page.locator("#ce-outer").evaluate((element) => {
      (element as HTMLElement).focus();
      const range = document.createRange();
      const text = element.querySelector("#ce-blocked")!.firstChild!;
      range.setStart(text, 1);
      range.collapse(true);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    });
    await openPromptMenu(page, page, app);
    await expectMenuText(page).toContain("Focus a text field before opening PromptCrate.");
    await clickMenuButton(page, "Close");
    await waitForMenuClosed(page);
    expect(await page.locator("#ce-outer").innerHTML()).toBe(protectedHtml);

    // Editability can be revoked while the menu is open.
    await page.locator("#ce-bare").focus();
    const before = await page.locator("#ce-bare").innerHTML();
    await openPromptMenu(page, page, app);
    await page.locator("#ce-bare").evaluate((element) => element.setAttribute("contenteditable", "false"));
    await chooseTemplateFromMenu(page, "Summarize page");
    await expectMenuText(page).toContain("PromptCrate could not insert into this field.");
    expect(await page.locator("#ce-bare").innerHTML()).toBe(before);
    await clickMenuButton(page, "Close");
  } finally {
    await app.context.close();
  }
});

test("Options tabs preserve unrelated edits, report conflicts, and keep drafts as new templates", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-concurrent-options"));
  try {
    const first = await resetExtensionStorage(app.extensionId, app.context);
    const second = await app.context.newPage();
    await second.goto(`chrome-extension://${app.extensionId}/options.html`);
    await expect(second.locator(".status")).toContainText("templates loaded.");
    await second.getByRole("button", { name: /Compare options/ }).click();
    await second.getByLabel("Body").fill("Pending draft from tab two");
    await first.getByRole("button", { name: "New", exact: true }).click();
    await first.getByLabel("Title").fill("Created in tab one");
    await first.getByLabel("Body").fill("Body from tab one");
    await first.getByRole("button", { name: "Save", exact: true }).click();
    await expect(first.locator(".status")).toContainText('Saved "Created in tab one".');
    await expect(second.getByRole("button", { name: /Created in tab one/ })).toBeVisible();
    await expect(second.getByLabel("Body")).toHaveValue("Pending draft from tab two");
    await second.getByRole("button", { name: "Save", exact: true }).click();
    await expect(second.locator(".status")).toContainText('Saved "Compare options".');
    expect((await readTemplates(second)).find((item) => item.id === "created-in-tab-one")?.body).toBe("Body from tab one");

    for (const tab of [first, second]) {
      await tab.getByRole("button", { name: /Rewrite clearer/ }).click();
    }
    await second.getByLabel("Body").fill("Unsaved conflicting draft");
    await first.getByLabel("Body").fill("Newer stored revision");
    await first.getByRole("button", { name: "Save", exact: true }).click();
    await expect(first.locator(".status")).toContainText('Saved "Rewrite clearer".');
    await expect(second.locator(".status.error")).toContainText("another tab");
    await expect(second.getByLabel("Body")).toHaveValue("Unsaved conflicting draft");
    await second.getByRole("button", { name: "Save", exact: true }).click();
    await expect(second.locator(".status.error")).toContainText("another tab");
    expect((await readTemplates(second)).find((item) => item.id === "rewrite-clearer")?.body).toBe("Newer stored revision");
    const screenshotPath = testInfo.outputPath("options-conflict.png");
    await second.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach("options-conflict", { path: screenshotPath, contentType: "image/png" });
    await second.getByRole("button", { name: "Keep as new", exact: true }).click();
    await expect(second.getByLabel("Body")).toHaveValue("Unsaved conflicting draft");
    await second.getByRole("button", { name: "Save", exact: true }).click();
    await expect(second.locator(".status")).toContainText('Saved "Rewrite clearer".');
    await expect(second.getByLabel("ID", { exact: true })).toHaveValue("rewrite-clearer-2");
    expect((await readTemplates(second)).find((item) => item.id === "rewrite-clearer-2")?.body).toBe("Unsaved conflicting draft");

    for (const tab of [first, second]) {
      await tab.getByRole("button", { name: "New", exact: true }).click();
      await tab.getByLabel("Title").fill("Concurrent new");
      await tab.getByLabel("Body").fill("Concurrent body");
    }
    await Promise.all([first, second].map((tab) => tab.getByRole("button", { name: "Save", exact: true }).click()));
    for (const tab of [first, second]) {
      await expect(tab.locator(".status")).toContainText('Saved "Concurrent new".');
    }
    expect((await readTemplates(first)).filter((item) => item.title === "Concurrent new").map((item) => item.id).sort())
      .toEqual(["concurrent-new", "concurrent-new-2"]);

    for (const tab of [first, second]) {
      await tab.getByRole("button", { name: /Draft reply/ }).click();
    }
    await second.getByLabel("Body").fill("Keep this deleted template draft");
    first.once("dialog", (dialog) => void dialog.accept());
    await first.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(first.locator(".status")).toContainText('Deleted "Draft reply".');
    await expect(second.locator(".status.error")).toContainText("deleted");
    await expect(second.getByLabel("Body")).toHaveValue("Keep this deleted template draft");
    await second.getByRole("button", { name: "Save", exact: true }).click();
    await expect(second.locator(".status.error")).toContainText("deleted");
    expect((await readTemplates(second)).some((item) => item.id === "draft-reply")).toBe(false);
  } finally {
    await app.context.close();
  }
});

test("usage updates preserve pending Options drafts and survive the next save", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-usage-save"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const before = (await readTemplates(options)).find((item) => item.id === "rewrite-clearer")!;
    await options.getByRole("button", { name: /Rewrite clearer/ }).click();
    await options.getByLabel("Body").fill("My pending rewrite for {{text}}");
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Rewrite clearer", { text: "Usage test" });
    await expect.poll(async () => (await readTemplates(options)).find((item) => item.id === before.id)?.lastUsedAt).toBeTruthy();
    const used = (await readTemplates(options)).find((item) => item.id === before.id)!;
    expect(used.updatedAt).toBe(before.updatedAt);
    await expect(options.getByLabel("Body")).toHaveValue("My pending rewrite for {{text}}");
    await expect(options.locator(".status.error")).toHaveCount(0);
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Rewrite clearer".');
    const saved = (await readTemplates(options)).find((item) => item.id === before.id)!;
    expect(saved.body).toBe("My pending rewrite for {{text}}");
    expect(saved.lastUsedAt).toBe(used.lastUsedAt);
  } finally {
    await app.context.close();
  }
});

test("successful insertion closes immediately even if recording usage fails", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-usage-failure"));
  const worker = app.context.serviceWorkers()[0] ?? await app.context.waitForEvent("serviceworker");
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    const errors: string[] = [];
    const warnings: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("Could not record template usage")) {
        warnings.push(message.text());
      }
    });
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await worker.evaluate(() => {
      const originalSet = chrome.storage.local.set;
      (globalThis as typeof globalThis & { __restoreUsageSet?: () => void }).__restoreUsageSet = () => {
        chrome.storage.local.set = originalSet;
      };
      chrome.storage.local.set = (() => Promise.reject(new Error("Test usage failure"))) as typeof chrome.storage.local.set;
    });
    const scenarios: Array<{ title: string; values: Record<string, string>; expected: string }> = [
      { title: "Summarize page", values: {}, expected: "Summarize the key ideas from this page in concise bullets." },
      { title: "Rewrite clearer", values: { text: "One insertion" }, expected: "Rewrite the following text so it is clearer, shorter, and keeps the original meaning:\n\nOne insertion" },
    ];
    for (const scenario of scenarios) {
      await page.locator("#textarea").fill("");
      await page.locator("#textarea").focus();
      await openPromptMenu(page, page, app);
      await insertTemplateFromMenu(page, scenario.title, scenario.values);
      await expect(page.locator("#textarea")).toHaveValue(scenario.expected);
      await expect(menuPanel(page)).toHaveCount(0);
    }
    await expect.poll(() => warnings.length).toBe(2);
    expect(errors).toEqual([]);
    expect((await readTemplates(options)).every((item) => item.lastUsedAt === undefined)).toBe(true);
    await worker.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __restoreUsageSet?: () => void };
      scope.__restoreUsageSet?.();
      delete scope.__restoreUsageSet;
    });
    await page.locator("#textarea").fill("");
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect.poll(async () => (await readTemplates(options)).find((item) => item.id === "summarize-page")?.lastUsedAt).toBeTruthy();
  } finally {
    await app.context.close();
  }
});

test("menu refresh preserves search and variable focus and catches load failures", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-menu-refresh"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    const errors: string[] = [];
    let refreshWarnings = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("Could not refresh templates")) {
        refreshWarnings += 1;
      }
    });
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, "Compare options");
    const menu = menuPanel(page);
    await menu.getByLabel("option_a", { exact: true }).fill("First draft");
    await menu.getByLabel("option_b", { exact: true }).fill("Second draft");
    const active = await menu.getByLabel("option_b", { exact: true }).elementHandle();
    await options.getByRole("button", { name: /Summarize page/ }).click();
    await options.getByLabel("Body").fill("Updated summary body");
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Summarize page".');
    expect(await active!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(menu.getByLabel("option_a", { exact: true })).toHaveValue("First draft");
    await expect(menu.getByLabel("option_b", { exact: true })).toHaveValue("Second draft");
    // Updating Options moved browser focus; explicitly refocus the draft before a background-only refresh.
    await menu.getByLabel("option_b", { exact: true }).focus();
    await delayNextContentRead(page, app, "fail");
    await options.evaluate(() => chrome.runtime.sendMessage({ type: "TEMPLATES_UPDATED" }));
    await expect.poll(() => refreshWarnings).toBe(1);
    await expect(menu.getByLabel("option_b", { exact: true })).toBeFocused();
    expect(await active!.evaluate((node) => node.isConnected)).toBe(true);
    await clickMenuButton(page, "Back");
    const search = menu.locator("input.search");
    await search.fill("Summarize");
    await expect(menu.getByRole("option")).toContainText("Updated summary body");
    const searchNode = await search.elementHandle();
    await options.evaluate(() => chrome.runtime.sendMessage({ type: "TEMPLATES_UPDATED" }));
    await expect(search).toHaveValue("Summarize");
    expect(await searchNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(errors).toEqual([]);
    await clickMenuButton(page, "Close");
    await page.evaluate(() => {
      const password = document.createElement("input");
      password.id = "password-target";
      password.type = "password";
      document.body.prepend(password);
      password.focus();
    });
    expect(await page.evaluate(detectFocusedInsertTarget)).toEqual({ hasFocusedInsertTarget: false });
    await openPromptMenu(page, page, app);
    await expectMenuText(page).toContain("Focus a text field before opening PromptCrate.");
    await clickMenuButton(page, "Close");
  } finally {
    await app.context.close();
  }
});

test("Options saves favorites through the form and preserves unsaved edits on failure", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-favorite-form"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.getByRole("button", { name: "Draft reply", exact: false }).click();
    const favorite = options.getByRole("checkbox", { name: "Favorite", exact: true });
    const saved = async () => (await readTemplates(options)).find((record) => record.id === "draft-reply");
    const originalBody = (await saved())!.body;
    await expect(options.getByRole("button", { name: /^(Unfavorite|Favorite)$/ })).toHaveCount(0);
    await favorite.check();
    await options.getByLabel("Body").fill("Draft a reply to {{message}}.\nTone: {{tone?}}");
    expect((await saved())!.isFavorite).toBe(false);
    expect((await saved())!.body).toBe(originalBody);

    await options.evaluate(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((message: { type?: string }) => message.type === "MUTATE_TEMPLATES"
        ? Promise.reject(new Error("Test save failure")) : originalSend(message)) as typeof chrome.runtime.sendMessage;
      window.addEventListener("promptcrate:test-restore-save", () => {
        chrome.runtime.sendMessage = originalSend;
      }, { once: true });
    });
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status.error")).toContainText("Test save failure");
    await expect(favorite).toBeChecked();
    await expect(options.getByLabel("Body")).toHaveValue("Draft a reply to {{message}}.\nTone: {{tone?}}");
    expect((await saved())!.isFavorite).toBe(false);

    await options.evaluate(() => window.dispatchEvent(new Event("promptcrate:test-restore-save")));
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Draft reply".');
    expect((await saved())!.isFavorite).toBe(true);
    expect((await saved())!.body).toBe("Draft a reply to {{message}}.\nTone: {{tone?}}");
    await expect(options.locator(".template-row").first()).toContainText("* Draft reply");
    await options.reload();
    await expect(options.locator(".status")).toContainText("templates loaded.");
    await options.getByRole("button", { name: /Draft reply/ }).click();
    await expect(favorite).toBeChecked();
    const screenshotPath = testInfo.outputPath("options-favorite-form.png");
    await options.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach("options-favorite-form", { path: screenshotPath, contentType: "image/png" });

    await favorite.uncheck();
    expect((await saved())!.isFavorite).toBe(true);
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Draft reply".');
    expect((await saved())!.isFavorite).toBe(false);
    await options.reload();
    await expect(options.locator(".status")).toContainText("templates loaded.");
    await options.getByRole("button", { name: /Draft reply/ }).click();
    await expect(favorite).not.toBeChecked();
  } finally {
    await app.context.close();
  }
});

test("Options generates unique automatic IDs and splits Chinese tag punctuation", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-auto-ids"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const original = (await readTemplates(options)).find((record) => record.id === "summarize-page");
    for (const suffix of ["2", "3"]) {
      await options.getByRole("button", { name: "New", exact: true }).click();
      await options.getByLabel("Title", { exact: true }).fill("Summarize page");
      await options.getByLabel("Body", { exact: true }).fill(`Separate template ${suffix}`);
      await options.getByLabel("Tags", { exact: true }).fill("写作，翻译、 写作;coding；阅读, , translation");
      await options.getByRole("checkbox", { name: "Favorite", exact: true }).check();
      await options.getByRole("button", { name: "Save", exact: true }).click();
      await expect(options.locator(".status")).toContainText('Saved "Summarize page".');
      await expect(options.getByLabel("ID", { exact: true })).toHaveValue(`summarize-page-${suffix}`);
      const record = (await readTemplates(options)).find((item) => item.id === `summarize-page-${suffix}`);
      expect(record).toMatchObject({
        body: `Separate template ${suffix}`, isFavorite: true,
        tags: ["写作", "翻译", "coding", "阅读", "translation"],
      });
    }
    expect((await readTemplates(options)).find((record) => record.id === "summarize-page")).toEqual(original);
    // Clearing the ID during editing may reuse that template's own generated ID.
    await options.getByLabel("ID", { exact: true }).fill("   ");
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Summarize page".');
    await expect(options.getByLabel("ID", { exact: true })).toHaveValue("summarize-page-3");
    expect(await readTemplates(options)).toHaveLength(9);

    await options.getByRole("button", { name: "New", exact: true }).click();
    await options.getByLabel("ID", { exact: true }).fill(" summarize-page ");
    await options.getByLabel("Title", { exact: true }).fill("Explicit duplicate");
    await options.getByLabel("Body", { exact: true }).fill("Must not overwrite");
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status.error")).toContainText("Template ID already exists.");
    expect(await readTemplates(options)).toHaveLength(9);
    expect((await readTemplates(options)).find((record) => record.id === "summarize-page")).toEqual(original);

    // Non-Latin titles can fall back to the same timestamp; generated IDs still need deduplication.
    await options.evaluate(() => { Date.now = () => 1_793_318_400_000; });
    for (const suffix of ["", "-2"]) {
      await options.getByRole("button", { name: "New", exact: true }).click();
      await options.getByLabel("Title", { exact: true }).fill("翻译模板");
      await options.getByLabel("Body", { exact: true }).fill("Translate {{text}}");
      await options.getByRole("button", { name: "Save", exact: true }).click();
      await expect(options.locator(".status")).toContainText('Saved "翻译模板".');
      await expect(options.getByLabel("ID", { exact: true })).toHaveValue(`template-1793318400000${suffix}`);
    }
    await options.reload();
    await expect(options.locator(".status")).toContainText("11 templates loaded.");
    const records = await readTemplates(options);
    expect(new Set(records.map((record) => record.id)).size).toBe(11);
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

    await options.getByRole("checkbox", { name: "Favorite", exact: true }).check();
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "E2E Insert Template".');
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


test("overwrite clears a removed selection and saving afterwards creates a persisted template", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-import-removed"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.getByRole("button", { name: /Rewrite clearer/ }).click();
    const originalBody = await options.getByLabel("Body").inputValue();
    const importPath = testInfo.outputPath("replacement.json");
    await writeImportFile(importPath, [
      createTemplate("replacement", "Replacement", "Imported replacement body", ["imported"]),
    ]);
    await options.locator('input[type="file"]').setInputFiles(importPath);
    await expect(options.getByRole("button", { name: "Overwrite" })).toBeVisible();

    options.once("dialog", (dialog) => { void dialog.dismiss(); });
    await options.getByRole("button", { name: "Overwrite" }).click();
    await expect(options.getByLabel("ID")).toHaveValue("rewrite-clearer");
    await expect(options.getByLabel("Body")).toHaveValue(originalBody);
    expect(await readTemplates(options)).toHaveLength(7);
    await expect(options.getByRole("button", { name: "Overwrite" })).toBeVisible();

    options.once("dialog", (dialog) => { void dialog.accept(); });
    await options.getByRole("button", { name: "Overwrite" }).click();
    await expect(options.locator(".status")).toContainText("Imported 1 templates by overwrite.");
    await expect(options.getByRole("heading", { name: "New template" })).toBeVisible();
    for (const label of ["ID", "Title", "Body", "Tags"]) {
      await expect(options.getByLabel(label, { exact: true })).toHaveValue("");
    }
    await expect(options.getByLabel("Favorite", { exact: true })).not.toBeChecked();
    await expect(options.locator(".template-row.selected")).toHaveCount(0);

    await options.getByLabel("Title").fill("Save after overwrite");
    await options.getByLabel("Body").fill("This must not be lost");
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Save after overwrite".');
    expect(await readTemplates(options)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "replacement", body: "Imported replacement body" }),
      expect.objectContaining({ id: "save-after-overwrite", body: "This must not be lost" }),
    ]));
    await options.reload();
    await expect(options.locator(".status")).toContainText("2 templates loaded.");
    await options.getByRole("button", { name: /Save after overwrite/ }).click();
    await expect(options.getByLabel("Body")).toHaveValue("This must not be lost");
  } finally {
    await app.context.close();
  }
});

for (const mode of ["Merge", "Overwrite"] as const) {
  test(mode + " refreshes every field for the selected ID before the next save", async (
    { browserName },
    testInfo,
  ) => {
    expect(browserName).toBe("chromium");
    const app = await launchPromptCrate(testInfo.outputPath("profile-import-same-id"));
    try {
      const options = await resetExtensionStorage(app.extensionId, app.context);
      await options.getByRole("button", { name: /Rewrite clearer/ }).click();
      const imported = {
        ...createTemplate("rewrite-clearer", "Imported title", "Imported body", ["new", "tags"]),
        isFavorite: true,
      };
      const importPath = testInfo.outputPath("same-id.json");
      await writeImportFile(importPath, [imported]);
      await options.locator('input[type="file"]').setInputFiles(importPath);
      await expect(options.getByRole("button", { name: mode })).toBeVisible();
      if (mode === "Overwrite") {
        options.once("dialog", (dialog) => { void dialog.accept(); });
      }
      await options.getByRole("button", { name: mode }).click();
      await expect(options.locator(".status")).toContainText("Imported");
      await expect(options.getByRole("heading", { name: "Edit template" })).toBeVisible();
      await expect(options.getByLabel("ID")).toHaveValue(imported.id);
      await expect(options.getByLabel("Title")).toHaveValue(imported.title);
      await expect(options.getByLabel("Body")).toHaveValue(imported.body);
      await expect(options.getByLabel("Tags")).toHaveValue("new, tags");
      await expect(options.getByLabel("Favorite", { exact: true })).toBeChecked();

      await options.getByLabel("Tags").fill("edited");
      await options.getByRole("button", { name: "Save", exact: true }).click();
      await expect(options.locator(".status")).toContainText('Saved "Imported title".');
      const saved = (await readTemplates(options)).find((item) => item.id === imported.id);
      expect(saved).toMatchObject({ ...imported, tags: ["edited"], updatedAt: expect.any(String) });
      await options.reload();
      await expect(options.locator(".status")).toContainText("templates loaded.");
      await options.getByRole("button", { name: /Imported title/ }).click();
      await expect(options.getByLabel("Body")).toHaveValue(imported.body);
      await expect(options.getByLabel("Tags")).toHaveValue("edited");
    } finally {
      await app.context.close();
    }
  });
}

test("a failed import preserves the editor and pending import for retry", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-import-failure"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.getByRole("button", { name: /Rewrite clearer/ }).click();
    const before = await readTemplates(options);
    const originalBody = await options.getByLabel("Body").inputValue();
    const importPath = testInfo.outputPath("failed-import.json");
    await writeImportFile(importPath, [
      createTemplate("rewrite-clearer", "Retry title", "Retry body", []),
    ]);
    await options.locator('input[type="file"]').setInputFiles(importPath);
    await expect(options.getByRole("button", { name: "Merge" })).toBeVisible();
    await options.evaluate(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((message: { type?: string }) => message.type === "MUTATE_TEMPLATES"
        ? Promise.reject(new Error("Test storage failure")) : originalSend(message)) as typeof chrome.runtime.sendMessage;
      window.addEventListener("promptcrate:test-restore-storage", () => {
        chrome.runtime.sendMessage = originalSend;
      }, { once: true });
    });

    await options.getByRole("button", { name: "Merge" }).click();
    await expect(options.locator(".status.error")).toContainText("Test storage failure");
    await expect(options.getByRole("button", { name: "Merge" })).toBeVisible();
    await expect(options.getByLabel("ID")).toHaveValue("rewrite-clearer");
    await expect(options.getByLabel("Title")).toHaveValue("Rewrite clearer");
    await expect(options.getByLabel("Body")).toHaveValue(originalBody);
    expect(await readTemplates(options)).toEqual(before);

    await options.evaluate(() => window.dispatchEvent(new Event("promptcrate:test-restore-storage")));
    await options.getByRole("button", { name: "Merge" }).click();
    await expect(options.locator(".status")).toContainText("Imported 0 new and 1 updated templates.");
    await expect(options.getByLabel("Title")).toHaveValue("Retry title");
    await expect(options.getByLabel("Body")).toHaveValue("Retry body");
    await expect(options.getByRole("button", { name: "Merge" })).toHaveCount(0);
  } finally {
    await app.context.close();
  }
});

test("repeated opens preserve page selections, search, variable drafts, and Back/Close behavior", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-repeated-open"));
  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(staticServer.baseURL + "/fixtures/manual-inputs.html");
    await primePromptCrateContentScript(page, app);
    const summary = "Summarize the key ideas from this page in concise bullets.";

    for (const selector of ["#textarea", "#text-input", "#shadow-input"]) {
      const target = page.locator(selector);
      await target.evaluate((element) => {
        const input = element as HTMLInputElement | HTMLTextAreaElement;
        input.value = "Before REPLACE after";
        input.focus();
        input.setSelectionRange(7, 14);
      });
      await openPromptMenu(page, page, app);
      await fillMenuSearch(page, "Summarize");
      await repeatOpenViaRuntime(page, app, "OPEN_PROMPT_MENU");
      await repeatOpenViaRuntime(page, app, "REOPEN_MENU");
      await expect(menuPanel(page).locator("input.search")).toHaveValue("Summarize");
      await insertTemplateFromMenu(page, "Summarize page");
      await expect(target).toHaveValue("Before " + summary + " after");
    }

    const target = page.locator("#textarea");
    await target.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.value = "Before REPLACE after";
      input.focus();
      input.setSelectionRange(7, 14);
    });
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, "Rewrite clearer");
    const variable = menuPanel(page).locator(".variable-form textarea");
    await variable.fill("Preserved variable");
    await repeatOpenViaRuntime(page, app, "REOPEN_MENU");
    await repeatOpenViaRuntime(page, app, "OPEN_PROMPT_MENU");
    await expect(variable).toHaveValue("Preserved variable");
    await clickMenuButton(page, "Insert");
    await waitForMenuClosed(page);
    await expect(target).toHaveValue(
      "Before Rewrite the following text so it is clearer, shorter, and keeps the original meaning:\n\nPreserved variable after",
    );

    await target.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.value = "Back REPLACE";
      input.focus();
      input.setSelectionRange(5, 12);
    });
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, "Rewrite clearer");
    await variable.fill("Discard on Back");
    await repeatOpenViaRuntime(page, app, "OPEN_PROMPT_MENU");
    await clickMenuButton(page, "Back");
    await repeatOpenViaRuntime(page, app, "REOPEN_MENU");
    await insertTemplateFromMenu(page, "Summarize page");
    await expect(target).toHaveValue("Back " + summary);

    await target.focus();
    await openPromptMenu(page, page, app);
    await clickMenuButton(page, "Close");
    await waitForMenuClosed(page);
    await expect(target).toBeFocused();
    const nextTarget = page.locator("#text-input");
    await nextTarget.fill("New target ");
    await focusEditableAtEnd(nextTarget);
    await openPromptMenu(page, page, app);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect(nextTarget).toHaveValue("New target " + summary);
    await expect(target).toHaveValue("Back " + summary);
  } finally {
    await app.context.close();
  }
});

async function repeatOpenViaRuntime(
  page: Page,
  app: { context: BrowserContext },
  messageType: "OPEN_PROMPT_MENU" | "REOPEN_MENU",
): Promise<void> {
  const worker = app.context.serviceWorkers()[0] ?? await app.context.waitForEvent("serviceworker");
  await worker.evaluate(async ({ url, type }) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
    if (typeof tab?.id !== "number") {
      throw new Error("Fixture tab not found.");
    }
    await chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
  }, { url: page.url(), type: messageType });
}

test("coalesces opens during loading and ignores a closed menu's delayed read", async (
  { browserName },
  testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-open-loading"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(staticServer.baseURL + "/fixtures/manual-inputs.html");
    await primePromptCrateContentScript(page, app);
    const target = page.locator("#textarea");
    await target.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.value = "Before REPLACE";
      input.focus();
      input.setSelectionRange(7, 14);
    });
    await delayNextContentRead(page, app);
    await repeatOpenViaRuntime(page, app, "OPEN_PROMPT_MENU");
    await repeatOpenViaRuntime(page, app, "OPEN_PROMPT_MENU");
    await expect(page.locator("html")).toHaveAttribute("data-promptcrate-read-blocked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-promptcrate-read-count", "1");
    await page.evaluate(() => window.dispatchEvent(new Event("promptcrate:test-release-read")));
    await waitForMenu(page);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect(target).toHaveValue("Before Summarize the key ideas from this page in concise bullets.");

    await target.focus();
    await delayNextContentRead(page, app);
    await repeatOpenViaRuntime(page, app, "OPEN_PROMPT_MENU");
    await expect(page.locator("html")).toHaveAttribute("data-promptcrate-read-blocked", "true");
    await page.evaluate(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await waitForMenuClosed(page);
    const newest = createTemplate("newest", "Newest template", "Newest body", []);
    await options.evaluate(async (template) => {
      await chrome.storage.local.set({ "promptCrate.templates": [template] });
    }, newest);
    const nextTarget = page.locator("#text-input");
    await nextTarget.fill("New target ");
    await focusEditableAtEnd(nextTarget);
    await openPromptMenu(page, page, app);
    await expectMenuText(page).toContain("Newest template");

    await page.evaluate(() => window.dispatchEvent(new Event("promptcrate:test-release-read")));
    await expect(page.locator("html")).not.toHaveAttribute("data-promptcrate-read-blocked", "true");
    await expectMenuText(page).toContain("Newest template");
    await insertTemplateFromMenu(page, "Newest template");
    await expect(nextTarget).toHaveValue("New target Newest body");
    await expect(target).toHaveValue("Before Summarize the key ideas from this page in concise bullets.");

    await target.focus();
    await delayNextContentRead(page, app, "fail");
    await repeatOpenViaRuntime(page, app, "OPEN_PROMPT_MENU");
    await expectMenuText(page).toContain("Could not load templates. Close PromptCrate and try again.");
    await expectMenuText(page).toContain("Test load failure");
    await repeatOpenViaRuntime(page, app, "REOPEN_MENU");
    await expectMenuText(page).toContain("Test load failure");
    await clickMenuButton(page, "Close");
    await waitForMenuClosed(page);
    await expect(target).toBeFocused();
    await openPromptMenu(page, page, app);
    await expectMenuText(page).toContain("Newest template");
    await expect(menuPanel(page).locator(".notice.error")).toHaveCount(0);
    await clickMenuButton(page, "Close");
    await waitForMenuClosed(page);
  } finally {
    await app.context.close();
  }
});

async function delayNextContentRead(
  page: Page,
  app: { context: BrowserContext },
  mode: "delay" | "fail" = "delay",
  messageType = "READ_TEMPLATES",
): Promise<void> {
  const worker = app.context.serviceWorkers()[0] ?? await app.context.waitForEvent("serviceworker");
  await worker.evaluate(async ({ url, readMode, readMessageType }) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
    if (typeof tab?.id !== "number") {
      throw new Error("Fixture tab not found.");
    }
    // Install the gate in the content script's isolated world, not the page world.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (readMode: "delay" | "fail", readMessageType: string) => {
        const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        if (readMode === "fail") {
          chrome.runtime.sendMessage = ((message: { type?: string }) => {
            if (message.type !== readMessageType) {
              return originalSend(message);
            }
            chrome.runtime.sendMessage = originalSend;
            return Promise.reject(new Error("Test load failure"));
          }) as typeof chrome.runtime.sendMessage;
          return;
        }
        let first = true;
        let readCount = 0;
        document.documentElement.removeAttribute("data-promptcrate-read-blocked");
        document.documentElement.setAttribute("data-promptcrate-read-count", "0");
        chrome.runtime.sendMessage = (async (message: { type?: string }) => {
          if (message.type !== readMessageType) {
            return originalSend(message);
          }
          readCount += 1;
          document.documentElement.setAttribute("data-promptcrate-read-count", String(readCount));
          const shouldDelay = first;
          first = false;
          const result = await originalSend(message);
          if (shouldDelay) {
            await new Promise<void>((resolve) => {
              window.addEventListener("promptcrate:test-release-read", () => {
                chrome.runtime.sendMessage = originalSend;
                document.documentElement.removeAttribute("data-promptcrate-read-blocked");
                resolve();
              }, { once: true });
              document.documentElement.setAttribute("data-promptcrate-read-blocked", "true");
            });
          }
          return result;
        }) as typeof chrome.runtime.sendMessage;
      },
      args: [readMode, readMessageType],
    });
  }, { url: page.url(), readMode: mode, readMessageType: messageType });
}

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

test("menu keyboard and editing events stay inside the menu", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-event-isolation"));
  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await page.evaluate(() => {
      document.body.dataset.menuEvents = "[]";
      for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input"]) {
        document.addEventListener(type, (event) => {
          const events = JSON.parse(document.body.dataset.menuEvents ?? "[]") as string[];
          events.push(event.type);
          document.body.dataset.menuEvents = JSON.stringify(events);
        });
      }
    });

    const menu = menuPanel(page);
    await menu.locator("input.search").pressSequentially("Rewrite");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await menu.locator(".variable-form textarea").pressSequentially("A draft");
    await expect(menu.locator(".preview")).toContainText("A draft");
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("button", { name: "Back", exact: true })).toBeFocused();
    await page.keyboard.down("Escape");
    await waitForMenuClosed(page);
    expect(await page.locator("body").getAttribute("data-menu-events")).toBe("[]");
    await page.keyboard.up("Escape");
    await expect(page.locator("#textarea")).toHaveValue("");

    // Closing the menu restores normal keyboard/input delivery to the page.
    await page.locator("#textarea").pressSequentially("x");
    await expect(page.locator("#textarea")).toHaveValue("x");
    expect(JSON.parse(await page.locator("body").getAttribute("data-menu-events") ?? "[]"))
      .toEqual(expect.arrayContaining(["keydown", "keyup", "keypress", "beforeinput", "input"]));
  } finally {
    await app.context.close();
  }
});

test("IME composition preserves the search field and ignores candidate confirmation keys", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-ime"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const templates = [
      createTemplate("translate", "翻译", "Translate this text", []),
      createTemplate("other", "Other", "Another template", []),
    ];
    await options.evaluate((records) => chrome.storage.local.set({ "promptCrate.templates": records }), templates);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    const menu = menuPanel(page);
    const search = menu.locator("input.search");
    const originalSearch = await search.elementHandle();
    const cdp = await app.context.newCDPSession(page);

    for (const text of ["f", "fa"]) {
      await cdp.send("Input.imeSetComposition", {
        text, selectionStart: text.length, selectionEnd: text.length,
      });
      expect(await originalSearch!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(search).toHaveValue(text);
      await expect(menu.getByRole("option")).toHaveCount(2);
    }
    for (const key of ["ArrowDown", "Enter", "Escape"]) {
      await search.dispatchEvent("keydown", { key, bubbles: true, composed: true, isComposing: true });
    }
    await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#textarea")).toHaveValue("");
    await expect(search).toBeFocused();

    await cdp.send("Input.insertText", { text: "翻译" });
    await expect(search).toHaveValue("翻译");
    await expect(menu.getByRole("option")).toHaveCount(1);
    expect(await originalSearch!.evaluate((node) => node.isConnected)).toBe(true);
    // Some IMEs report the confirmation event only through the legacy keyCode.
    await search.dispatchEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, composed: true });
    await expect(search).toBeVisible();
    await expect(page.locator("#textarea")).toHaveValue("");
    await page.keyboard.press("Enter");
    await waitForMenuClosed(page);
    await expect(page.locator("#textarea")).toHaveValue("Translate this text");
    await cdp.detach();
  } finally {
    await app.context.close();
  }
});

test("keyboard navigation keeps selected results visible without rebuilding or losing focus", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-list-navigation"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const templates = Array.from({ length: 20 }, (_, index) =>
      createTemplate(`item-${index}`, `Item ${String(index).padStart(2, "0")}`, `Body ${index}`, []));
    await options.evaluate((records) => chrome.storage.local.set({ "promptCrate.templates": records }), templates);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    const menu = menuPanel(page);
    const search = menu.locator("input.search");
    const list = menu.getByRole("listbox");
    const originalList = await list.elementHandle();
    const originalOption = await menu.getByRole("option").first().elementHandle();

    // Keyboard scrolling must keep working with the pointer resting over a row.
    await menu.getByRole("option").first().hover();
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("ArrowDown");
    }
    const selected = menu.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toContainText("Item 12");
    await expect(search).toBeFocused();
    expect(await originalList!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await originalOption!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    const expectSelectionVisible = async () => {
      await expect.poll(() => selected.evaluate((node) => {
        const itemRect = node.getBoundingClientRect();
        const listRect = node.parentElement!.getBoundingClientRect();
        return itemRect.top >= listRect.top - 1 && itemRect.bottom <= listRect.bottom + 1;
      })).toBe(true);
      await expect(search).toHaveAttribute("aria-activedescendant", await selected.getAttribute("id") ?? "");
      await expect(menu.locator(".template-item.selected")).toHaveCount(1);
    };
    await expectSelectionVisible();
    await page.keyboard.press("ArrowUp");
    await expect(selected).toContainText("Item 11");
    await expectSelectionVisible();
    await page.keyboard.press("Enter");
    await waitForMenuClosed(page);
    await expect(page.locator("#textarea")).toHaveValue("Body 11");
  } finally {
    await app.context.close();
  }
});

test("multiline variables preserve pasted text and Enter, with modifier-Enter submission", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-multiline"));
  try {
    await resetExtensionStorage(app.extensionId, app.context);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    const target = page.locator("#textarea");
    const menu = menuPanel(page);
    const stack = "TypeError: x\n    at foo (a.js:1)\n    at bar (b.js:2)";
    const prefix = "Given this error and context, identify likely root causes and the next three checks:\n\n";

    for (const shortcut of ["Control+Enter", "Meta+Enter"]) {
      await target.fill("");
      await target.focus();
      await openPromptMenu(page, page, app);
      await chooseTemplateFromMenu(page, "Debug helper");
      const input = menu.getByLabel("error", { exact: true });
      await expect(input).toBeFocused();
      await input.fill(stack);
      await input.press("End");
      await input.press("Enter");
      await input.pressSequentially("Next check");
      const value = `${stack}\nNext check`;
      await expect(input).toHaveValue(value);
      await expect(target).toHaveValue("");
      await expect(menu.locator(".preview")).toHaveText(prefix + value, { useInnerText: false });
      if (shortcut === "Control+Enter") {
        const screenshotPath = testInfo.outputPath("multiline-variable-form.png");
        await menu.screenshot({ path: screenshotPath });
        await testInfo.attach("multiline-variable-form", { path: screenshotPath, contentType: "image/png" });
      }
      await input.dispatchEvent("keydown", {
        key: "Enter", ctrlKey: true, isComposing: true, bubbles: true, composed: true,
      });
      await expect(input).toBeVisible();
      await expect(target).toHaveValue("");
      await input.press(shortcut);
      await waitForMenuClosed(page);
      await expect(target).toHaveValue(prefix + value);
    }
  } finally {
    await app.context.close();
  }
});

test("literal-only escaped braces save through Options and render without a variable form", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-literal-braces"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const body = [
      "Deploy $\\{{ github.sha }}", "\\{{ user.name }}", "\\{{name}}", "{{ }}", "{{?}}",
      '\\{{ {"key": "value"} }}', '\\{{ "{{first}} {{second}}" }}',
    ].join("; ");
    const expected = [
      "Deploy ${{ github.sha }}", "{{ user.name }}", "{{name}}", "{{ }}", "{{?}}",
      '{{ {"key": "value"} }}', '{{ "{{first}} {{second}}" }}',
    ].join("; ");
    await options.getByRole("button", { name: "New", exact: true }).click();
    await options.getByLabel("ID", { exact: true }).fill("literal-braces");
    await options.getByLabel("Title", { exact: true }).fill("Literal braces");
    await options.getByLabel("Body", { exact: true }).fill(body);
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.locator(".status")).toContainText('Saved "Literal braces".');
    await options.reload();
    await expect(options.locator(".status")).toContainText("templates loaded.");
    expect((await readTemplates(options)).find((record) => record.id === "literal-braces")?.body).toBe(body);

    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, "Literal braces");
    await expect(menuPanel(page).locator(".variable-form")).toHaveCount(0);
    await waitForMenuClosed(page);
    await expect(page.locator("#textarea")).toHaveValue(expected);
  } finally {
    await app.context.close();
  }
});

test("duplicate variable requirements and optional preview match the inserted text", async (
  { browserName }, testInfo,
) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-variable-consistency"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const body = "A {{x?}} B {{x}} C {{note?}} D \\{{ user.name }} E {{constructor?}}";
    await options.evaluate((record) => chrome.storage.local.set({ "promptCrate.templates": [record] }),
      createTemplate("mixed-variables", "Mixed variables", body, []));
    const page = await app.context.newPage();
    await page.setViewportSize({ width: 800, height: 480 });
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, "Mixed variables");
    const menu = menuPanel(page);
    const required = menu.getByLabel("x", { exact: true });
    const optional = menu.getByLabel("note (optional)", { exact: true });
    await expect(menu.locator(".field")).toHaveCount(3);
    expect(await menu.locator(".variable-form").evaluate((form) => form.scrollHeight > form.clientHeight)).toBe(true);
    await expect(menu.getByLabel("constructor (optional)", { exact: true })).toHaveValue("");
    await expect(required).toHaveAttribute("required", "");
    await expect(optional).not.toHaveAttribute("required");
    await expect(menu.locator(".preview")).toHaveText("A  B {{x}} C  D {{ user.name }} E ");
    await menu.getByRole("button", { name: "Insert", exact: true }).click();
    await expect(required).toBeFocused();
    await expect(page.locator("#textarea")).toHaveValue("");
    await required.fill("   ");
    await menu.getByRole("button", { name: "Insert", exact: true }).click();
    await expect(menu.locator(".notice.error")).toContainText("Fill x before inserting.");
    await expect(page.locator("#textarea")).toHaveValue("");
    await required.fill("Ready\nline");
    const expected = "A Ready\nline B Ready\nline C  D {{ user.name }} E ";
    expect(await menu.locator(".preview").textContent()).toBe(expected);
    await menu.getByRole("button", { name: "Insert", exact: true }).click();
    await waitForMenuClosed(page);
    await expect(page.locator("#textarea")).toHaveValue(expected);
  } finally {
    await app.context.close();
  }
});

test("advanced variables prefill defaults, offer enumerations, and preserve literal input", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-advanced-variables"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.evaluate((record) => chrome.storage.local.set({ "promptCrate.templates": [record] }),
      createTemplate("advanced", "Advanced variables", '{{text "待改写文本"=Hello}} / {{tone|formal|casual|friendly}} / {{note?|short|long}}', []));
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    const target = page.locator("#textarea");
    await target.focus();
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, "Advanced variables");
    const menu = menuPanel(page);
    await expect(menu.getByLabel("待改写文本", { exact: true })).toHaveValue("Hello");
    const tone = menu.getByRole("combobox", { name: "tone", exact: true });
    await expect(tone).toHaveValue("formal");
    await expect(tone.locator("option")).toHaveText(["formal", "casual", "friendly"]);
    await expect(menu.getByRole("combobox", { name: "note (optional)", exact: true })).toHaveValue("");
    await expect(menu.locator(".preview")).toHaveText("Hello / formal / ", { useInnerText: false });
    await menu.getByLabel("待改写文本", { exact: true }).fill("{{tone}}\nSecond line");
    await tone.selectOption("casual");
    const expected = "{{tone}}\nSecond line / casual / ";
    await expect(menu.locator(".preview")).toHaveText(expected, { useInnerText: false });
    await clickMenuButton(page, "Insert");
    await waitForMenuClosed(page);
    await expect(target).toHaveValue(expected);
  } finally {
    await app.context.close();
  }
});

test("builtin variables snapshot the active page and saved selection without another form", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-builtin-variables"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.evaluate((record) => chrome.storage.local.set({ "promptCrate.templates": [record] }),
      createTemplate("builtin", "Builtin snapshot", "{{@date}}|{{@time}}|{{@url}}|{{@title}}|{{@selection}}", []));
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html?builtin=1`);
    await page.evaluate(() => { document.title = "Chosen page title"; });
    const target = page.locator("#textarea");
    await target.fill("before {{tone}} after");
    await target.evaluate((element: HTMLTextAreaElement) => {
      element.focus();
      element.setSelectionRange(7, 15);
    });
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, "Builtin snapshot");
    await waitForMenuClosed(page);
    const value = await target.inputValue();
    const prefix = value.match(/^before (\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2})\|/);
    expect(prefix).not.toBeNull();
    expect(value.slice(prefix![0].length)).toBe(`${page.url()}|Chosen page title|{{tone}} after`);
    await expect(menuPanel(page).locator(".variable-form")).toHaveCount(0);
    const memory = await options.evaluate(() => chrome.storage.local.get("promptCrate.variableValues"));
    expect(memory["promptCrate.variableValues"] ?? {}).toEqual({});
  } finally {
    await app.context.close();
  }
});

test("variable memory requires opt-in and clears cached values on clear and opt-out", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-variable-memory"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    await options.evaluate((record) => chrome.storage.local.set({ "promptCrate.templates": [record] }),
      createTemplate("remember", "Remember language", "Translate to {{language=English}}", []));
    const preference = options.getByRole("checkbox", { name: "Remember variable values", exact: true });
    await expect(preference).not.toBeChecked();
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    const target = page.locator("#textarea");
    const openForm = async () => {
      await target.fill("");
      await target.focus();
      await openPromptMenu(page, page, app);
      await chooseTemplateFromMenu(page, "Remember language");
      return menuPanel(page).getByLabel("language", { exact: true });
    };
    const insert = async (value: string) => {
      await menuPanel(page).getByLabel("language", { exact: true }).fill(value);
      await clickMenuButton(page, "Insert");
      await waitForMenuClosed(page);
      await expect(target).toHaveValue(`Translate to ${value}`);
    };
    await expect(await openForm()).toHaveValue("English");
    await insert("French");
    await expect(await openForm()).toHaveValue("English");
    await clickMenuButton(page, "Close");
    // The controlled preference reflects the acknowledged asynchronous storage operation.
    await preference.click();
    await expect(preference).toBeChecked();
    await expect(preference).toBeEnabled();
    await openForm();
    await insert("Japanese");
    await expect(await openForm()).toHaveValue("Japanese");
    await clickMenuButton(page, "Close");
    await options.getByRole("button", { name: "Clear remembered values", exact: true }).click();
    await expect(preference).toBeEnabled();
    await expect(preference).toBeChecked();
    await expect(await openForm()).toHaveValue("English");
    await insert("Chinese");
    await expect(await openForm()).toHaveValue("Chinese");
    await clickMenuButton(page, "Close");
    await preference.click();
    await expect(preference).not.toBeChecked();
    await expect(preference).toBeEnabled();
    await expect(await openForm()).toHaveValue("English");
    const memory = await options.evaluate(() => chrome.storage.local.get("promptCrate.variableValues"));
    expect(memory["promptCrate.variableValues"]).toEqual({});
  } finally {
    await app.context.close();
  }
});

test("language switching translates open drafts and initializes only new libraries in Chinese", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-language-switch"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const original = createTemplate("custom", "My own English title", "Rewrite {{text}}", ["mine"]);
    await options.evaluate((record) => chrome.storage.local.set({ "promptCrate.templates": [record] }), original);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await chooseTemplateFromMenu(page, original.title);
    const menu = menuPanel(page);
    await menu.getByLabel("text", { exact: true }).fill("Keep my unfinished draft");
    await options.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh_CN");
    await expect(options.getByRole("combobox", { name: "语言", exact: true })).toHaveValue("zh_CN");
    await expect(menu.getByRole("button", { name: "插入", exact: true })).toBeVisible();
    await expect(menu.getByLabel("text", { exact: true })).toHaveValue("Keep my unfinished draft");
    const menuScreenshot = testInfo.outputPath("chinese-variable-form.png");
    await menu.screenshot({ path: menuScreenshot });
    await testInfo.attach("chinese-variable-form", { path: menuScreenshot, contentType: "image/png" });
    const optionsScreenshot = testInfo.outputPath("chinese-options.png");
    await options.screenshot({ path: optionsScreenshot, fullPage: true });
    await testInfo.attach("chinese-options", { path: optionsScreenshot, contentType: "image/png" });
    expect(await readTemplates(options)).toEqual([original]);
    await menu.getByLabel("text", { exact: true }).fill("   ");
    await clickMenuButton(page, "插入");
    await expect(menu.getByRole("alert")).toHaveText("请先填写 text，再插入。");
    await clickMenuButton(page, "返回");
    await menu.locator("input.search").fill("not-a-template");
    await expect(menu.getByRole("status")).toHaveText("没有匹配的模板。");
    await clickMenuButton(page, "关闭");
    // Test-only reset preserves the selected language, like a fresh library initialization.
    await options.evaluate(() => chrome.storage.local.remove(["promptCrate.templates", "promptCrate.schemaVersion"]));
    await options.reload();
    await expect(options.locator(".template-row")).toHaveCount(7);
    const localized = await readTemplates(options);
    expect(localized.some((record) => record.title === "改写得更清晰")).toBe(true);
    expect(localized.some((record) => record.title === "Rewrite clearer")).toBe(false);
    await expect(options.getByRole("combobox", { name: "语言", exact: true })).toHaveValue("zh_CN");
  } finally {
    await app.context.close();
  }
});

test("delayed variable memory cannot overwrite a draft exposed by language switching", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const app = await launchPromptCrate(testInfo.outputPath("profile-memory-language-race"));
  try {
    const options = await resetExtensionStorage(app.extensionId, app.context);
    const template = createTemplate("late-memory", "Delayed memory", "{{text=Default text}}", []);
    await options.evaluate(async (record) => {
      await chrome.storage.local.set({ "promptCrate.templates": [record] });
      await chrome.runtime.sendMessage({ type: "SET_VARIABLE_MEMORY", enabled: true });
      await chrome.runtime.sendMessage({ type: "REMEMBER_VARIABLE_VALUES", templateId: record.id,
        createdAt: record.createdAt, values: { text: "Old remembered value" } });
    }, template);
    const page = await app.context.newPage();
    await page.goto(`${staticServer.baseURL}/fixtures/manual-inputs.html`);
    await page.locator("#textarea").focus();
    await openPromptMenu(page, page, app);
    await delayNextContentRead(page, app, "delay", "READ_VARIABLE_MEMORY");
    await chooseTemplateFromMenu(page, template.title);
    await expect(page.locator("html")).toHaveAttribute("data-promptcrate-read-blocked", "true");
    await options.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh_CN");
    const field = menuPanel(page).getByLabel("text", { exact: true });
    await expect(field).toHaveValue("Default text");
    await field.fill("My new draft");
    await expect(field).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new Event("promptcrate:test-release-read")));
    await expect(page.locator("html")).not.toHaveAttribute("data-promptcrate-read-blocked", "true");
    await expect(field).toHaveValue("My new draft");
    await expect(field).toBeFocused();
    await expect(menuPanel(page).locator(".preview")).toHaveText("My new draft");
    await clickMenuButton(page, "插入");
    await waitForMenuClosed(page);
    await expect.poll(async () => options.evaluate(async (record) => {
      const memory = await chrome.runtime.sendMessage({ type: "READ_VARIABLE_MEMORY", templateId: record.id, createdAt: record.createdAt });
      return memory.values;
    }, template)).toEqual({ text: "My new draft" });
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
    headless: process.env.PROMPTCRATE_E2E_HEADLESS === "1",
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
  await options.evaluate(async () => {
    await chrome.storage.local.clear();
    // Make the English fixture baseline independent of the host browser's UI language.
    await chrome.storage.local.set({ "promptCrate.language": "en" });
    // Drain any initialization triggered by clear before resetting the localized seed.
    await chrome.runtime.sendMessage({ type: "READ_TEMPLATES" });
    await chrome.storage.local.remove(["promptCrate.templates", "promptCrate.schemaVersion"]);
    await chrome.runtime.sendMessage({ type: "READ_TEMPLATES" });
  });
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

function menuPanel(scope: BrowserScope): Locator {
  return scope.locator("promptMenu=.panel");
}

const menuDebuggerSessions = new WeakMap<Page, import("@playwright/test").CDPSession>();

async function menuDebugger(scope: BrowserScope) {
  const page = "context" in scope ? scope : scope.page();
  let session = menuDebuggerSessions.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    menuDebuggerSessions.set(page, session);
  }
  return session;
}

type InspectorNode = {
  nodeId: number;
  attributes?: string[];
  children?: InspectorNode[];
  shadowRoots?: InspectorNode[];
  contentDocument?: InspectorNode;
};

async function inspectMenuRoots(scope: BrowserScope): Promise<Array<{ nodeId: number; objectId: string }>> {
  const session = await menuDebugger(scope);
  const document = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const roots: InspectorNode[] = [];
  const visit = (node: InspectorNode) => {
    const attributes = node.attributes ?? [];
    const idIndex = attributes.indexOf("id");
    if (idIndex >= 0 && attributes[idIndex + 1] === extensionHostId) {
      roots.push(...(node.shadowRoots ?? []));
    }
    for (const child of node.children ?? []) visit(child);
    if (node.contentDocument) visit(node.contentDocument);
  };
  visit(document.root);
  const resolved: Array<{ nodeId: number; objectId: string }> = [];
  for (const root of roots) {
    const { object } = await session.send("DOM.resolveNode", { nodeId: root.nodeId });
    if (object.objectId) resolved.push({ nodeId: root.nodeId, objectId: object.objectId });
  }
  return resolved;
}

async function enableMenuInspection(scope: BrowserScope): Promise<void> {
  const alreadyInspected = await scope.evaluate((id) => {
    const host = document.getElementById(id);
    return host && Object.prototype.hasOwnProperty.call(host, "shadowRoot") && host.shadowRoot?.mode === "closed";
  }, extensionHostId);
  if (alreadyInspected) return;
  const session = await menuDebugger(scope);
  for (const root of await inspectMenuRoots(scope)) {
    // Test-only debugger bridge. The shipped bundle is unchanged, and privacy tests skip this bridge.
    const result = await session.send("Runtime.callFunctionOn", {
      objectId: root.objectId,
      functionDeclaration: `function() {
        const root = this;
        if (root.mode !== "closed") throw new Error("Expected the production closed menu root");
        Object.defineProperty(root.host, "shadowRoot", { configurable: true, get: function() { return root; } });
        return root.mode;
      }`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error("Could not inspect the production closed menu root.");
  }
}

async function sendMenuOpen(
  triggerPage: Page,
  menuScope: BrowserScope,
  app: { context: BrowserContext },
  type: "OPEN_PROMPT_MENU" | "REOPEN_MENU" = "OPEN_PROMPT_MENU",
): Promise<void> {
  const worker = app.context.serviceWorkers()[0] ?? await app.context.waitForEvent("serviceworker");
  await worker.evaluate(async ({ url, frameUrl, type }) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
    if (typeof tab?.id !== "number") throw new Error("Fixture tab not found.");
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content-entry.js"] });
    let frameId = 0;
    if (frameUrl !== null) {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => ({ url: location.href, child: window !== window.top }),
      });
      const frame = frames.find((item) => item.result?.url === frameUrl && item.result?.child);
      if (typeof frame?.frameId !== "number") throw new Error("Fixture iframe not found.");
      frameId = frame.frameId;
    }
    await chrome.tabs.sendMessage(tab.id, { type }, { frameId });
  }, { url: triggerPage.url(), frameUrl: menuScope === triggerPage ? null : menuScope.url(), type });
}

async function openPromptMenuViaExtensionApi(
  triggerPage: Page,
  menuScope: BrowserScope,
  app: { context: BrowserContext; extensionId: string },
): Promise<void> {
  await triggerPage.bringToFront();
  await menuScope.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[data-promptcrate-e2e-focus-target="true"]');
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target.selectionStart !== null) target.setSelectionRange(target.value.length, target.value.length);
    } else if (target.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    }
  });
  await sendMenuOpen(triggerPage, menuScope, app);
  await waitForMenu(menuScope);
}

async function waitForMenu(scope: BrowserScope, timeout = 7_000): Promise<void> {
  await scope.waitForFunction((id) => {
    const host = document.getElementById(id);
    return host && host.style.display !== "none";
  }, extensionHostId, { timeout });
  await enableMenuInspection(scope);
  await menuPanel(scope).waitFor({ state: "visible", timeout });
}

async function waitForMenuClosed(scope: BrowserScope): Promise<void> {
  await scope.waitForFunction((id) => {
    const host = document.getElementById(id);
    return !host || host.style.display === "none";
  }, extensionHostId);
}

function expectMenuText(scope: BrowserScope) {
  return expect.poll(async () => (await menuPanel(scope).textContent({ timeout: 500 }).catch(() => "")) ?? "");
}

async function insertTemplateFromMenu(
  scope: BrowserScope,
  title: string,
  values: Record<string, string> = {},
): Promise<void> {
  await chooseTemplateFromMenu(scope, title);
  if (Object.keys(values).length === 0) {
    await waitForMenuClosed(scope);
    return;
  }
  for (const [name, value] of Object.entries(values)) {
    const panel = menuPanel(scope);
    await panel.getByLabel(name, { exact: true }).or(panel.getByLabel(`${name} (optional)`, { exact: true })).fill(value);
  }
  await clickMenuButton(scope, "Insert");
  await waitForMenuClosed(scope);
}

async function chooseTemplateFromMenu(scope: BrowserScope, title: string): Promise<void> {
  await fillMenuSearch(scope, title);
  await menuPanel(scope).locator(".template-title").filter({ hasText: title }).first().click();
}

async function fillMenuSearch(scope: BrowserScope, value: string): Promise<void> {
  await menuPanel(scope).locator("input.search").fill(value);
}

async function clickMenuButton(scope: BrowserScope, label: string): Promise<void> {
  await menuPanel(scope).getByRole("button", { name: label, exact: true }).click();
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
