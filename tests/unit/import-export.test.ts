import { describe, expect, it } from "vitest";
import {
  applyTemplateImport,
  parseTemplateBackup,
  parseTemplateImportJson,
  stringifyTemplateExport,
} from "../../src/shared/import-export";
import { PromptTemplate, STORAGE_SCHEMA_VERSION } from "../../src/shared/templates";

const template: PromptTemplate = {
  id: "rewrite-clearer",
  title: "Rewrite clearer",
  body: "Rewrite {{text}}.",
  tags: ["writing"],
  isFavorite: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("template import and export", () => {
  it("round-trips exported JSON", () => {
    const json = stringifyTemplateExport([template], "2026-06-01T00:00:00.000Z");
    const parsed = parseTemplateImportJson(json);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.payload.templates[0] : null).toEqual(template);
  });

  it("imports a handwritten array and fills only omitted metadata", () => {
    const now = "2026-11-09T00:00:00.000Z";
    const parsed = parseTemplateImportJson(JSON.stringify([
      { title: "  Rewrite clearer  ", body: "Rewrite {{text}}." },
    ]), now);
    expect(parsed).toEqual({
      ok: true,
      payload: {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        exportedAt: now,
        templates: [{ ...template, tags: [], createdAt: now, updatedAt: now }],
      },
    });
  });

  it("accepts an unversioned templates object and retains provided dates exactly", () => {
    const dated = { ...template, createdAt: "2026-06-01T00:00:00+09:00", updatedAt: "2026-06-02T03:04:05.000Z", lastUsedAt: "2026-06-03T00:00:00.000Z" };
    const exportedAt = "2026-06-04T00:00:00.000Z";
    const parsed = parseTemplateImportJson(JSON.stringify({ templates: [dated], exportedAt }), "2026-11-09T00:00:00.000Z");
    expect(parsed.ok ? parsed.payload : null).toEqual({ schemaVersion: STORAGE_SCHEMA_VERSION, exportedAt, templates: [dated] });
  });

  it("allocates stable IDs without colliding with explicit IDs later in the file", () => {
    const entries = [
      { title: "Quick reply", body: "First" },
      { title: "Quick reply", body: "Second" },
      { id: " quick-reply ", title: "Explicit", body: "Third" },
      { id: "quick-reply-2", title: "Explicit suffix", body: "Fourth" },
      { title: "中文标题", body: "第五项" },
      { title: "中文标题", body: "第六项" },
    ];
    const now = "2026-11-09T00:00:00.000Z";
    const first = parseTemplateImportJson(JSON.stringify(entries), now);
    expect(first.ok ? first.payload.templates.map((item) => item.id) : []).toEqual([
      "quick-reply-3", "quick-reply-4", "quick-reply", "quick-reply-2", "template", "template-2",
    ]);
    expect(parseTemplateImportJson(JSON.stringify(entries), now)).toEqual(first);
  });

  it("normalizes tags while retaining explicit false and supplied metadata", () => {
    const parsed = parseTemplateImportJson(JSON.stringify([{ ...template, tags: [" writing ", "writing", "", "中文"] }]));
    expect(parsed.ok ? parsed.payload.templates[0] : null).toEqual({ ...template, tags: ["writing", "中文"] });
  });

  it.each([
    { id: null }, { id: "" }, { id: "not.a.valid/id" },
    { isFavorite: "false" }, { isFavorite: null }, { tags: "writing" }, { tags: [1] },
    { createdAt: "" }, { createdAt: "yesterday" }, { updatedAt: 123 }, { updatedAt: null },
    { lastUsedAt: "not-a-date" }, { lastUsedAt: false }, { title: 1 }, { body: null },
  ])("rejects malformed explicit fields instead of filling them: %j", (fields) => {
    expect(parseTemplateImportJson(JSON.stringify([{ title: "Valid", body: "Body", ...fields }]))).toEqual({
      ok: false, error: "Template at index 1 is invalid.",
    });
  });

  it.each([null, true, 3, "text", {}, { templates: {} }])("rejects an invalid import container: %j", (value) => {
    expect(parseTemplateImportJson(JSON.stringify(value)).ok).toBe(false);
  });

  it("rejects an explicit invalid schema even when a templates array exists", () => {
    expect(parseTemplateImportJson(JSON.stringify({ schemaVersion: null, templates: [] }))).toEqual({
      ok: false, error: "Unsupported schemaVersion: null.",
    });
    expect(parseTemplateImportJson("[]").ok).toBe(true);
  });

  it("retains literal escaping and validates variable syntax in handwritten imports", () => {
    const body = String.raw`Keep \{{ user.name }} and {{tone=friendly}}`;
    const parsed = parseTemplateImportJson(JSON.stringify([{ title: "Literal", body }]));
    expect(parsed.ok ? parsed.payload.templates[0]?.body : "").toBe(body);
    expect(parseTemplateImportJson(JSON.stringify([{ title: "Invalid", body: "{{ user.name }}" }])).ok).toBe(false);
  });

  it("reports invalid JSON and unsupported schema versions", () => {
    expect(parseTemplateImportJson("{").ok).toBe(false);
    expect(
      parseTemplateImportJson(
        JSON.stringify({
          schemaVersion: STORAGE_SCHEMA_VERSION + 1,
          templates: [],
        }),
      ).ok,
    ).toBe(false);
  });

  it("rejects invalid template fields", () => {
    const parsed = parseTemplateImportJson(
      JSON.stringify({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        templates: [{ ...template, title: "" }],
      }),
    );

    expect(parsed).toEqual({
      ok: false,
      error: "Template at index 1 is invalid.",
    });
  });

  it("rejects duplicate template ids after normalization", () => {
    const parsed = parseTemplateImportJson(
      JSON.stringify({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        templates: [
          { ...template, id: "rewrite-clearer" },
          { ...template, id: " rewrite-clearer ", title: "Duplicate" },
        ],
      }),
    );

    expect(parsed).toEqual({
      ok: false,
      error: "Import file contains duplicate template id: rewrite-clearer.",
    });
  });

  it("merges imported templates and reports updates", () => {
    const result = applyTemplateImport(
      [template],
      [
        { ...template, title: "Updated" },
        { ...template, id: "new-template", title: "New" },
      ],
      "merge",
    );

    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.templates.map((item) => item.id)).toEqual([
      "rewrite-clearer",
      "new-template",
    ]);
  });

  it("overwrites the full template library", () => {
    const result = applyTemplateImport(
      [template],
      [{ ...template, id: "replacement" }],
      "overwrite",
    );

    expect(result.overwritten).toBe(true);
    expect(result.templates.map((item) => item.id)).toEqual(["replacement"]);
  });
});

