import {
  detectFocusedInsertTarget,
  FrameProbeResult,
  selectPromptMenuFrameIds,
} from "./frame-targeting";
import { MESSAGE_TYPE, isRuntimeMessage } from "../shared/message-contract";
import { createTemplateStore } from "./template-store";
import { isTemplateMutation } from "../shared/template-mutations";
import { isStringMap } from "../shared/variable-memory";
import { getLanguagePreference, resolveLocale, trForLocale } from "../shared/i18n";

const OPEN_PROMPT_COMMAND = "open-prompt-menu";
const CONTENT_SCRIPT_FILE = "content-entry.js";
const templateStore = createTemplateStore();
const activeOpenRequests = new Map<number, number>();
let openRequestSequence = 0;

chrome.runtime.onInstalled.addListener(() => {
  void templateStore.read().catch((error: unknown) => {
    console.error("[prompt-crate] Failed to initialize templates", error);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    return;
  }
  if (message.type === MESSAGE_TYPE.READ_TEMPLATES) {
    void templateStore.read().then((templates) => sendResponse({ ok: true, templates }))
      .catch((error: unknown) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }
  if (message.type === MESSAGE_TYPE.MUTATE_TEMPLATES) {
    const mutation = "mutation" in message ? message.mutation : undefined;
    if (!isTemplateMutation(mutation)) {
      sendResponse({ ok: false, error: "Invalid template mutation." });
      return;
    }
    void templateStore.mutate(mutation).then((result) => {
      sendResponse({ ok: true, ...result });
      // Notifications are best effort after the committed operation has been acknowledged.
      void broadcastTemplatesUpdated().catch((error: unknown) => {
        console.warn("[prompt-crate] Could not broadcast updated templates", getErrorMessage(error));
      });
    }).catch((error: unknown) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }
  if ([MESSAGE_TYPE.READ_VARIABLE_MEMORY, MESSAGE_TYPE.SET_VARIABLE_MEMORY,
    MESSAGE_TYPE.CLEAR_VARIABLE_MEMORY, MESSAGE_TYPE.REMEMBER_VARIABLE_VALUES].some((type) => type === message.type)) {
    const payload = message as unknown as Record<string, unknown>;
    const valid = message.type === MESSAGE_TYPE.READ_VARIABLE_MEMORY
      ? payload.templateId === undefined || (typeof payload.templateId === "string" && typeof payload.createdAt === "string")
      : message.type === MESSAGE_TYPE.SET_VARIABLE_MEMORY ? typeof payload.enabled === "boolean"
        : message.type === MESSAGE_TYPE.CLEAR_VARIABLE_MEMORY ||
          (typeof payload.templateId === "string" && typeof payload.createdAt === "string" && isStringMap(payload.values));
    if (!valid) {
      sendResponse({ ok: false, error: "Invalid variable memory request." });
      return;
    }
    const operation = message.type === MESSAGE_TYPE.READ_VARIABLE_MEMORY
      ? templateStore.readVariableMemory(payload.templateId as string | undefined, payload.createdAt as string | undefined)
      : message.type === MESSAGE_TYPE.SET_VARIABLE_MEMORY
        ? templateStore.setVariableMemoryEnabled(payload.enabled as boolean)
        : message.type === MESSAGE_TYPE.CLEAR_VARIABLE_MEMORY ? templateStore.clearVariableMemory()
          : templateStore.rememberVariableValues(payload.templateId as string, payload.values as Record<string, string>, payload.createdAt as string);
    void operation.then((state) => sendResponse({ ok: true, ...state }))
      .catch((error: unknown) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }
  if (message.type === MESSAGE_TYPE.TEMPLATES_UPDATED) {
    void broadcastTemplatesUpdated().catch((error: unknown) => {
      console.warn("[prompt-crate] Could not broadcast updated templates", getErrorMessage(error));
    });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== OPEN_PROMPT_COMMAND) {
    return;
  }

  void openPromptMenuForActiveTab().catch(reportActivationError);
});

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== "number") {
    console.warn("[prompt-crate] Clicked tab has no usable tab ID");
    return;
  }
  void openPromptMenuForTab(tab.id).catch(reportActivationError);
});

async function openPromptMenuForActiveTab(): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === null) {
    console.warn("[prompt-crate] No active tab available for prompt menu");
    return;
  }

  await openPromptMenuForTab(tabId);
}

async function openPromptMenuForTab(tabId: number): Promise<void> {
  const request = ++openRequestSequence;
  activeOpenRequests.set(tabId, request);
  try {
    await updateActivationFeedback(tabId, request);
    const didInject = await injectContentScript(tabId);
    if (!didInject) {
      await updateActivationFeedback(tabId, request,
        "PromptCrate could not open here. Try a regular web page, or reload the page.");
      return;
    }

    const frameIds = await getPromptMenuFrameIds(tabId);
    if (!await sendOpenPromptMenu(tabId, frameIds)) {
      await updateActivationFeedback(tabId, request,
        "PromptCrate could not reach this page. Reload it and try again.");
    }
  } finally {
    if (activeOpenRequests.get(tabId) === request) activeOpenRequests.delete(tabId);
  }
}

async function updateActivationFeedback(tabId: number, request: number, message?: string): Promise<void> {
  if (activeOpenRequests.get(tabId) !== request) return;
  try {
    const locale = resolveLocale(await getLanguagePreference().catch(() => "system"));
    if (activeOpenRequests.get(tabId) !== request) return;
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: message ? "!" : "" }),
      chrome.action.setTitle({ tabId, title: message ? trForLocale(locale, message) : "PromptCrate" }),
      ...(message ? [chrome.action.setBadgeBackgroundColor({ tabId, color: "#b33e32" })] : []),
    ]);
  } catch (error) {
    console.warn("[prompt-crate] Could not update activation feedback", getErrorMessage(error));
  }
}

function reportActivationError(error: unknown): void {
  console.warn("[prompt-crate] Could not open prompt menu", getErrorMessage(error));
}

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const tabId = tabs[0]?.id;

  return typeof tabId === "number" ? tabId : null;
}

async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    });
    return true;
  } catch (error: unknown) {
    console.warn(
      "[prompt-crate] Cannot inject content script into this page",
      getErrorMessage(error),
    );
    return false;
  }
}

async function getPromptMenuFrameIds(tabId: number): Promise<number[]> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: detectFocusedInsertTarget,
    });

    return selectPromptMenuFrameIds(results as FrameProbeResult[]);
  } catch (error: unknown) {
    console.warn(
      "[prompt-crate] Could not detect focused frame, falling back to top frame",
      getErrorMessage(error),
    );
    return [0];
  }
}

async function sendOpenPromptMenu(tabId: number, frameIds: number[]): Promise<boolean> {
  let didSend = false;

  for (const frameId of frameIds) {
    try {
      await chrome.tabs.sendMessage(
        tabId,
        {
          type: MESSAGE_TYPE.OPEN_PROMPT_MENU,
        },
        { frameId },
      );
      didSend = true;
    } catch (error: unknown) {
      console.warn(
        `[prompt-crate] Frame ${frameId} did not accept OPEN_PROMPT_MENU`,
        getErrorMessage(error),
      );
    }
  }

  if (!didSend) {
    console.warn("[prompt-crate] No frame accepted OPEN_PROMPT_MENU");
  }
  return didSend;
}

async function broadcastTemplatesUpdated(): Promise<void> {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== "number") {
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: MESSAGE_TYPE.TEMPLATES_UPDATED,
        });
      } catch {
        return;
      }
    }),
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
