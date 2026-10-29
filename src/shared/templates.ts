export const STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_KEYS = {
  invalidTemplatesBackup: "promptCrate.invalidTemplatesBackup",
  schemaVersion: "promptCrate.schemaVersion",
  templates: "promptCrate.templates",
} as const;

export type PromptTemplate = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type TemplateVariable = {
  name: string;
  required: boolean;
};

type TemplatePart =
  | { type: "text"; value: string }
  | { type: "variable"; name: string; required: boolean; placeholder: string };

export type TemplateValidationError = {
  field: keyof PromptTemplate | "variables";
  message: string;
};

export type TemplateCollectionValidationResult =
  | {
      ok: true;
      templates: PromptTemplate[];
    }
  | {
      ok: false;
      error: string;
    };

type DefaultTemplateSeed = Omit<
  PromptTemplate,
  "createdAt" | "updatedAt" | "lastUsedAt" | "isFavorite"
>;

const DEFAULT_TEMPLATE_SEEDS: DefaultTemplateSeed[] = [
  {
    id: "summarize-page",
    title: "Summarize page",
    body: "Summarize the key ideas from this page in concise bullets.",
    tags: ["summary", "reading"],
  },
  {
    id: "rewrite-clearer",
    title: "Rewrite clearer",
    body: "Rewrite the following text so it is clearer, shorter, and keeps the original meaning:\n\n{{text}}",
    tags: ["writing", "rewrite"],
  },
  {
    id: "compare-options",
    title: "Compare options",
    body: "Compare {{option_a}} and {{option_b}}. Show tradeoffs, risks, and a recommendation.",
    tags: ["analysis", "decision"],
  },
  {
    id: "draft-reply",
    title: "Draft reply",
    body: "Draft a warm, concise reply to this message. Tone: {{tone}}.\n\n{{message}}",
    tags: ["email", "writing"],
  },
  {
    id: "extract-actions",
    title: "Extract actions",
    body: "Extract action items, owners, and due dates from the text below:\n\n{{notes}}",
    tags: ["meeting", "tasks"],
  },
  {
    id: "debug-helper",
    title: "Debug helper",
    body: "Given this error and context, identify likely root causes and the next three checks:\n\n{{error}}",
    tags: ["coding", "debug"],
  },
  {
    id: "translate-polish",
    title: "Translate and polish",
    body: "Translate this into {{language}} and make it natural for a professional reader:\n\n{{text}}",
    tags: ["translation", "writing"],
  },
];

export function createDefaultTemplates(now = new Date().toISOString()): PromptTemplate[] {
  return DEFAULT_TEMPLATE_SEEDS.map((template) => ({
    ...template,
    isFavorite: false,
    createdAt: now,
    updatedAt: now,
  }));
}

function parseTemplate(body: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const placeholderPattern = /\\{{|{{([^{}]*)}}/g;
  let position = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholderPattern.exec(body)) !== null) {
    parts.push({ type: "text", value: body.slice(position, match.index) });

    if (match[0].startsWith("\\")) {
      let depth = 1;
      let end = placeholderPattern.lastIndex;
      while (end < body.length && depth > 0) {
        if (body.startsWith("{{", end)) {
          depth += 1;
          end += 2;
        } else if (body.startsWith("}}", end)) {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }

      // An incomplete escape stays verbatim and shields the rest from variable parsing.
      parts.push({ type: "text", value: body.slice(match.index + (depth === 0 ? 1 : 0), end) });
      position = end;
      placeholderPattern.lastIndex = end;
      continue;
    }

    position = placeholderPattern.lastIndex;
    const placeholder = match[0];
    const rawName = match[1]?.trim() ?? "";
    const isOptional = rawName.endsWith("?");
    const name = (isOptional ? rawName.slice(0, -1) : rawName).trim();

    if (name.length === 0) {
      parts.push({ type: "text", value: placeholder });
    } else {
      parts.push({ type: "variable", name, required: !isOptional, placeholder });
    }
  }

  parts.push({ type: "text", value: body.slice(position) });
  return parts;
}

export function extractTemplateVariables(body: string): TemplateVariable[] {
  const variables = new Map<string, TemplateVariable>();

  for (const part of parseTemplate(body)) {
    if (part.type === "text") {
      continue;
    }

    variables.set(part.name, {
      name: part.name,
      required: part.required || (variables.get(part.name)?.required ?? false),
    });
  }

  return [...variables.values()];
}

export function renderTemplate(
  body: string,
  values: Record<string, string>,
  options: { preview?: boolean } = {},
): string {
  return parseTemplate(body).map((part) => {
    if (part.type === "text") {
      return part.value;
    }

    const value = Object.prototype.hasOwnProperty.call(values, part.name)
      ? values[part.name] ?? ""
      : "";

    if (part.required && value.trim().length === 0) {
      if (options.preview) {
        return part.placeholder;
      }
      throw new Error(`Missing required variable: ${part.name}`);
    }

    return value;
  }).join("");
}

export function validateTemplate(template: PromptTemplate): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  if (template.id.trim().length === 0) {
    errors.push({ field: "id", message: "ID is required." });
  }

  if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(template.id)) {
    errors.push({
      field: "id",
      message: "ID can contain letters, numbers, dashes, underscores, and dots.",
    });
  }

  if (template.title.trim().length === 0) {
    errors.push({ field: "title", message: "Title is required." });
  }

  if (template.body.trim().length === 0) {
    errors.push({ field: "body", message: "Body is required." });
  }

  const invalidVariable = extractTemplateVariables(template.body).find(
    (variable) => !/^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u.test(variable.name),
  );

  if (invalidVariable) {
    errors.push({
      field: "variables",
      message: `Invalid variable name: ${invalidVariable.name}`,
    });
  }

  return errors;
}

