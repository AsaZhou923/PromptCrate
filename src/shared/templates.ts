import { localizeDefaultSeed, resolveLocale, type UiLocale } from "./i18n";

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
  defaultValue?: string;
  options?: string[];
  label?: string;
  builtin?: boolean;
};

type TemplatePart =
  | { type: "text"; value: string }
  | ({ type: "variable"; placeholder: string } & TemplateVariable);

const BUILTIN_VARIABLES = new Set(["@date", "@time", "@url", "@title", "@selection"]);

type ParsedTemplate = {
  parts: TemplatePart[];
  variables: TemplateVariable[];
  errors: string[];
};

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

export function createDefaultTemplates(
  now = new Date().toISOString(),
  locale: UiLocale = resolveLocale(),
): PromptTemplate[] {
  return DEFAULT_TEMPLATE_SEEDS.map((template) => ({
    ...localizeDefaultSeed(template, locale),
    isFavorite: false,
    createdAt: now,
    updatedAt: now,
  }));
}

function parseVariable(expression: string, errors: string[]): TemplateVariable | undefined {
  let quoted = false;
  let escaped = false;
  let modifierIndex = -1;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quoted && escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === "=" || character === "|")) {
      modifierIndex = index;
      break;
    }
  }

  const head = (modifierIndex === -1 ? expression : expression.slice(0, modifierIndex)).trim();
  const labelIndex = head.indexOf('"');
  const rawName = (labelIndex === -1 ? head : head.slice(0, labelIndex)).trim();
  const optional = rawName.endsWith("?");
  const name = (optional ? rawName.slice(0, -1) : rawName).trim();
  if (!name && labelIndex === -1 && modifierIndex === -1) {
    return undefined;
  }

  const variable: TemplateVariable = { name, required: !optional };
  if (name.startsWith("@")) {
    variable.builtin = true;
    if (!BUILTIN_VARIABLES.has(name)) {
      errors.push(`Unknown builtin variable: ${name}`);
    }
  } else if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u.test(name)) {
    errors.push(`Invalid variable name: ${name}`);
  }

  if (labelIndex !== -1) {
    try {
      const label: unknown = JSON.parse(head.slice(labelIndex));
      if (typeof label !== "string") {
        throw new Error("Invalid label");
      }
      variable.label = label;
    } catch {
      errors.push(`Invalid variable label: ${name}`);
    }
  }

  if (modifierIndex !== -1) {
    const modifier = expression[modifierIndex];
    const value = expression.slice(modifierIndex + 1);
    if (variable.builtin) {
      errors.push(`Builtin variable cannot have defaults or options: ${name}`);
    } else if (modifier === "=") {
      variable.defaultValue = value;
    } else {
      const choices = value.split("|").map((choice) => choice.trim());
      if (choices.some((choice) => choice.length === 0)) {
        errors.push(`Invalid variable options: ${name}`);
      }
      variable.options = [...new Set(choices.filter(Boolean))];
    }
  }

  return variable;
}

function parseTemplate(body: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  const variables = new Map<string, TemplateVariable>();
  const errors: string[] = [];
  // The fallback also captures malformed quoted labels so validation can explain them.
  const placeholderPattern = /\\{{|{{((?:"(?:\\.|[^"\\])*"|[^{}"])*)}}|{{([^{}]*)}}/g;
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
    const variable = parseVariable((match[1] ?? match[2] ?? "").trim(), errors);

    if (!variable) {
      parts.push({ type: "text", value: placeholder });
    } else {
      const existing = variables.get(variable.name);
      if (existing) {
        existing.required ||= variable.required;
        for (const key of ["defaultValue", "options", "label"] as const) {
          if (variable[key] === undefined) {
            continue;
          }
          if (existing[key] !== undefined && JSON.stringify(existing[key]) !== JSON.stringify(variable[key])) {
            const kind = key === "defaultValue" ? "default" : key;
            errors.push(`Conflicting variable ${kind}: ${variable.name}`);
          } else {
            Object.assign(existing, { [key]: variable[key] });
          }
        }
      } else {
        variables.set(variable.name, { ...variable });
      }
      parts.push({ type: "variable", ...variable, placeholder });
    }
  }

  parts.push({ type: "text", value: body.slice(position) });
  for (const variable of variables.values()) {
    if (variable.defaultValue !== undefined && variable.options &&
        variable.defaultValue.trim() !== "" && !variable.options.includes(variable.defaultValue)) {
      errors.push(`Invalid variable default: ${variable.name}`);
    }
  }
  return { parts, variables: [...variables.values()], errors: [...new Set(errors)] };
}

export function extractTemplateVariables(body: string): TemplateVariable[] {
  return parseTemplate(body).variables;
}

