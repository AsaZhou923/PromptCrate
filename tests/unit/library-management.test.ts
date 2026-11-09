import { describe, expect, it, vi } from "vitest";
import { createTemplateStore } from "../../src/background/template-store";
import { applyTemplateMutation, type TemplateMutation } from "../../src/shared/template-mutations";
import {
  initializePromptCrateStorage, INVALID_TEMPLATES_BACKUPS_KEY, MAX_TEMPLATE_BACKUPS,
  readLibraryMetadata, type StorageAreaLike,
} from "../../src/shared/storage";
import { type PromptTemplate, STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from "../../src/shared/templates";
import { MEMORY_ENABLED_KEY, MEMORY_VALUES_KEY } from "../../src/shared/variable-memory";

const now = "2026-11-09T00:00:00.000Z";
function template(id: string): PromptTemplate {
  return { id, title: id, body: "{{text}}", tags: [], isFavorite: false, createdAt: now, updatedAt: now };
}

class Storage implements StorageAreaLike {
  writes = 0;
  failSet = false;
  data: Record<string, unknown>;
  constructor(templates: unknown = []) {
    this.data = { [STORAGE_KEYS.templates]: templates, [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION };
  }
  async get(keys: string[]) {
    return structuredClone(Object.fromEntries(keys.map((key) => [key, this.data[key]])));
  }
  async set(updates: Record<string, unknown>) {
    if (this.failSet) throw new Error("Quota exceeded");
    this.writes += 1;
    this.data = { ...this.data, ...structuredClone(updates) };
  }
}

describe("bulk deletion and manual ordering", () => {
  it("deletes the selected snapshots atomically while retaining unrelated templates", () => {
    const [first, second, other] = [template("first"), template("second"), template("other")];
    expect(applyTemplateMutation([first, second, other], { kind: "deleteMany", previous: [first, second] }).templates)
      .toEqual([other]);
    expect(() => applyTemplateMutation([first, { ...second, title: "Newer" }, other], {
      kind: "deleteMany", previous: [first, second],
    })).toThrow("Selected templates changed");
    expect(() => applyTemplateMutation([first, other], {
      kind: "deleteMany", previous: [first, second],
    })).toThrow("Selected templates changed");
  });

  it("preserves current usage when applying a valid order without changing editing metadata", () => {
    const first = template("first");
    const second = template("second");
    const used = { ...first, lastUsedAt: "2026-11-10T00:00:00.000Z" };
    const result = applyTemplateMutation([used, second], {
      kind: "reorder", ids: [second.id, first.id], expected: [first, second],
    }, "2026-11-11T00:00:00.000Z");
    expect(result.templates).toEqual([second, used]);
  });

  it.each([
    { ids: ["first", "first"], expected: [template("first"), template("second")] },
    { ids: ["first"], expected: [template("first"), template("second")] },
    { ids: ["first", "third"], expected: [template("first"), template("second")] },
  ])("rejects non-permutations before writing: %j", (order) => {
    expect(() => applyTemplateMutation(order.expected, { kind: "reorder", ...order })).toThrow("exactly once");
  });

  it.each(["order", "metadata", "membership"])("rejects stale reorder after a change to %s", (change) => {
    const expected = [template("first"), template("second")];
    const current = change === "order" ? [...expected].reverse()
      : change === "metadata" ? [expected[0], { ...expected[1], body: "Changed" }]
      : [...expected, template("new")];
    expect(() => applyTemplateMutation(current, { kind: "reorder", ids: ["second", "first"], expected }))
      .toThrow("before reordering");
  });

  it("rejects empty and duplicate bulk selection before initialization", async () => {
    const storage = new Storage();
    const store = createTemplateStore(storage);
    for (const previous of [[], [template("same"), template("same")]]) {
      await expect(store.mutate({ kind: "deleteMany", previous })).rejects.toThrow();
    }
    await expect(store.mutate({ kind: "reorder", ids: [3], expected: [] } as unknown as TemplateMutation)).rejects.toThrow();
    expect(storage.writes).toBe(0);
  });

  it("serializes bulk deletion and an unrelated save and removes memory in the same write", async () => {
    const first = template("first");
    const other = template("other");
    const storage = new Storage([first, other]);
    storage.data[MEMORY_ENABLED_KEY] = true;
    storage.data[MEMORY_VALUES_KEY] = {
      first: { createdAt: now, values: { text: "private" } },
      other: { createdAt: now, values: { text: "keep" } },
    };
    const store = createTemplateStore(storage);
    await Promise.all([
      store.mutate({ kind: "deleteMany", previous: [first] }),
      store.mutate({ kind: "save", previous: other, template: { ...other, title: "Edited" } }),
    ]);
    expect(await store.read()).toEqual([expect.objectContaining({ id: "other", title: "Edited" })]);
    expect(storage.data[MEMORY_VALUES_KEY]).toEqual({ other: { createdAt: now, values: { text: "keep" } } });
    expect(storage.writes).toBe(2);
  });

  it("leaves templates and remembered values intact if a bulk write fails", async () => {
    const first = template("first");
    const storage = new Storage([first]);
    storage.data[MEMORY_ENABLED_KEY] = true;
    storage.data[MEMORY_VALUES_KEY] = { first: { createdAt: now, values: { text: "private" } } };
    const before = structuredClone(storage.data);
    const store = createTemplateStore(storage);
    storage.failSet = true;
    await expect(store.mutate({ kind: "deleteMany", previous: [first] })).rejects.toThrow("Quota exceeded");
    expect(storage.data).toEqual(before);
    storage.failSet = false;
    await store.mutate({ kind: "reorder", ids: [first.id], expected: [first] });
    expect(storage.writes).toBe(0);
  });

  it("applies usage and reordering requests against the same queue", async () => {
    const first = template("first");
    const second = template("second");
    const store = createTemplateStore(new Storage([first, second]));
    await Promise.all([
      store.mutate({ kind: "touch", id: first.id }),
      store.mutate({ kind: "reorder", ids: [second.id, first.id], expected: [first, second] }),
    ]);
    expect(await store.read()).toEqual([second, { ...first, lastUsedAt: expect.any(String) }]);
  });
});

describe("corrupt template recovery and library metadata", () => {
  it.each([null, { broken: true }, "corrupt", 42])("backs up malformed non-array storage before resetting: %j", async (raw) => {
    const storage = new Storage(raw);
    await initializePromptCrateStorage(storage, now);
    expect(storage.writes).toBe(1);
    expect((await readLibraryMetadata(storage)).backups).toEqual([
      expect.objectContaining({ reason: "Stored templates are not valid PromptCrate templates.", backedUpAt: now, templates: raw }),
    ]);
    expect(storage.data[STORAGE_KEYS.templates]).toHaveLength(7);
  });

  it("retains the old single-slot backup alongside a new snapshot and deduplicates both representations", async () => {
    const storage = new Storage([{ bad: "new" }]);
    const old = { reason: "Old issue", backedUpAt: "2026-10-01T00:00:00.000Z", templates: [{ bad: "old" }] };
    storage.data[STORAGE_KEYS.invalidTemplatesBackup] = old;
    await initializePromptCrateStorage(storage, now);
    const metadata = await readLibraryMetadata(storage);
    expect(metadata.backups.map((backup) => backup.templates)).toEqual([[{ bad: "new" }], old.templates]);
    expect(metadata.backups[0].id).toBeTruthy();
    expect(storage.data[STORAGE_KEYS.invalidTemplatesBackup]).toEqual({
      id: metadata.backups[0].id,
      reason: "Stored templates are not valid PromptCrate templates.", backedUpAt: now, templates: [{ bad: "new" }],
    });
    expect(storage.data[INVALID_TEMPLATES_BACKUPS_KEY]).toEqual([metadata.backups[1]]);
    expect(await readLibraryMetadata(storage)).toEqual(metadata);
  });

  it("keeps five distinct snapshots even with identical timestamps and recurring corrupt values", async () => {
    const storage = new Storage();
    for (let index = 0; index < 7; index += 1) {
      storage.data[STORAGE_KEYS.templates] = [{ broken: index }];
      await initializePromptCrateStorage(storage, now);
    }
    const backups = (await readLibraryMetadata(storage)).backups;
    expect(backups).toHaveLength(MAX_TEMPLATE_BACKUPS);
    expect(new Set(backups.map((backup) => backup.id)).size).toBe(MAX_TEMPLATE_BACKUPS);
    expect(backups.map((backup) => backup.templates)).toEqual([6, 5, 4, 3, 2].map((broken) => [{ broken }]));
    expect(storage.data[INVALID_TEMPLATES_BACKUPS_KEY]).toHaveLength(MAX_TEMPLATE_BACKUPS - 1);
    expect((storage.data[INVALID_TEMPLATES_BACKUPS_KEY] as { templates: unknown }[]).map((backup) => backup.templates))
      .toEqual([5, 4, 3, 2].map((broken) => [{ broken }]));
    storage.data[STORAGE_KEYS.templates] = [{ broken: 4 }];
    await initializePromptCrateStorage(storage, now);
    const refreshed = (await readLibraryMetadata(storage)).backups;
    expect(refreshed.map((backup) => backup.templates))
      .toEqual([4, 6, 5, 3, 2].map((broken) => [{ broken }]));
    expect(refreshed[0].id).toBe(backups[2].id);
  });

  it("backs up a six-MiB library within the ten-MiB quota without duplicating the newest payload", async () => {
    const raw = [{ body: "x".repeat(6 * 1024 * 1024) }];
    const storage = new Storage(raw);
    const quotaBytes = 10 * 1024 * 1024;
    const writes: Record<string, unknown>[] = [];
    const set = storage.set.bind(storage);
    storage.set = async (updates) => {
      const resultingData = { ...storage.data, ...updates };
      if (JSON.stringify(resultingData).length > quotaBytes) throw new Error("Quota exceeded");
      writes.push(updates);
      await set(updates);
    };
    await initializePromptCrateStorage(storage, now);
    expect(storage.data[STORAGE_KEYS.templates]).toHaveLength(7);
    expect(writes).toHaveLength(1);
    expect(storage.data[INVALID_TEMPLATES_BACKUPS_KEY]).toEqual([]);
    const metadata = await readLibraryMetadata(storage);
    expect(metadata.backups).toEqual([expect.objectContaining({ templates: raw })]);
    expect(JSON.stringify(storage.data).length).toBeLessThan(quotaBytes);
  });

  it("prioritizes a newer legacy-only write without silently discarding it when history is full", async () => {
    const storage = new Storage();
    storage.data[INVALID_TEMPLATES_BACKUPS_KEY] = Array.from({ length: 5 }, (_, index) => ({
      id: `backup-${index}`, backedUpAt: now, reason: "History", templates: [index],
    }));
    storage.data[STORAGE_KEYS.invalidTemplatesBackup] = { backedUpAt: now, reason: "Legacy update", templates: [99] };
    expect((await readLibraryMetadata(storage)).backups.map((backup) => backup.templates))
      .toEqual([[99], [0], [1], [2], [3]]);
    expect(storage.writes).toBe(0);
  });

  it("preserves the original data and prior backup if atomic backup/reset exceeds quota", async () => {
    const storage = new Storage({ corrupted: true });
    storage.data[STORAGE_KEYS.invalidTemplatesBackup] = { reason: "Old", backedUpAt: now, templates: ["old"] };
    const before = structuredClone(storage.data);
    storage.failSet = true;
    await expect(initializePromptCrateStorage(storage, now)).rejects.toThrow("Quota exceeded");
    expect(storage.data).toEqual(before);
    const metadata = await createTemplateStore(storage).readLibraryMetadata();
    expect(metadata.backups[0].templates).toEqual(["old"]);
    expect(storage.writes).toBe(0);
  });

  it("reads byte usage and quota without initializing or mutating the library", async () => {
    const storage: StorageAreaLike = new Storage({ invalid: true });
    storage.QUOTA_BYTES = 4096;
    storage.getBytesInUse = vi.fn().mockResolvedValue(1024);
    expect(await createTemplateStore(storage).readLibraryMetadata()).toEqual({ bytesInUse: 1024, quotaBytes: 4096, backups: [] });
    expect(storage.getBytesInUse).toHaveBeenCalledExactlyOnceWith(null);
    expect((storage as Storage).writes).toBe(0);
  });

  it("reads metadata after an earlier queued mutation has committed", async () => {
    const first = template("first");
    const storage: StorageAreaLike = new Storage([first]);
    storage.getBytesInUse = vi.fn(async () => JSON.stringify((storage as Storage).data).length);
    const store = createTemplateStore(storage);
    const deletion = store.mutate({ kind: "deleteMany", previous: [first] });
    const metadata = store.readLibraryMetadata();
    await deletion;
    expect((await metadata).bytesInUse).toBe(JSON.stringify((storage as Storage).data).length);
    expect((storage as Storage).data[STORAGE_KEYS.templates]).toEqual([]);
  });

  it.each([-1, NaN, Infinity, 1.5])("rejects invalid byte usage rather than presenting it as zero: %s", async (usage) => {
    const storage: StorageAreaLike = new Storage();
    storage.getBytesInUse = vi.fn().mockResolvedValue(usage);
    await expect(readLibraryMetadata(storage)).rejects.toThrow("Invalid storage usage response.");
  });

  it("reports unavailable usage without guessing and surfaces a failed usage read", async () => {
    const storage: StorageAreaLike = new Storage();
    expect(await readLibraryMetadata(storage)).toMatchObject({ bytesInUse: null, quotaBytes: 10 * 1024 * 1024 });
    storage.getBytesInUse = vi.fn().mockRejectedValueOnce(new Error("Usage failed")).mockResolvedValue(7);
    const store = createTemplateStore(storage);
    await expect(store.readLibraryMetadata()).rejects.toThrow("Usage failed");
    expect(await store.readLibraryMetadata()).toMatchObject({ bytesInUse: 7 });
  });
});
