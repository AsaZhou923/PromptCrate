import { describe, expect, it } from "vitest";
import {
  extractTemplateVariables,
  PromptTemplate,
  renderTemplate,
  searchTemplates,
  sortTemplatesForMenu,
  validateTemplate,
} from "../../src/shared/templates";

const baseTemplate: PromptTemplate = {
  id: "rewrite-clearer",
  title: "Rewrite clearer",
  body: "Rewrite {{text}} with {{tone?}}.",
  tags: ["writing", "rewrite"],
  isFavorite: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("template variables", () => {
  it("extracts unique variables and preserves required flags", () => {
    expect(extractTemplateVariables("{{text}} {{ tone? }} {{text}}")).toEqual([
      { name: "text", required: true },
      { name: "tone", required: false },
    ]);
  });

  it("renders required and optional variables", () => {
    expect(
      renderTemplate("Hello {{name}}. {{signature?}}", {
        name: "Ada",
      }),
    ).toBe("Hello Ada. ");
  });

  it("blocks rendering when a required variable is missing", () => {
    expect(() => renderTemplate("Hello {{name}}", {})).toThrow(
      "Missing required variable: name",
    );
  });
});

describe("template validation and search", () => {
  it("validates required template fields", () => {
    expect(
      validateTemplate({
        ...baseTemplate,
        id: "",
        title: "",
        body: "",
      }).map((error) => error.field),
    ).toEqual(["id", "id", "title", "body"]);
  });

  it("searches title, body, and tags", () => {
    const templates = [
      baseTemplate,
      {
        ...baseTemplate,
        id: "debug-helper",
        title: "Debug helper",
        body: "Find root causes.",
        tags: ["coding"],
      },
    ];

    expect(searchTemplates(templates, "coding").map((template) => template.id)).toEqual([
      "debug-helper",
    ]);
    expect(searchTemplates(templates, "root causes").map((template) => template.id)).toEqual([
      "debug-helper",
    ]);
  });

  it("sorts favorites before recently used templates", () => {
    const templates = [
      {
        ...baseTemplate,
        id: "old",
        title: "Old",
        lastUsedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        ...baseTemplate,
        id: "favorite",
        title: "Favorite",
        isFavorite: true,
      },
      {
        ...baseTemplate,
        id: "recent",
        title: "Recent",
        lastUsedAt: "2026-06-03T00:00:00.000Z",
      },
    ];

    expect(sortTemplatesForMenu(templates).map((template) => template.id)).toEqual([
      "favorite",
      "recent",
      "old",
    ]);
  });
});