function variableDefault(variable: TemplateVariable): string {
  return variable.defaultValue ?? (variable.required ? variable.options?.[0] : undefined) ?? "";
}

export function getTemplateDefaultValues(body: string): Record<string, string> {
  return Object.fromEntries(parseTemplate(body).variables
    .filter((variable) => !variable.builtin)
    .map((variable) => [variable.name, variableDefault(variable)]));
}

export function renderTemplate(
  body: string,
  values: Record<string, string>,
  options: { preview?: boolean; context?: Record<string, string> } = {},
): string {
  const parsed = parseTemplate(body);
  if (parsed.errors.length > 0 && !options.preview) {
    throw new Error(parsed.errors[0]);
  }
  const variables = new Map(parsed.variables.map((variable) => [variable.name, variable]));
  return parsed.parts.map((part) => {
    if (part.type === "text") {
      return part.value;
    }

    const variable = variables.get(part.name)!;
    if (variable.builtin) {
      if (BUILTIN_VARIABLES.has(part.name) && Object.prototype.hasOwnProperty.call(options.context ?? {}, part.name)) {
        return options.context![part.name] ?? "";
      }
      if (options.preview) {
        return part.placeholder;
      }
      throw new Error(`Missing builtin variable: ${part.name}`);
    }
    const value = Object.prototype.hasOwnProperty.call(values, part.name)
      ? values[part.name] ?? ""
      : variableDefault(variable);

    if (variable.required && value.trim().length === 0) {
      if (options.preview) {
        return part.required ? part.placeholder : value;
      }
      throw new Error(`Missing required variable: ${part.name}`);
    }

    if (value.trim().length > 0 && variable.options && !variable.options.includes(value)) {
      if (options.preview) {
        return part.placeholder;
      }
      throw new Error(`Invalid option for variable: ${part.name}`);
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

  errors.push(...parseTemplate(template.body).errors.map((message) => ({
    field: "variables" as const,
    message,
  })));

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
  templates: readonly PromptTemplate[],
  query: string,
): PromptTemplate[] {
  return createTemplateSearch(templates)(query);
}

type TemplateSearchEntry = {
  template: PromptTemplate;
  title: string;
  body: string;
  tags: string[];
  order: number;
};

export function createTemplateSearch(
  templates: readonly PromptTemplate[],
): (query: string) => PromptTemplate[] {
  // Rebuild this snapshot when the library changes, rather than normalizing every keystroke.
  const entries: TemplateSearchEntry[] = sortTemplatesForMenu(templates).map((template, order) => ({
    template,
    title: template.title.trim().toLocaleLowerCase(),
    body: template.body.toLocaleLowerCase(),
    tags: template.tags.map((tag) => tag.trim().toLocaleLowerCase()),
    order,
  }));
  let previousQuery: string | undefined;
  let previousResult: PromptTemplate[] = [];

  return (query) => {
    const terms = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
    const normalizedQuery = terms.join(" ");
    if (normalizedQuery === previousQuery) {
      return [...previousResult];
    }

    const matches: Array<{ entry: TemplateSearchEntry; score: number; fuzzyTerms: number }> = [];
    for (const entry of entries) {
      let score = 0;
      let fuzzyTerms = 0;
      let matchesAll = true;
      for (const term of terms) {
        const match = matchSearchTerm(entry, term);
        if (!match) {
          matchesAll = false;
          break;
        }
        score += match.score;
        fuzzyTerms += match.fuzzy ? 1 : 0;
      }
      if (matchesAll) {
        matches.push({ entry, score, fuzzyTerms });
      }
    }
    matches.sort((left, right) =>
      left.fuzzyTerms - right.fuzzyTerms || right.score - left.score || left.entry.order - right.entry.order);
    previousQuery = normalizedQuery;
    previousResult = matches.map((match) => match.entry.template);
    return [...previousResult];
  };
}

function matchSearchTerm(
  entry: TemplateSearchEntry,
  term: string,
): { score: number; fuzzy: boolean } | null {
  if (term.startsWith("#")) {
    return entry.tags.includes(term.slice(1)) ? { score: 0, fuzzy: false } : null;
  }
  const score = entry.title.startsWith(term) ? 5
    : entry.title.includes(term) ? 4
    : entry.tags.includes(term) ? 3
    : entry.tags.some((tag) => tag.includes(term)) ? 2
    : entry.body.includes(term) ? 1
    : 0;
  if (score > 0) {
    return { score, fuzzy: false };
  }
  let next = 0;
  const characters = [...term];
  for (const character of entry.title) {
    if (character === characters[next]) {
      next += 1;
      if (next === characters.length) {
        return { score: 0, fuzzy: true };
      }
    }
  }
  return null;
}

export function sortTemplatesForMenu(templates: readonly PromptTemplate[]): PromptTemplate[] {
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
  };
}
