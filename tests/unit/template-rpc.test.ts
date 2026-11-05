import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_TYPE } from "../../src/shared/message-contract";
import { STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from "../../src/shared/templates";

type Listener = (message: unknown, sender: object, response: (value: unknown) => void) => boolean | void;

async function setupWorker() {
  vi.resetModules();
  let listener: Listener | undefined;
  let installed: (() => void) | undefined;
  let data: Record<string, unknown> = {
    [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
    [STORAGE_KEYS.templates]: [],
  };
  const set = vi.fn(async (updates: Record<string, unknown>) => {
    data = { ...data, ...structuredClone(updates) };
  });
  const query = vi.fn().mockResolvedValue([]);
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener: (callback: Listener) => { listener = callback; } },
      onInstalled: { addListener: (callback: () => void) => { installed = callback; } },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    action: { onClicked: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(async () => structuredClone(data)), set } },
    tabs: { query, sendMessage: vi.fn().mockResolvedValue(undefined) },
  });
  await import("../../src/background/service-worker");
  return { listener: listener!, installed: installed!, set, query, data: () => data };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("background template RPC", () => {
  it("keeps the response channel open until a queued read completes", async () => {
    const worker = await setupWorker();
    const response = vi.fn();
    expect(worker.listener({ type: MESSAGE_TYPE.READ_TEMPLATES }, {}, response)).toBe(true);
    await vi.waitFor(() => expect(response).toHaveBeenCalledExactlyOnceWith({ ok: true, templates: [] }));
  });

  it("rejects malformed requests without touching storage", async () => {
    const worker = await setupWorker();
    const response = vi.fn();
    worker.listener({ type: MESSAGE_TYPE.MUTATE_TEMPLATES, mutation: { kind: "save" } }, {}, response);
    expect(response).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "Invalid template mutation." });
    expect(worker.set).not.toHaveBeenCalled();
  });

  it("acknowledges a committed write even when the notification broadcast fails", async () => {
    const worker = await setupWorker();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    worker.query.mockRejectedValue(new Error("Notification failed"));
    const response = vi.fn();
    const template = {
      id: "saved", title: "Saved", body: "Hello", tags: [], isFavorite: false,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(worker.listener({
      type: MESSAGE_TYPE.MUTATE_TEMPLATES, mutation: { kind: "save", template, previous: null },
    }, {}, response)).toBe(true);
    await vi.waitFor(() => expect(response).toHaveBeenCalledOnce());
    expect(response.mock.calls[0][0]).toMatchObject({ ok: true, savedId: "saved" });
    expect(worker.data()[STORAGE_KEYS.templates]).toEqual([expect.objectContaining({ id: "saved" })]);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(response).toHaveBeenCalledOnce();
  });

  it("returns a write failure and accepts a later request", async () => {
    const worker = await setupWorker();
    worker.set.mockRejectedValueOnce(new Error("Quota exceeded"));
    const template = {
      id: "saved", title: "Saved", body: "Hello", tags: [], isFavorite: false,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const message = { type: MESSAGE_TYPE.MUTATE_TEMPLATES, mutation: { kind: "save", template, previous: null } };
    const firstResponse = vi.fn();
    worker.listener(message, {}, firstResponse);
    await vi.waitFor(() => expect(firstResponse).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "Quota exceeded" }));
    const retryResponse = vi.fn();
    worker.listener(message, {}, retryResponse);
    await vi.waitFor(() => expect(retryResponse).toHaveBeenCalledOnce());
    expect(retryResponse.mock.calls[0][0]).toMatchObject({ ok: true, savedId: "saved" });
  });
});
