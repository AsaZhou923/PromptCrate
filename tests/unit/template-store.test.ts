import { describe, expect, it } from "vitest";
import { createTemplateStore } from "../../src/background/template-store";
import {
  applyTemplateMutation,
  isTemplateMutation,
  sameTemplateRevision,
  type TemplateMutation,
} from "../../src/shared/template-mutations";
import type { StorageAreaLike } from "../../src/shared/storage";
import { type PromptTemplate, STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from "../../src/shared/templates";

function template(id: string, body = "Original"): PromptTemplate {
  return {
    id, title: id, body, tags: [], isFavorite: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeStorage implements StorageAreaLike {
  data: Record<string, unknown>;
  writes = 0;
  activeReads = 0;
  maxActiveReads = 0;
  failGet = false;
  failSet = false;

  constructor(templates?: PromptTemplate[]) {
    this.data = templates ? {
      [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
      [STORAGE_KEYS.templates]: structuredClone(templates),
    } : {};
  }

  async get(keys: string[]) {
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    const snapshot = structuredClone(Object.fromEntries(keys.map((key) => [key, this.data[key]])));
    await Promise.resolve();
    this.activeReads -= 1;
    if (this.failGet) {
      this.failGet = false;
      throw new Error("get failed");
    }
    return snapshot;
  }

  async set(updates: Record<string, unknown>) {
    await Promise.resolve();
    if (this.failSet) {
      this.failSet = false;
      throw new Error("set failed");
    }
    this.writes += 1;
    this.data = { ...this.data, ...structuredClone(updates) };
  }
}

describe("serialized template store", () => {
  it("merges concurrent edits of distinct templates against the latest collection", async () => {
    const first = template("first");
    const second = template("second");
    const storage = new FakeStorage([first, second]);
    const store = createTemplateStore(storage);
    await Promise.all([
      store.mutate({ kind: "save", previous: first, template: { ...first, body: "First edit" } }),
      store.mutate({ kind: "save", previous: second, template: { ...second, body: "Second edit" } }),
    ]);
    expect((await store.read()).map((item) => item.body)).toEqual(["First edit", "Second edit"]);
    expect(storage.maxActiveReads).toBe(1);
  });

  it("rejects a stale edit of the same template without losing the first edit", async () => {
    const previous = template("same");
    const store = createTemplateStore(new FakeStorage([previous]));
    const results = await Promise.allSettled([
      store.mutate({ kind: "save", previous, template: { ...previous, body: "Saved first" } }),
      store.mutate({ kind: "save", previous, template: { ...previous, body: "Stale edit" } }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await store.read())[0].body).toBe("Saved first");
  });

  it("deduplicates simultaneous automatically generated IDs using current storage", async () => {
    const store = createTemplateStore(new FakeStorage([]));
    const saved = await Promise.all([1, 2].map(() => store.mutate({
      kind: "save", previous: null, template: template("new"), autoId: "new",
    })));
    expect(saved.map((result) => result.savedId)).toEqual(["new", "new-2"]);
    expect(await store.read()).toHaveLength(2);
  });

  it.each(["touch-first", "save-first"])("keeps usage and content across interleaving writes: %s", async (order) => {
    const previous = template("used");
    const store = createTemplateStore(new FakeStorage([previous]));
    const save: TemplateMutation = { kind: "save", previous, template: { ...previous, body: "Edited" } };
    const touch: TemplateMutation = { kind: "touch", id: previous.id };
    const mutations = order === "touch-first" ? [touch, save] : [save, touch];
    await Promise.all(mutations.map((mutation) => store.mutate(mutation)));
    const saved = (await store.read())[0];
    expect(saved.body).toBe("Edited");
    expect(saved.lastUsedAt).toEqual(expect.any(String));
    const touchedAgain = await store.mutate(touch);
    expect(touchedAgain.templates[0].updatedAt).toBe(saved.updatedAt);
  });

  it("does not resurrect a deleted template when its usage request arrives later", async () => {
    const previous = template("removed");
    const storage = new FakeStorage([previous]);
    const store = createTemplateStore(storage);
    await store.mutate({ kind: "delete", previous });
    const writes = storage.writes;
    await store.mutate({ kind: "touch", id: previous.id });
    expect(await store.read()).toEqual([]);
    expect(storage.writes).toBe(writes);
    await expect(store.mutate({ kind: "save", previous, template: previous })).rejects.toThrow("deleted");
  });

  it("serializes initial reads and new saves so initialization cannot erase a new template", async () => {
    const storage = new FakeStorage();
    const store = createTemplateStore(storage);
    await Promise.all([store.read(), store.mutate({ kind: "save", previous: null, template: template("custom") })]);
    expect(await store.read()).toHaveLength(8);
    expect((await store.read()).some((item) => item.id === "custom")).toBe(true);
    expect(storage.maxActiveReads).toBe(1);
  });

  it.each(["get", "set"])("recovers the queue after a failed %s", async (operation) => {
    const storage = new FakeStorage([]);
    const store = createTemplateStore(storage);
    storage[operation === "get" ? "failGet" : "failSet"] = true;
    await expect(store.mutate({ kind: "save", previous: null, template: template("failed") })).rejects.toThrow(`${operation} failed`);
    await store.mutate({ kind: "save", previous: null, template: template("later") });
    expect((await store.read()).map((item) => item.id)).toEqual(["later"]);
  });

  it("rejects malformed or invalid mutations before initialization can write", async () => {
    const storage = new FakeStorage();
    const store = createTemplateStore(storage);
    for (const mutation of [
      { kind: "save", previous: null, template: { ...template("bad"), body: "" } },
      { kind: "import", templates: [template("same"), template("same")], expected: [], mode: "overwrite" },
      { kind: "unknown" },
    ]) {
      await expect(store.mutate(mutation as TemplateMutation)).rejects.toThrow();
    }
    expect(storage.writes).toBe(0);
    expect(storage.data).toEqual({});
  });
});

describe("template mutation rules", () => {
  it("compares editing revisions independently of usage", () => {
    const previous = template("item");
    expect(sameTemplateRevision(previous, { ...previous, lastUsedAt: "2027-01-01T00:00:00.000Z" })).toBe(true);
    expect(sameTemplateRevision(previous, { ...previous, body: "Changed" })).toBe(false);
    expect(sameTemplateRevision(undefined, null)).toBe(true);
  });

  it("renames atomically and rejects an explicit collision", () => {
    const previous = template("old");
    const other = template("other");
    const renamed = applyTemplateMutation([previous, other], {
      kind: "save", previous, template: { ...previous, id: "renamed" },
    });
    expect(renamed.templates.map((item) => item.id)).toEqual(["renamed", "other"]);
    expect(() => applyTemplateMutation([previous, other], {
      kind: "save", previous, template: { ...previous, id: "other" },
    })).toThrow("Template ID already exists.");
    expect(() => applyTemplateMutation([previous], {
      kind: "save", previous: null, template: previous,
    })).toThrow("Template ID already exists.");
  });

  it("merges imports into the current list and retains unrelated additions and latest usage", () => {
    const previous = template("item");
    const current = { ...previous, lastUsedAt: "2027-01-01T00:00:00.000Z" };
    const added = template("added-elsewhere");
    const result = applyTemplateMutation([current, added], {
      kind: "import", expected: [previous], mode: "merge",
      templates: [{ ...previous, body: "Imported", lastUsedAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(result).toMatchObject({ added: 0, updated: 1, overwritten: false });
    expect(result.templates).toEqual([{ ...current, body: "Imported" }, added]);
  });

  it.each(["edited", "deleted", "colliding"])("rejects a merge whose imported ID was concurrently %s", (change) => {
    const previous = template("item");
    const expected = change === "colliding" ? [] : [previous];
    const current = change === "deleted" ? [] : [{ ...previous, body: "Newer content" }];
    expect(() => applyTemplateMutation(current, {
      kind: "import", expected, mode: "merge", templates: [previous],
    })).toThrow("Templates changed in another tab");
  });

  it("rejects overwrite after unrelated concurrent edits, but not after usage-only changes", () => {
    const previous = template("item");
    expect(() => applyTemplateMutation([previous, template("new")], {
      kind: "import", expected: [previous], templates: [template("replacement")], mode: "overwrite",
    })).toThrow("Templates changed");
    const used = { ...previous, lastUsedAt: "2027-01-01T00:00:00.000Z" };
    const result = applyTemplateMutation([used], {
      kind: "import", expected: [previous], templates: [{ ...previous, body: "Imported" }], mode: "overwrite",
    });
    expect(result.templates).toEqual([{ ...used, body: "Imported" }]);
    expect(result.overwritten).toBe(true);
  });

  it("touches usage without editing metadata or regressing a newer usage timestamp", () => {
    const previous = { ...template("item"), lastUsedAt: "2027-01-01T00:00:00.000Z" };
    const result = applyTemplateMutation([previous], { kind: "touch", id: "item" }, "2026-01-01T00:00:00.000Z");
    expect(result.templates).toEqual([previous]);
  });

  it.each([null, {}, { kind: "touch" }, { kind: "save", template: {} }, { kind: "import", templates: [], expected: [], mode: "invalid" }])(
    "rejects unsupported message payloads: %j", (value) => {
      expect(isTemplateMutation(value)).toBe(false);
    },
  );
});
