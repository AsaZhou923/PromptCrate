import {
  detectFocusedInsertTarget,
  FrameProbeResult,
  selectPromptMenuFrameIds,
} from "./frame-targeting";
import { MESSAGE_TYPE, isRuntimeMessage } from "../shared/message-contract";
import { initializePromptCrateStorage } from "../shared/storage";

const OPEN_PROMPT_COMMAND = "open-prompt-menu";
const CONTENT_SCRIPT_FILE = "content-entry.js";

chrome.runtime.onInstalled.addListener(() => {
  void initializePromptCrateStorage().catch((error: unknown) => {
    console.error("[prompt-crate] Failed to initialize templates", error);
  });
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isRuntimeMessage(message) || message.type !== MESSAGE_TYPE.TEMPLATES_UPDATED) {
    return;
  }

  void broadcastTemplatesUpdated();
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

  const frameIds = await getPromptMenuFrameIds(tabId);
  await sendOpenPromptMenu(tabId, frameIds);
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

async function sendOpenPromptMenu(tabId: number, frameIds: number[]): Promise<void> {
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