describe("damaged template backup recovery", () => {
  it("salvages valid full and handwritten records while counting invalid entries and duplicate IDs", () => {
    const now = "2026-11-09T00:00:00.000Z";
    const raw = [
      template,
      null,
      { title: "Handwritten", body: "Recover me" },
      { ...template, id: " rewrite-clearer ", title: "Duplicate" },
      { title: "Broken variables", body: "{{bad.name}}" },
      { ...template, id: "invalid-date", updatedAt: "not-a-date" },
    ];
    const snapshot = structuredClone(raw);
    expect(parseTemplateBackup(raw, now)).toEqual({
      templates: [template, { ...template, id: "handwritten", title: "Handwritten", body: "Recover me", tags: [], createdAt: now, updatedAt: now }],
      skipped: 4,
    });
    expect(raw).toEqual(snapshot);
  });

  it("reserves later explicit IDs when generating recovered IDs", () => {
    expect(parseTemplateBackup([
      { title: "Rewrite clearer", body: "New" }, template,
      { title: "Rewrite clearer", body: "Another" },
    ]).templates.map((item) => item.id)).toEqual(["rewrite-clearer-2", "rewrite-clearer", "rewrite-clearer-3"]);
  });

  it("does not accept inherited required fields or copy prototype-shaped extra properties", () => {
    const inherited = Object.create({ title: "Inherited", body: "Unsafe" });
    const extra = JSON.parse('{"title":"Own","body":"Safe","__proto__":{"polluted":true},"constructor":{"polluted":true}}');
    const result = parseTemplateBackup([inherited, extra]);
    expect(result.skipped).toBe(1);
    expect(result.templates).toHaveLength(1);
    expect(Object.hasOwn(result.templates[0], "__proto__")).toBe(false);
    expect(Object.hasOwn(result.templates[0], "constructor")).toBe(false);
    expect(Object.getPrototypeOf(result.templates[0])).toBe(Object.prototype);
  });

  it.each([null, {}, "corrupt", 2])("reports a non-array backup as one unreadable value: %j", (value) => {
    expect(parseTemplateBackup(value)).toEqual({ templates: [], skipped: 1 });
  });
});
