import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemplateStore } from "../../src/background/template-store";
import type { StorageAreaLike } from "../../src/shared/storage";
import { type PromptTemplate, STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from "../../src/shared/templates";
import { clearVariableMemory, loadVariableMemory, MEMORY_ENABLED_KEY, MEMORY_VALUES_KEY, rememberVariableValues, setVariableMemoryEnabled } from "../../src/shared/variable-memory";

function template(id = "one", body = "Hello {{name}}"): PromptTemplate {
  return { id, body, title: id, tags: [], isFavorite: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown>;
  writes: Record<string, unknown>[] = [];
  failSet = false;
  constructor(templates = [template()]) {
    this.data = { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION, [STORAGE_KEYS.templates]: templates };
  }
  async get(keys: string[]) {
    await Promise.resolve();
    return structuredClone(Object.fromEntries(keys.map((key) => [key, this.data[key]])));
  }
  async set(updates: Record<string, unknown>) {
    await Promise.resolve();
    if (this.failSet) { this.failSet = false; throw new Error("Quota exceeded"); }
    this.writes.push(structuredClone(updates));
    this.data = { ...this.data, ...structuredClone(updates) };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("opt-in variable memory", () => {
  it("defaults off and never writes submitted values while off", async () => {
    const storage = new MemoryStorage();
    const store = createTemplateStore(storage);
    expect(await store.readVariableMemory("one", template().createdAt)).toEqual({ enabled: false, values: {} });
    await store.rememberVariableValues("one", { name: "private" }, template().createdAt);
    expect(storage.writes).toEqual([]);
  });

  it("enables, reads per template, clears without disabling, and disables atomically", async () => {
    const storage = new MemoryStorage();
    const store = createTemplateStore(storage);
    await store.setVariableMemoryEnabled(true);
    await store.rememberVariableValues("one", { name: "Ada", unknown: "discard" }, template().createdAt);
    expect(await store.readVariableMemory("one", template().createdAt)).toEqual({ enabled: true, values: { name: "Ada" } });
    expect(await store.readVariableMemory()).toEqual({ enabled: true, values: {} });
    expect(await store.clearVariableMemory()).toEqual({ enabled: true, values: {} });
    await store.rememberVariableValues("one", { name: "Ada" }, template().createdAt);
    await store.setVariableMemoryEnabled(false);
    expect(storage.writes.at(-1)).toEqual({ [MEMORY_ENABLED_KEY]: false, [MEMORY_VALUES_KEY]: {} });
    expect(await store.readVariableMemory("one", template().createdAt)).toEqual({ enabled: false, values: {} });
  });

  it("serializes multiple template writes and queued opt-out versus late remembers", async () => {
    const storage = new MemoryStorage([template(), template("two")]);
    const store = createTemplateStore(storage);
    await store.setVariableMemoryEnabled(true);
    await Promise.all([store.rememberVariableValues("one", { name: "Ada" }, template().createdAt), store.rememberVariableValues("two", { name: "Grace" }, template().createdAt)]);
    expect((await store.readVariableMemory("one", template().createdAt)).values).toEqual({ name: "Ada" });
    expect((await store.readVariableMemory("two", template().createdAt)).values).toEqual({ name: "Grace" });
    await Promise.all([store.rememberVariableValues("one", { name: "before" }, template().createdAt), store.setVariableMemoryEnabled(false), store.rememberVariableValues("two", { name: "after" }, template().createdAt)]);
    expect(storage.data[MEMORY_VALUES_KEY]).toEqual({});
  });

  it("keeps own prototype-named variables and excludes builtins and invalid enum choices", async () => {
    const storage = new MemoryStorage([template("constructor", "{{__proto__}} {{constructor}} {{tone|brief|full}} {{@date}}")]);
    const store = createTemplateStore(storage);
    await store.setVariableMemoryEnabled(true);
    await store.rememberVariableValues("constructor", Object.fromEntries([["__proto__", "own"], ["constructor", "safe"], ["tone", "invalid"], ["@date", "ignore"]]), template().createdAt);
    expect((await store.readVariableMemory("constructor", template().createdAt)).values).toEqual(Object.fromEntries([["__proto__", "own"], ["constructor", "safe"]]));
  });

  it("cleans changed variables, enum choices, rename, and deletion in the library commit", async () => {
    const previous = template("one", "{{name}} {{tone|brief|full}}");
    const storage = new MemoryStorage([previous]);
    const store = createTemplateStore(storage);
    await store.setVariableMemoryEnabled(true);
    await store.rememberVariableValues("one", { name: "Ada", tone: "full" }, template().createdAt);
    const changed = { ...previous, body: "{{tone|brief|short}}" };
    await store.mutate({ kind: "save", previous, template: changed });
    expect(storage.writes.at(-1)).toMatchObject({ [STORAGE_KEYS.templates]: [expect.objectContaining({ body: changed.body })], [MEMORY_VALUES_KEY]: {} });
    await store.rememberVariableValues("one", { tone: "short" }, template().createdAt);
    const current = (await store.read())[0];
    await store.mutate({ kind: "save", previous: current, template: { ...current, id: "renamed" } });
    expect(storage.writes.at(-1)?.[MEMORY_VALUES_KEY]).toEqual({});
    await store.rememberVariableValues("renamed", { tone: "short" }, template().createdAt);
    await store.mutate({ kind: "delete", previous: (await store.read())[0] });
    expect(storage.writes.at(-1)?.[MEMORY_VALUES_KEY]).toEqual({});
    const writes = storage.writes.length;
    await store.rememberVariableValues("renamed", { tone: "short" }, template().createdAt);
    expect(storage.writes).toHaveLength(writes);
  });

  it("does not reuse values for a newly created template identity", async () => {
    const storage = new MemoryStorage();
    storage.data[MEMORY_ENABLED_KEY] = true;
    storage.data[MEMORY_VALUES_KEY] = { one: { createdAt: "older", values: { name: "stale" } } };
    expect(await createTemplateStore(storage).readVariableMemory("one", template().createdAt)).toEqual({ enabled: true, values: {} });
  });

  it.each(["recreate", "overwrite"])("rejects old form identities after template %s", async (mode) => {
    const previous = template();
    const replacement = { ...previous, createdAt: "2026-11-08T00:00:00.000Z" };
    const storage = new MemoryStorage([previous]);
    const store = createTemplateStore(storage);
    await store.setVariableMemoryEnabled(true);
    await store.rememberVariableValues(previous.id, { name: "old" }, previous.createdAt);
    if (mode === "recreate") {
      await store.mutate({ kind: "delete", previous });
      await store.mutate({ kind: "save", previous: null, template: replacement });
    } else {
      await store.mutate({ kind: "import", expected: [previous], templates: [replacement], mode: "overwrite" });
    }
    await store.rememberVariableValues(replacement.id, { name: "new" }, replacement.createdAt);
    const writes = storage.writes.length;
    expect(await store.readVariableMemory(previous.id, previous.createdAt)).toEqual({ enabled: true, values: {} });
    expect(await store.rememberVariableValues(previous.id, { name: "stale form" }, previous.createdAt))
      .toEqual({ enabled: true, values: {} });
    expect(storage.writes).toHaveLength(writes);
    expect(await store.readVariableMemory(replacement.id, replacement.createdAt))
      .toEqual({ enabled: true, values: { name: "new" } });
  });

  it("retains optional blank choices and ignores inherited submitted values", async () => {
    const storage = new MemoryStorage([template("one", "{{tone?|brief|full}} {{name?}}")]);
    const store = createTemplateStore(storage);
    await store.setVariableMemoryEnabled(true);
    const values = Object.assign(Object.create({ name: "inherited" }) as Record<string, string>, { tone: "" });
    await store.rememberVariableValues("one", values, template().createdAt);
    expect((await store.readVariableMemory("one", template().createdAt)).values).toEqual({ tone: "" });
  });

  it("uses the stored language only for defaults and clears reset cache atomically", async () => {
    const storage = new MemoryStorage();
    storage.data = { "promptCrate.language": "zh_CN", [MEMORY_ENABLED_KEY]: true,
      [MEMORY_VALUES_KEY]: { one: { createdAt: template().createdAt, values: { name: "private" } } } };
    const store = createTemplateStore(storage);
    const defaults = await store.read();
    expect(defaults[0].title).not.toBe("Summarize page");
    expect(storage.writes[0]).toMatchObject({ [MEMORY_VALUES_KEY]: {}, [STORAGE_KEYS.templates]: defaults });
    storage.data["promptCrate.language"] = "en";
    expect(await store.read()).toEqual(defaults);
    expect(storage.writes).toHaveLength(1);
  });

  it("recovers after memory failure and leaves library unchanged if atomic cleanup fails", async () => {
    const previous = template();
    const storage = new MemoryStorage([previous]);
    const store = createTemplateStore(storage);
    await store.setVariableMemoryEnabled(true);
    storage.failSet = true;
    await expect(store.rememberVariableValues("one", { name: "lost" }, template().createdAt)).rejects.toThrow("Quota");
    await store.rememberVariableValues("one", { name: "saved" }, template().createdAt);
    storage.failSet = true;
    await expect(store.mutate({ kind: "delete", previous })).rejects.toThrow("Quota");
    expect(await store.read()).toEqual([previous]);
    expect((await store.readVariableMemory("one", template().createdAt)).values).toEqual({ name: "saved" });
    await store.mutate({ kind: "delete", previous });
    expect(await store.read()).toEqual([]);
  });

  it("validates malformed input before initialization writes", async () => {
    const storage = new MemoryStorage();
    storage.data = {};
    const store = createTemplateStore(storage);
    await expect(store.setVariableMemoryEnabled("true" as unknown as boolean)).rejects.toThrow();
    await expect(store.rememberVariableValues("one", { name: 2 } as unknown as Record<string, string>, template().createdAt)).rejects.toThrow();
    await expect(store.readVariableMemory("one")).rejects.toThrow("identity");
    await expect(store.rememberVariableValues("one", {}, undefined as unknown as string)).rejects.toThrow();
    expect(storage.writes).toEqual([]);
  });
});

describe("variable memory client", () => {
  it("sends typed requests and rejects background failures or malformed responses", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, enabled: true, values: { name: "Ada" } });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    expect(await loadVariableMemory("one", template().createdAt)).toEqual({ enabled: true, values: { name: "Ada" } });
    await setVariableMemoryEnabled(true);
    await clearVariableMemory();
    await rememberVariableValues("one", { name: "Ada" }, template().createdAt);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ templateId: "one", createdAt: template().createdAt });
    expect(sendMessage.mock.calls[3][0]).toMatchObject({ templateId: "one", createdAt: template().createdAt });
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["READ_VARIABLE_MEMORY", "SET_VARIABLE_MEMORY", "CLEAR_VARIABLE_MEMORY", "REMEMBER_VARIABLE_VALUES"]);
    sendMessage.mockResolvedValueOnce({ ok: false, error: "Quota exceeded" });
    await expect(clearVariableMemory()).rejects.toThrow("Quota exceeded");
    sendMessage.mockResolvedValueOnce({ ok: true, enabled: true, values: { name: 2 } });
    await expect(loadVariableMemory()).rejects.toThrow("Invalid response");
  });
});
