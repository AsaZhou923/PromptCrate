import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_TYPE } from "../../src/shared/message-contract";

async function setupActivation() {
  vi.resetModules();
  let clicked: ((tab: { id?: number }) => void) | undefined;
  let command: ((name: string) => void) | undefined;
  const query = vi.fn().mockResolvedValue([{ id: 91 }]);
  const executeScript = vi.fn(async (details: { files?: string[] }) => details.files
    ? []
    : [{ frameId: 6, result: { hasFocusedInsertTarget: true } }]);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  const setTitle = vi.fn().mockResolvedValue(undefined);
  const setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() } },
    action: {
      onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } },
      setBadgeText, setTitle, setBadgeBackgroundColor,
    },
    commands: { onCommand: { addListener: (listener: typeof command) => { command = listener; } } },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    tabs: { query, sendMessage },
    scripting: { executeScript },
  });
  await import("../../src/background/service-worker");
  return { clicked: clicked!, command: command!, query, executeScript, sendMessage, warning, setBadgeText, setTitle, setBadgeBackgroundColor };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prompt menu activation", () => {
  it("opens the clicked tab without querying a possibly different active tab", async () => {
    const worker = await setupActivation();
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.sendMessage).toHaveBeenCalledExactlyOnceWith(
      17, { type: MESSAGE_TYPE.OPEN_PROMPT_MENU }, { frameId: 6 },
    ));
    expect(worker.query).not.toHaveBeenCalled();
    expect(worker.executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 17, allFrames: true }, files: ["content-entry.js"],
    });
    expect(worker.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 17, allFrames: true }, func: expect.any(Function),
    });
  });

  it("uses the same injection and frame dispatch path for the keyboard command", async () => {
    const worker = await setupActivation();
    worker.command("unrelated-command");
    expect(worker.query).not.toHaveBeenCalled();
    worker.command("open-prompt-menu");
    await vi.waitFor(() => expect(worker.sendMessage).toHaveBeenCalledExactlyOnceWith(
      91, { type: MESSAGE_TYPE.OPEN_PROMPT_MENU }, { frameId: 6 },
    ));
    expect(worker.query).toHaveBeenCalledExactlyOnceWith({ active: true, currentWindow: true });
    expect(worker.executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 91, allFrames: true }, files: ["content-entry.js"],
    });
  });

  it("does not substitute another tab when the clicked tab has no ID", async () => {
    const worker = await setupActivation();
    worker.clicked({});
    expect(worker.query).not.toHaveBeenCalled();
    expect(worker.executeScript).not.toHaveBeenCalled();
    expect(worker.sendMessage).not.toHaveBeenCalled();
    expect(worker.warning).toHaveBeenCalledOnce();
  });

  it("stops after an injection failure on a restricted page", async () => {
    const worker = await setupActivation();
    worker.executeScript.mockRejectedValueOnce(new Error("Restricted page"));
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.warning).toHaveBeenCalledWith(
      "[prompt-crate] Cannot inject content script into this page", "Restricted page",
    ));
    expect(worker.executeScript).toHaveBeenCalledOnce();
    expect(worker.sendMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(worker.setBadgeText).toHaveBeenLastCalledWith({ tabId: 17, text: "!" }));
    expect(worker.setTitle).toHaveBeenLastCalledWith({ tabId: 17, title: expect.stringContaining("regular web page") });
  });

  it("falls back to the clicked tab's top frame if the probe fails", async () => {
    const worker = await setupActivation();
    worker.executeScript.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Probe failed"));
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.sendMessage).toHaveBeenCalledExactlyOnceWith(
      17, { type: MESSAGE_TYPE.OPEN_PROMPT_MENU }, { frameId: 0 },
    ));
    expect(worker.query).not.toHaveBeenCalled();
  });

  it("catches an asynchronous active-tab lookup failure at the command boundary", async () => {
    const worker = await setupActivation();
    worker.query.mockRejectedValueOnce(new Error("Window closed"));
    worker.command("open-prompt-menu");
    await vi.waitFor(() => expect(worker.warning).toHaveBeenCalledWith(
      "[prompt-crate] Could not open prompt menu", "Window closed",
    ));
    expect(worker.executeScript).not.toHaveBeenCalled();
    expect(worker.sendMessage).not.toHaveBeenCalled();
  });

  it("clears the prior failure badge and title before a successful retry", async () => {
    const worker = await setupActivation();
    worker.executeScript.mockRejectedValueOnce(new Error("Restricted page"));
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.setBadgeText).toHaveBeenLastCalledWith({ tabId: 17, text: "!" }));
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.sendMessage).toHaveBeenCalledOnce());
    expect(worker.setBadgeText).toHaveBeenLastCalledWith({ tabId: 17, text: "" });
    expect(worker.setTitle).toHaveBeenLastCalledWith({ tabId: 17, title: "PromptCrate" });
  });

  it("shows actionable feedback if no injected frame accepts the menu message", async () => {
    const worker = await setupActivation();
    worker.sendMessage.mockRejectedValue(new Error("Receiver unavailable"));
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.setBadgeText).toHaveBeenLastCalledWith({ tabId: 17, text: "!" }));
    expect(worker.setTitle).toHaveBeenLastCalledWith({ tabId: 17, title: expect.stringContaining("Reload") });
  });

  it("still opens the menu when updating the badge fails", async () => {
    const worker = await setupActivation();
    worker.setBadgeText.mockRejectedValueOnce(new Error("Badge unavailable"));
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.sendMessage).toHaveBeenCalledOnce());
    expect(worker.warning).toHaveBeenCalledWith("[prompt-crate] Could not update activation feedback", "Badge unavailable");
  });

  it("does not let an older failed activation replace newer successful feedback", async () => {
    const worker = await setupActivation();
    let rejectFirst!: (error: Error) => void;
    worker.executeScript.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.executeScript).toHaveBeenCalledOnce());
    worker.clicked({ id: 17 });
    await vi.waitFor(() => expect(worker.sendMessage).toHaveBeenCalledOnce());
    rejectFirst(new Error("Older request failed"));
    await vi.waitFor(() => expect(worker.warning).toHaveBeenCalledWith(
      "[prompt-crate] Cannot inject content script into this page", "Older request failed",
    ));
    expect(worker.setBadgeText).not.toHaveBeenCalledWith({ tabId: 17, text: "!" });
  });
});
