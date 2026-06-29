import { describe, expect, it } from "vitest";
import { initializePromptCrateStorage, StorageAreaLike } from "../../src/shared/storage";
import { STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from "../../src/shared/templates";

class FakeStorage implements StorageAreaLike {
  data: Record<string, unknown>;

  constructor(data: Record<string, unknown> = {}) {
    this.data = data;
  }

  async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.map((key) => [key, this.data[key]]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.data = {
      ...this.data,
      ...items,
    };
  }
}

describe("storage initialization", () => {
  it("writes schema version and default templates when storage is empty", async () => {
    const storage = new FakeStorage();
    const store = await initializePromptCrateStorage(
      storage,
      "2026-06-01T00:00:00.000Z",
    );

    expect(store.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(store.templates).toHaveLength(7);
    expect(storage.data[STORAGE_KEYS.schemaVersion]).toBe(STORAGE_SCHEMA_VERSION);
    expect(storage.data[STORAGE_KEYS.templates]).toEqual(store.templates);
  });

  it("keeps valid stored templates", async () => {
    const storedTemplate = {
      id: "custom",
      title: "Custom",
      body: "Hello",
      tags: [],
      isFavorite: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const storage = new FakeStorage({
      [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
      [STORAGE_KEYS.templates]: [storedTemplate],
    });

    const store = await initializePromptCrateStorage(storage);

    expect(store.templates).toEqual([storedTemplate]);
  });

  it("resets and backs up stored templates that fail business validation", async () => {
    const invalidTemplate = {
      id: "custom",
      title: "",
      body: "Hello",
      tags: [],
      isFavorite: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const storage = new FakeStorage({
      [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
      [STORAGE_KEYS.templates]: [invalidTemplate],
    });

    const store = await initializePromptCrateStorage(
      storage,
      "2026-06-02T00:00:00.000Z",
    );

    expect(store.templates).toHaveLength(7);
    expect(storage.data[STORAGE_KEYS.templates]).toEqual(store.templates);
    expect(storage.data[STORAGE_KEYS.invalidTemplatesBackup]).toEqual({
      reason: "Template at index 1 is invalid.",
      backedUpAt: "2026-06-02T00:00:00.000Z",
      templates: [invalidTemplate],
    });
  });

  it("resets and backs up stored templates with duplicate ids", async () => {
    const storedTemplate = {
      id: "custom",
      title: "Custom",
      body: "Hello",
      tags: [],
      isFavorite: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const storage = new FakeStorage({
      [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
      [STORAGE_KEYS.templates]: [
        storedTemplate,
        { ...storedTemplate, id: " custom ", title: "Duplicate" },
      ],
    });

    const store = await initializePromptCrateStorage(
      storage,
      "2026-06-02T00:00:00.000Z",
    );

    expect(store.templates).toHaveLength(7);
    expect(storage.data[STORAGE_KEYS.invalidTemplatesBackup]).toEqual({
      reason: "Duplicate template id: custom.",
      backedUpAt: "2026-06-02T00:00:00.000Z",
      templates: [
        storedTemplate,
        { ...storedTemplate, id: " custom ", title: "Duplicate" },
      ],
    });
  });
});
