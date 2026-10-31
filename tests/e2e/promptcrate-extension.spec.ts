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
    await page.addScriptTag({ path: path.join(repoRoot, "node_modules/react/umd/react.production.min.js") });
    await page.addScriptTag({ path: path.join(repoRoot, "node_modules/react-dom/umd/react-dom.production.min.js") });
    await page.evaluate(() => {
      const { React, ReactDOM } = window as unknown as {
        React: typeof import("react");
        ReactDOM: typeof import("react-dom/client");
      };
      const host = document.createElement("div");
      document.body.prepend(host);
      function Editor() {
        const [input, setInput] = React.useState("Before REPLACE after");
        const [textarea, setTextarea] = React.useState("Before REPLACE after");
        return React.createElement("div", null,
          React.createElement("input", {
            id: "react-input", value: input,
            onChange: (event: { target: { value: string } }) => setInput(event.target.value),
          }),
          React.createElement("textarea", {
            id: "react-textarea", value: textarea,
            onChange: (event: { target: { value: string } }) => setTextarea(event.target.value),
          }));
      }
      ReactDOM.createRoot(host).render(React.createElement(Editor, null));
    });
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
      const originalSet = chrome.storage.local.set;
      chrome.storage.local.set = (() => Promise.reject(new Error("Test save failure"))) as typeof chrome.storage.local.set;
      window.addEventListener("promptcrate:test-restore-save", () => {
        chrome.storage.local.set = originalSet;
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
      const originalSet = chrome.storage.local.set;
      chrome.storage.local.set = (() => Promise.reject(new Error("Test storage failure"))) as typeof chrome.storage.local.set;
      window.addEventListener("promptcrate:test-restore-storage", () => {
        chrome.storage.local.set = originalSet;
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
      await expect(page.locator("#" + extensionHostId + " input.search")).toHaveValue("Summarize");
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
    const variable = page.locator("#" + extensionHostId + " .variable-form textarea");
    await variable.fill("Preserved variable");
    await repeatOpenViaRuntime(page, app, "REOPEN_MENU");
    await page.evaluate(() => window.dispatchEvent(new Event("promptcrate:open-menu")));
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
    await chrome.tabs.sendMessage(tab.id, { type });
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
    await page.evaluate(() => {
      window.dispatchEvent(new Event("promptcrate:open-menu"));
      window.dispatchEvent(new Event("promptcrate:open-menu"));
    });
    await expect(page.locator("html")).toHaveAttribute("data-promptcrate-read-blocked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-promptcrate-read-count", "1");
    await page.evaluate(() => window.dispatchEvent(new Event("promptcrate:test-release-read")));
    await waitForMenu(page);
    await insertTemplateFromMenu(page, "Summarize page");
    await expect(target).toHaveValue("Before Summarize the key ideas from this page in concise bullets.");

    await target.focus();
    await delayNextContentRead(page, app);
    await page.evaluate(() => window.dispatchEvent(new Event("promptcrate:open-menu")));
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
    await page.evaluate(() => window.dispatchEvent(new Event("promptcrate:open-menu")));
    await expectMenuText(page).toContain("Could not load templates. Close PromptCrate and try again.");
    await expectMenuText(page).toContain("Test load failure");
    await repeatOpenViaRuntime(page, app, "REOPEN_MENU");
    await expectMenuText(page).toContain("Test load failure");
    await clickMenuButton(page, "Close");
    await waitForMenuClosed(page);
    await expect(target).toBeFocused();
    await openPromptMenu(page, page, app);
    await expectMenuText(page).toContain("Newest template");
    await expect(page.locator("#" + extensionHostId + " .notice.error")).toHaveCount(0);
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
): Promise<void> {
  const worker = app.context.serviceWorkers()[0] ?? await app.context.waitForEvent("serviceworker");
  await worker.evaluate(async ({ url, readMode }) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
    if (typeof tab?.id !== "number") {
      throw new Error("Fixture tab not found.");
    }
    // Install the gate in the content script's isolated world, not the page world.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (readMode: "delay" | "fail") => {
        const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
        if (readMode === "fail") {
          chrome.storage.local.get = (() => {
            chrome.storage.local.get = originalGet;
            return Promise.reject(new Error("Test load failure"));
          }) as typeof chrome.storage.local.get;
          return;
        }
        let first = true;
        let readCount = 0;
        document.documentElement.removeAttribute("data-promptcrate-read-blocked");
        document.documentElement.setAttribute("data-promptcrate-read-count", "0");
        chrome.storage.local.get = (async (keys: string[]) => {
          readCount += 1;
          document.documentElement.setAttribute("data-promptcrate-read-count", String(readCount));
          const shouldDelay = first;
          first = false;
          const result = await originalGet(keys);
          if (shouldDelay) {
            await new Promise<void>((resolve) => {
              window.addEventListener("promptcrate:test-release-read", () => {
                chrome.storage.local.get = originalGet;
                document.documentElement.removeAttribute("data-promptcrate-read-blocked");
                resolve();
              }, { once: true });
              document.documentElement.setAttribute("data-promptcrate-read-blocked", "true");
            });
          }
          return result;
        }) as typeof chrome.storage.local.get;
      },
      args: [readMode],
    });
  }, { url: page.url(), readMode: mode });
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

    const menu = page.locator(`#${extensionHostId}`);
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
    const menu = page.locator(`#${extensionHostId}`);
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
    const menu = page.locator(`#${extensionHostId}`);
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
    const menu = page.locator(`#${extensionHostId}`);
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
    await expect(page.locator(`#${extensionHostId} .variable-form`)).toHaveCount(0);
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
    const menu = page.locator(`#${extensionHostId}`);
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
  await chooseTemplateFromMenu(scope, title);

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
        const input = label?.querySelector<HTMLTextAreaElement>("textarea");

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

async function chooseTemplateFromMenu(scope: BrowserScope, title: string): Promise<void> {
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
