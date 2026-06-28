import { describe, expect, it } from "vitest";
import {
  applyTemplateImport,
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
    expect(parsed.ok ? parsed.payload.templates[0]?.id : "").toBe("rewrite-clearer");
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

