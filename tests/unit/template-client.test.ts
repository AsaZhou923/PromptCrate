import { afterEach, describe, expect, it, vi } from "vitest";
import { commitTemplateMutation, loadPromptTemplates } from "../../src/shared/template-client";
import { MESSAGE_TYPE } from "../../src/shared/message-contract";
import type { PromptTemplate } from "../../src/shared/templates";

const template: PromptTemplate = {
  id: "test", title: "Test", body: "Hello", tags: [], isFavorite: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("template storage client", () => {
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
