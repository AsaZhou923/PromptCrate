import { MESSAGE_TYPE } from "../shared/message-contract";
import {
  createDefaultTemplates,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from "../shared/templates";

const OPEN_PROMPT_COMMAND = "open-prompt-menu";
const CONTENT_SCRIPT_FILE = "content-entry.js";

chrome.runtime.onInstalled.addListener(() => {
  void initializeDefaultTemplates().catch((error: unknown) => {
    console.error("[prompt-crate] Failed to initialize templates", error);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== OPEN_PROMPT_COMMAND) {
    return;
  }

  void openPromptMenuForActiveTab();
});

async function openPromptMenuForActiveTab(): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === null) {
    console.warn("[prompt-crate] No active tab available for prompt menu");
    return;
  }

  const didInject = await injectContentScript(tabId);
  if (!didInject) {
    return;
  }

  await sendOpenPromptMenu(tabId);
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
      target: { tabId },
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

async function sendOpenPromptMenu(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPE.OPEN_PROMPT_MENU,
    });
  } catch (error: unknown) {
    console.warn(
      "[prompt-crate] Content script did not accept OPEN_PROMPT_MENU",
      getErrorMessage(error),
    );
  }
}

async function initializeDefaultTemplates(): Promise<void> {
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.schemaVersion,
    STORAGE_KEYS.templates,
  ]);
  const updates: Record<string, unknown> = {};

  if (existing[STORAGE_KEYS.schemaVersion] !== STORAGE_SCHEMA_VERSION) {
    updates[STORAGE_KEYS.schemaVersion] = STORAGE_SCHEMA_VERSION;
  }

  if (!Array.isArray(existing[STORAGE_KEYS.templates])) {
    updates[STORAGE_KEYS.templates] = createDefaultTemplates();
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
