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
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() } },
    action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    commands: { onCommand: { addListener: (listener: typeof command) => { command = listener; } } },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    tabs: { query, sendMessage },
    scripting: { executeScript },
  });
  await import("../../src/background/service-worker");
  return { clicked: clicked!, command: command!, query, executeScript, sendMessage, warning };
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
});
