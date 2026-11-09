import { afterEach, describe, expect, it, vi } from "vitest";
import { commitTemplateMutation, loadLibraryMetadata, loadPromptTemplates } from "../../src/shared/template-client";
import { MESSAGE_TYPE } from "../../src/shared/message-contract";
import type { PromptTemplate } from "../../src/shared/templates";

const template: PromptTemplate = {
  id: "test", title: "Test", body: "Hello", tags: [], isFavorite: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("template storage client", () => {
  it("reads usage and raw recovery snapshots through the background request", async () => {
    const metadata = { bytesInUse: 2048, quotaBytes: 10485760, backups: [
      { id: "backup", reason: "Invalid data", backedUpAt: "2026-11-09T00:00:00.000Z", templates: { broken: true } },
    ] };
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, metadata });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    expect(await loadLibraryMetadata()).toEqual(metadata);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: MESSAGE_TYPE.READ_LIBRARY_METADATA });
  });

  it.each([
    undefined, { ok: true }, { ok: true, metadata: {} },
    { ok: true, metadata: { bytesInUse: -1, quotaBytes: null, backups: [] } },
    { ok: true, metadata: { bytesInUse: null, quotaBytes: 0, backups: [] } },
    { ok: true, metadata: { bytesInUse: null, quotaBytes: null, backups: [{ id: "bad" }] } },
  ])("rejects malformed library metadata: %j", async (response) => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn().mockResolvedValue(response) } });
    await expect(loadLibraryMetadata()).rejects.toThrow("Invalid response from library metadata storage.");
  });

  it("allows unknown usage and surfaces a metadata storage error", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn()
      .mockResolvedValueOnce({ ok: true, metadata: { bytesInUse: null, quotaBytes: null, backups: [] } })
      .mockResolvedValueOnce({ ok: false, error: "Metadata failed" }) } });
    expect(await loadLibraryMetadata()).toEqual({ bytesInUse: null, quotaBytes: null, backups: [] });
    await expect(loadLibraryMetadata()).rejects.toThrow("Metadata failed");
  });
  it("loads templates through the background request", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, templates: [template] });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    expect(await loadPromptTemplates()).toEqual([template]);
    expect(sendMessage).toHaveBeenCalledWith({ type: MESSAGE_TYPE.READ_TEMPLATES });
  });

  it("returns assigned IDs and import counts from successful mutations", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true, templates: [template], savedId: template.id, added: 1, updated: 0, overwritten: false,
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const mutation = { kind: "save" as const, previous: null, template };
    expect(await commitTemplateMutation(mutation)).toEqual({
      templates: [template], savedId: template.id, added: 1, updated: 0, overwritten: false,
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: MESSAGE_TYPE.MUTATE_TEMPLATES, mutation });
  });

  it("surfaces server errors and transport failures", async () => {
    const sendMessage = vi.fn().mockResolvedValueOnce({ ok: false, error: "Conflict" })
      .mockRejectedValueOnce(new Error("Disconnected"));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    await expect(loadPromptTemplates()).rejects.toThrow("Conflict");
    await expect(commitTemplateMutation({ kind: "touch", id: "test" })).rejects.toThrow("Disconnected");
  });

  it.each([
    undefined, { ok: true }, { ok: false }, { ok: true, templates: [{}] },
    { ok: true, templates: [], added: -1 }, { ok: true, templates: [], savedId: 3 },
  ])("rejects malformed responses: %j", async (response) => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn().mockResolvedValue(response) } });
    await expect(loadPromptTemplates()).rejects.toThrow("Invalid response");
  });
});
