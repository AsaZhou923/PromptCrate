import { describe, expect, it } from "vitest";
import {
  createDefaultTemplates,
  createTemplateSearch,
  extractTemplateVariables,
  getTemplateDefaultValues,
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

describe("localized default templates", () => {
  it("keeps the English seeds and creates valid Chinese templates with the same variable names", () => {
    const now = "2026-11-08T00:00:00.000Z";
    const english = createDefaultTemplates(now, "en");
    const chinese = createDefaultTemplates(now, "zh_CN");
    expect(english).toHaveLength(7);
    expect(english[0]).toEqual({
      id: "summarize-page",
      title: "Summarize page",
      body: "Summarize the key ideas from this page in concise bullets.",
      tags: ["summary", "reading"],
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    });
    expect(english[1].body).toBe("Rewrite the following text so it is clearer, shorter, and keeps the original meaning:\n\n{{text}}");
    expect(chinese.map((template) => template.id)).toEqual(english.map((template) => template.id));
    for (const [index, template] of chinese.entries()) {
      expect(template.title).not.toBe(english[index].title);
      expect(template.createdAt).toBe(now);
      expect(template.updatedAt).toBe(now);
      expect(template.isFavorite).toBe(false);
      expect(validateTemplate(template)).toEqual([]);
      expect(extractTemplateVariables(template.body).map((variable) => variable.name))
        .toEqual(extractTemplateVariables(english[index].body).map((variable) => variable.name));
    }
  });
});

describe("template variables", () => {
  it("extracts defaults, enum choices, optional fields, and quoted labels", () => {
    const body = '{{tone=friendly}} {{style|formal| casual |formal}} {{signature?=Regards}} {{text "要改写的文本"}} {{語 調? "語調"|丁寧|自然}}';
    expect(extractTemplateVariables(body)).toEqual([
      { name: "tone", required: true, defaultValue: "friendly" },
      { name: "style", required: true, options: ["formal", "casual"] },
      { name: "signature", required: false, defaultValue: "Regards" },
      { name: "text", required: true, label: "要改写的文本" },
      { name: "語 調", required: false, label: "語調", options: ["丁寧", "自然"] },
    ]);
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    expect(getTemplateDefaultValues(body)).toEqual({ tone: "friendly", style: "formal", signature: "Regards", text: "", "語 調": "" });
  });

  it("uses the first modifier outside a quoted label", () => {
    const body = '{{tone "Tone = A | B"=friendly|warm=kind}} {{style|a=b|c=d}}';
    expect(extractTemplateVariables(body)).toEqual([
      { name: "tone", required: true, label: "Tone = A | B", defaultValue: "friendly|warm=kind" },
      { name: "style", required: true, options: ["a=b", "c=d"] },
    ]);
    expect(renderTemplate(body, {})).toBe("friendly|warm=kind a=b");
  });

  it("decodes JSON label escapes without evaluating label text", () => {
    const body = String.raw`{{text "A \"quoted\" {label}\n\u6587"=hello}}`;
    expect(extractTemplateVariables(body)).toEqual([
      { name: "text", required: true, label: 'A "quoted" {label}\n文', defaultValue: "hello" },
    ]);
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    expect(renderTemplate(body, {})).toBe("hello");
  });

  it.each([
    ['{{text "unterminated}}', "Invalid variable label: text"],
    [String.raw`{{text "bad\q"}}`, "Invalid variable label: text"],
    ['{{text "label" suffix}}', "Invalid variable label: text"],
    ["{{tone|formal||casual}}", "Invalid variable options: tone"],
    ["{{tone|}}", "Invalid variable options: tone"],
    ["{{@unknown}}", "Unknown builtin variable: @unknown"],
    ["{{@date=today}}", "Builtin variable cannot have defaults or options: @date"],
    ["{{@date|today|tomorrow}}", "Builtin variable cannot have defaults or options: @date"],
  ])("reports malformed metadata without throwing during extraction or validation: %s", (body, message) => {
    expect(() => extractTemplateVariables(body)).not.toThrow();
    expect(validateTemplate({ ...baseTemplate, body })).toContainEqual({ field: "variables", message });
    expect(() => renderTemplate(body, {})).toThrow(message);
  });

  it("uses canonical defaults and labels for every occurrence", () => {
    const body = '{{tone?}} / {{tone "语调"=friendly}} / {{tone?}}';
    expect(extractTemplateVariables(body)).toEqual([
      { name: "tone", required: true, label: "语调", defaultValue: "friendly" },
    ]);
    expect(renderTemplate(body, {})).toBe("friendly / friendly / friendly");
    expect(renderTemplate(body, {}, { preview: true })).toBe(renderTemplate(body, {}));
    expect(() => renderTemplate(body, { tone: "" })).toThrow("Missing required variable: tone");
    expect(renderTemplate(body, { tone: "" }, { preview: true })).toBe(' / {{tone "语调"=friendly}} / ');
  });

  it.each([
    ["{{tone=a}} {{tone=b}}", "Conflicting variable default: tone"],
    ["{{tone|a|b}} {{tone|b|a}}", "Conflicting variable options: tone"],
    ['{{tone "A"}} {{tone "B"}}', "Conflicting variable label: tone"],
    ["{{tone=other}} {{tone|a|b}}", "Invalid variable default: tone"],
  ])("validates conflicting metadata: %s", (body, message) => {
    expect(() => extractTemplateVariables(body)).not.toThrow();
    expect(validateTemplate({ ...baseTemplate, body })).toContainEqual({ field: "variables", message });
    expect(() => renderTemplate(body, { tone: "a" })).toThrow(message);
  });

  it("merges compatible metadata and validates supplied enum choices", () => {
    const body = '{{tone?}} / {{tone|formal|casual|formal}} / {{tone=casual}}';
    expect(getTemplateDefaultValues(body)).toEqual({ tone: "casual" });
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    expect(renderTemplate(body, {})).toBe("casual / casual / casual");
    expect(() => renderTemplate(body, { tone: "other" })).toThrow("Invalid option for variable: tone");
    expect(renderTemplate(body, { tone: "other" }, { preview: true })).toBe(body);
    expect(() => renderTemplate(body, { tone: " " })).toThrow("Missing required variable: tone");
    expect(renderTemplate("{{tone?|formal|casual}}", {})).toBe("");
    expect(renderTemplate("{{tone?|formal|casual}}", { tone: " " })).toBe(" ");
  });

  it("recognizes builtins and uses only own context values, including empty strings", () => {
    const body = "{{@date}} {{@time}} {{@url}} {{@title}} {{@selection}}";
    expect(extractTemplateVariables(body)).toEqual([
      { name: "@date", required: true, builtin: true },
      { name: "@time", required: true, builtin: true },
      { name: "@url", required: true, builtin: true },
      { name: "@title", required: true, builtin: true },
      { name: "@selection", required: true, builtin: true },
    ]);
    expect(getTemplateDefaultValues(`${body} {{text=hello}}`)).toEqual({ text: "hello" });
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    const context = { "@date": "2026-11-08", "@time": "12:34", "@url": "https://example.com", "@title": "", "@selection": "" };
    expect(renderTemplate(body, { "@date": "override" }, { context })).toBe("2026-11-08 12:34 https://example.com  ");
    expect(renderTemplate(body, {}, { context, preview: true })).toBe(renderTemplate(body, {}, { context }));
    expect(() => renderTemplate("{{@date}}", { "@date": "override" })).toThrow("Missing builtin variable: @date");
    expect(renderTemplate(body, {}, { preview: true })).toBe(body);
    expect(() => renderTemplate("{{@date}}", {}, { context: Object.create(context) })).toThrow("Missing builtin variable: @date");
  });

  it("preserves advanced escaped syntax and never recursively expands defaults or context", () => {
    const body = String.raw`\{{tone "Tone"=friendly}} \{{@date}} {{text=hello|world}} {{@selection}}`;
    const context = { "@selection": "{{@date}}" };
    const expected = '{{tone "Tone"=friendly}} {{@date}} hello|world {{@date}}';
    expect(renderTemplate(body, {}, { context })).toBe(expected);
    expect(renderTemplate(body, {}, { context, preview: true })).toBe(expected);
    expect(validateTemplate({ ...baseTemplate, body })).toEqual([]);
    expect(renderTemplate('{{text="{{other}}"}}', {})).toBe('"{{other}}"');
    expect(renderTemplate("{{text=first\nsecond}}", {})).toBe("first\nsecond");
  });

  it("handles prototype-shaped variable names without mutating default maps", () => {
    const body = "{{__proto__=safe}} {{constructor=ok}} {{toString?|a|b}}";
    const defaults = getTemplateDefaultValues(body);
    expect(Object.getPrototypeOf(defaults)).toBe(Object.prototype);
    expect(Object.hasOwn(defaults, "__proto__")).toBe(true);
    expect(defaults.__proto__).toBe("safe");
    expect(renderTemplate(body, {})).toBe("safe ok ");
    expect(renderTemplate(body, Object.fromEntries([["__proto__", "own"]]))).toBe("own ok ");
  });

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

  it("keeps optional occurrences empty in preview when a duplicate is required", () => {
    expect(renderTemplate("A {{x?}} B {{x}}", {}, { preview: true })).toBe("A  B {{x}}");
    expect(renderTemplate("{{x}} / {{x?}}", { x: " " }, { preview: true })).toBe("{{x}} /  ");
  });

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

  it("matches every whitespace-separated term across title, tags, and body", () => {
    const templates = [
      { ...baseTemplate, body: "Improve a draft", tags: ["writing"] },
      { ...baseTemplate, id: "other", title: "Other", body: "Rewrite a draft", tags: ["notes"] },
    ];
    expect(searchTemplates(templates, "  rewrite\nWRITING draft ").map((item) => item.id)).toEqual(["rewrite-clearer"]);
    expect(searchTemplates(templates, "rewrite nonexistent")).toEqual([]);
  });

  it("uses exact case-insensitive tag filters alongside ordinary and Unicode terms", () => {
    const templates = [
      { ...baseTemplate, id: "translate", title: "翻译文本", body: "Polish a draft", tags: ["写作", "English"] },
      { ...baseTemplate, id: "partial-tag", title: "翻译文本", tags: ["写作笔记", "English"] },
    ];
    expect(searchTemplates(templates, "翻译 #写作 #ENGLISH draft").map((item) => item.id)).toEqual(["translate"]);
    expect(searchTemplates(templates, "#写")).toEqual([]);
    expect(searchTemplates(templates, "#")).toEqual([]);
  });

  it("ranks title prefix, title substring, exact tag, partial tag, and body in that order", () => {
    const templates = [
      { ...baseTemplate, id: "body", title: "Body result", body: "needle", tags: [], isFavorite: true },
      { ...baseTemplate, id: "partial-tag", title: "Partial result", body: "", tags: ["needles"] },
      { ...baseTemplate, id: "tag", title: "Tag result", body: "", tags: ["needle"] },
      { ...baseTemplate, id: "substring", title: "The needle", body: "", tags: [] },
      { ...baseTemplate, id: "prefix", title: "Needle first", body: "", tags: [] },
    ];
    expect(searchTemplates(templates, "needle").map((item) => item.id)).toEqual([
      "prefix", "substring", "tag", "partial-tag", "body",
    ]);
  });

  it("uses title subsequence matches only after stronger field matches", () => {
    const templates = [
      { ...baseTemplate, id: "fuzzy", title: "Rewrite", body: "", tags: [], isFavorite: true },
      { ...baseTemplate, id: "body", title: "Other", body: "rwt", tags: [] },
    ];
    expect(searchTemplates(templates, "rwt").map((item) => item.id)).toEqual(["body", "fuzzy"]);
    expect(searchTemplates(templates, "wtr")).toEqual([]);
  });

  it("keeps all exact multi-term matches ahead of results needing fuzzy terms", () => {
    const templates = [
      { ...baseTemplate, id: "fuzzy", title: "Rewrite", body: "", tags: [], isFavorite: true },
      { ...baseTemplate, id: "body", title: "Other", body: "rewrite rwt", tags: [] },
    ];
    expect(searchTemplates(templates, "rewrite rwt").map((item) => item.id)).toEqual(["body", "fuzzy"]);
  });

  it("uses menu order for blank queries and equal relevance without mutating inputs or cached results", () => {
    const templates = [
      { ...baseTemplate, id: "alpha", title: "Alpha", body: "match", tags: [] },
      { ...baseTemplate, id: "recent", title: "Recent", body: "match", tags: [], lastUsedAt: "2026-06-02T00:00:00.000Z" },
      { ...baseTemplate, id: "favorite", title: "Favorite", body: "match", tags: [], isFavorite: true },
      { ...baseTemplate, id: "same-title", title: "Alpha", body: "match", tags: [] },
    ];
    const original = structuredClone(templates);
    const search = createTemplateSearch(Object.freeze(templates));
    const expected = ["favorite", "recent", "alpha", "same-title"];
    expect(search(" \n ").map((item) => item.id)).toEqual(expected);
    const result = search("match");
    expect(result.map((item) => item.id)).toEqual(expected);
    result.reverse();
    expect(search(" MATCH ").map((item) => item.id)).toEqual(expected);
    expect(templates).toEqual(original);
  });

  it("prepares searchable fields once when queries change", () => {
    let canRead = true;
    const read = <T,>(value: T): T => {
      if (!canRead) throw new Error("Search rebuilt a template field");
      return value;
    };
    const template: PromptTemplate = {
      ...baseTemplate,
      get title() { return read("Rewrite clearer"); },
      get body() { return read("Improve a draft"); },
      get tags() { return read(["writing"]); },
    };
    const search = createTemplateSearch([template]);
    canRead = false;
    for (const query of ["rewrite", "clearer writing", "#writing draft", "rwt", ""]) {
      expect(search(query).map((item) => item.id)).toEqual(["rewrite-clearer"]);
    }
  });

  it("builds a fresh index when the library is replaced", () => {
    const before = createTemplateSearch([{ ...baseTemplate, title: "Legacy prompt", body: "", tags: [] }]);
    const after = createTemplateSearch([{ ...baseTemplate, title: "Modern task", body: "", tags: [] }]);
    expect(before("legacy").map((item) => item.id)).toEqual(["rewrite-clearer"]);
    expect(after("legacy")).toEqual([]);
    expect(after("modern").map((item) => item.id)).toEqual(["rewrite-clearer"]);
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
