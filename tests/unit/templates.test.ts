import { describe, expect, it } from "vitest";
import {
  extractTemplateVariables,
  normalizeTemplate,
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

  it.each(["{{x?}} / {{x}}", "{{x}} / {{x?}}"])(
    "requires a duplicate variable regardless of occurrence order: %s",
    (body) => {
      expect(extractTemplateVariables(body)).toEqual([{ name: "x", required: true }]);
      expect(() => renderTemplate(body, {})).toThrow("Missing required variable: x");
      expect(() => renderTemplate(body, { x: " \n " })).toThrow("Missing required variable: x");
      expect(renderTemplate(body, { x: "filled" })).toBe("filled / filled");
    },
  );

  it("treats escaped placeholders as literal text during extraction, validation, and rendering", () => {
    const body = String.raw`Literal \{{name}}, $\{{ github.sha }}, and \{{unfilled?}}; real {{name}}`;
    expect(extractTemplateVariables(body)).toEqual([{ name: "name", required: true }]);
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    expect(renderTemplate(body, { name: "Ada" })).toBe(
      "Literal {{name}}, ${{ github.sha }}, and {{unfilled?}}; real Ada",
    );
  });

  it("renders templates containing only escaped placeholders without requiring values", () => {
    const body = String.raw`$\{{ github.sha }} \{{name}}`;
    expect(extractTemplateVariables(body)).toEqual([]);
    expect(renderTemplate(body, {})).toBe("${{ github.sha }} {{name}}");
    expect(renderTemplate(body, {}, { preview: true })).toBe(renderTemplate(body, {}));
  });

  it("removes exactly one immediately preceding escape and preserves other backslashes", () => {
    expect(renderTemplate(String.raw`\\{{name}} C:\folder\file`, {})).toBe(
      String.raw`\{{name}} C:\folder\file`,
    );
  });

  it.each([
    String.raw`\{{ {"key":"value"} }}`,
    String.raw`\{{ "{{name}}" }}`,
    String.raw`\{{ "{{first}} {{second}}" }}`,
    String.raw`\{{ "\{{inner}}" {{outer {{deep}}}} }}`,
    String.raw`\{{
  {"key": "{{first}}"}
  {{second}}
}}`,
  ])("preserves a complete escaped expression with arbitrary nested braces: %s", (literal) => {
    const body = `${literal} {{real}}`;
    expect(extractTemplateVariables(body)).toEqual([{ name: "real", required: true }]);
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    const expected = `${literal.slice(1)} filled`;
    expect(renderTemplate(body, { real: "filled" })).toBe(expected);
    expect(renderTemplate(body, { real: "filled" }, { preview: true })).toBe(expected);
  });

  it.each([
    String.raw`\{{ {"key":"value"}`,
    String.raw`\{{ "{{hidden}}"`,
    String.raw`\{{
  {{github.sha}} \{{nested}}
  {{another}}
`,
  ])("preserves an unterminated escaped expression and shields its remaining contents: %s", (literal) => {
    const body = `{{real}} ${literal}`;
    expect(extractTemplateVariables(body)).toEqual([{ name: "real", required: true }]);
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    const expected = `filled ${literal}`;
    expect(renderTemplate(body, { real: "filled" })).toBe(expected);
    expect(renderTemplate(body, { real: "filled" }, { preview: true })).toBe(expected);
  });

  it.each(["{{}}", "{{ }}", "{{?}}", "{{ ? }}"])(
    "preserves empty placeholder %s in plain and mixed templates",
    (literal) => {
      expect(extractTemplateVariables(literal)).toEqual([]);
      expect(validateTemplate({ ...baseTemplate, body: literal })).toEqual([]);
      expect(renderTemplate(literal, {})).toBe(literal);
      expect(renderTemplate(`${literal} {{name}}`, { name: "Ada" })).toBe(`${literal} Ada`);
      expect(renderTemplate(`${literal} {{name}}`, {}, { preview: true })).toBe(`${literal} {{name}}`);
    },
  );

  it("retains missing required placeholders in preview but removes empty optional values", () => {
    const body = "{{ required }} / {{optional?}} / {{blank}} / {{spaces?}}";
    const values = { blank: " \n ", spaces: "  " };
    expect(renderTemplate(body, values, { preview: true })).toBe(
      "{{ required }} /  / {{blank}} /   ",
    );
    expect(() => renderTemplate(body, values)).toThrow("Missing required variable: required");
  });

  it("makes previews and insertion match for valid Unicode variables and multiline values", () => {
    const body = String.raw`\{{literal}} {{内容}} {{語 調?}} {{内容?}} {{empty?}}`;
    const values = { 内容: "first\n  second\nthird", "語 調": " 丁寧 " };
    expect(extractTemplateVariables(body)).toEqual([
      { name: "内容", required: true },
      { name: "語 調", required: false },
      { name: "empty", required: false },
    ]);
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    const rendered = renderTemplate(body, values);
    expect(rendered).toBe("{{literal}} first\n  second\nthird  丁寧  first\n  second\nthird ");
    expect(renderTemplate(body, values, { preview: true })).toBe(rendered);
  });

  it("does not interpret supplied variable values recursively", () => {
    const values = { text: "{{unfilled}} \\{{escaped}} ${{ github.sha }}" };
    expect(renderTemplate("{{text}}", values)).toBe(values.text);
    expect(renderTemplate("{{text}}", values, { preview: true })).toBe(values.text);
  });

  it("does not use inherited object properties as variable values", () => {
    expect(() => renderTemplate("{{constructor}}", {})).toThrow(
      "Missing required variable: constructor",
    );
    expect(renderTemplate("{{toString?}}", {})).toBe("");
    expect(renderTemplate("{{constructor}}", {}, { preview: true })).toBe("{{constructor}}");
    expect(renderTemplate("{{constructor}}", { constructor: "provided" })).toBe("provided");
  });
});

describe("template validation and search", () => {
  it("normalizes metadata without trimming prompt body whitespace", () => {
    const normalized = normalizeTemplate({
      ...baseTemplate,
      id: " rewrite-clearer ",
      title: " Rewrite clearer ",
      body: "\n  Keep this spacing.  \n",
      tags: [" writing ", "writing", ""],
    });

    expect(normalized.id).toBe("rewrite-clearer");
    expect(normalized.title).toBe("Rewrite clearer");
    expect(normalized.body).toBe("\n  Keep this spacing.  \n");
    expect(normalized.tags).toEqual(["writing"]);
  });

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

  it.each(["github.sha", "name!", "name?", "💡"])(
    "still rejects unescaped nonempty invalid variable names: %s",
    (name) => {
      const body = name === "name?" ? "{{name??}}" : `{{${name}}}`;
      expect(validateTemplate({ ...baseTemplate, body })).toContainEqual({
        field: "variables",
        message: `Invalid variable name: ${name}`,
      });
    },
  );

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