export function validateTemplateCollection(
  templates: PromptTemplate[],
  now = new Date().toISOString(),
): TemplateCollectionValidationResult {
  const normalizedTemplates = templates.map((template) =>
    normalizeTemplate(template, template.updatedAt || now),
  );

  const invalidIndex = normalizedTemplates.findIndex(
    (template) => validateTemplate(template).length > 0,
  );

  if (invalidIndex !== -1) {
    return {
      ok: false,
      error: `Template at index ${invalidIndex + 1} is invalid.`,
    };
  }

  const duplicateIds = findDuplicateTemplateIds(normalizedTemplates);

  if (duplicateIds.length > 0) {
    return {
      ok: false,
      error: `Duplicate template id: ${duplicateIds[0]}.`,
    };
  }

  return {
    ok: true,
    templates: normalizedTemplates,
  };
}

export function findDuplicateTemplateIds(templates: PromptTemplate[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const template of templates) {
    if (seen.has(template.id)) {
      duplicates.add(template.id);
    } else {
      seen.add(template.id);
    }
  }

  return [...duplicates];
}

export function isPromptTemplate(value: unknown): value is PromptTemplate {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as PromptTemplate;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.body === "string" &&
    Array.isArray(candidate.tags) &&
    candidate.tags.every((tag) => typeof tag === "string") &&
    typeof candidate.isFavorite === "boolean" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    (candidate.lastUsedAt === undefined || typeof candidate.lastUsedAt === "string")
  );
}

export function normalizeTemplate(
  template: PromptTemplate,
  now = new Date().toISOString(),
): PromptTemplate {
  return {
    ...template,
    id: template.id.trim(),
    title: template.title.trim(),
    body: template.body,
    tags: normalizeTags(template.tags),
    isFavorite: Boolean(template.isFavorite),
    createdAt: template.createdAt || now,
    updatedAt: now,
  };
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function searchTemplates(
  templates: PromptTemplate[],
  query: string,
): PromptTemplate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (normalizedQuery.length === 0) {
    return [...templates];
  }

  return templates.filter((template) => {
    const haystack = [
      template.title,
      template.body,
      ...template.tags,
    ].join(" ").toLocaleLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

export function sortTemplatesForMenu(templates: PromptTemplate[]): PromptTemplate[] {
  return [...templates].sort((left, right) => {
    if (left.isFavorite !== right.isFavorite) {
      return left.isFavorite ? -1 : 1;
    }

    const leftUsed = Date.parse(left.lastUsedAt ?? "");
    const rightUsed = Date.parse(right.lastUsedAt ?? "");
    const leftScore = Number.isNaN(leftUsed) ? 0 : leftUsed;
    const rightScore = Number.isNaN(rightUsed) ? 0 : rightUsed;

    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    return left.title.localeCompare(right.title);
  });
}

export function touchTemplateLastUsed(
  template: PromptTemplate,
  now = new Date().toISOString(),
): PromptTemplate {
  return {
    ...template,
    lastUsedAt: now,
    updatedAt: now,
  };
}
