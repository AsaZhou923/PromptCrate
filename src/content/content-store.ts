export const CONTENT_MESSAGE_TYPE = {
  OPEN_PROMPT_MENU: "OPEN_PROMPT_MENU",
  REOPEN_MENU: "REOPEN_MENU",
  INSERT_RENDERED_TEMPLATE: "INSERT_RENDERED_TEMPLATE",
  TEMPLATES_UPDATED: "TEMPLATES_UPDATED",
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

const STORAGE_SCHEMA_VERSION = 1;
const STORAGE_KEYS = {
  schemaVersion: "promptCrate.schemaVersion",
  templates: "promptCrate.templates",
} as const;

const DEFAULT_TEMPLATE_SEEDS: Array<
  Omit<PromptTemplate, "createdAt" | "updatedAt" | "lastUsedAt" | "isFavorite">
> = [
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

export function isContentRuntimeMessage(
  message: unknown,
): message is { type: (typeof CONTENT_MESSAGE_TYPE)[keyof typeof CONTENT_MESSAGE_TYPE] } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    Object.values(CONTENT_MESSAGE_TYPE).includes(
      (message as { type?: unknown }).type as never,
    )
  );
}

export async function readPromptTemplates(): Promise<PromptTemplate[]> {
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.schemaVersion,
    STORAGE_KEYS.templates,
  ]);
  const storedTemplates = existing[STORAGE_KEYS.templates];

  if (Array.isArray(storedTemplates) && storedTemplates.every(isPromptTemplate)) {
    return storedTemplates;
  }

  const defaults = createDefaultTemplates();
  await writePromptTemplates(defaults);
  return defaults;
}

export async function writePromptTemplates(
  templates: PromptTemplate[],
): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
    [STORAGE_KEYS.templates]: templates,
  });
}

export function extractTemplateVariables(body: string): TemplateVariable[] {
  const variables = new Map<string, TemplateVariable>();
  const placeholderPattern = /{{\s*([^{}]+?)\s*}}/g;
  let match: RegExpExecArray | null;

  while ((match = placeholderPattern.exec(body)) !== null) {
    const rawName = match[1]?.trim() ?? "";
    const isOptional = rawName.endsWith("?");
    const name = (isOptional ? rawName.slice(0, -1) : rawName).trim();

    if (name.length > 0 && !variables.has(name)) {
      variables.set(name, { name, required: !isOptional });
    }
  }

  return [...variables.values()];
}

export function renderTemplate(
  body: string,
  values: Record<string, string>,
): string {
  return body.replace(/{{\s*([^{}]+?)\s*}}/g, (placeholder, rawName: string) => {
    const trimmedName = rawName.trim();
    const isOptional = trimmedName.endsWith("?");
    const name = (isOptional ? trimmedName.slice(0, -1) : trimmedName).trim();
    const value = values[name] ?? "";

    if (!isOptional && value.trim().length === 0) {
      throw new Error(`Missing required variable: ${name}`);
    }

    return value.length > 0 || isOptional ? value : placeholder;
  });
}

export function searchTemplates(
  templates: PromptTemplate[],
  query: string,
): PromptTemplate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (normalizedQuery.length === 0) {
    return [...templates];
  }

  return templates.filter((template) =>
    [template.title, template.body, ...template.tags]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
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

function createDefaultTemplates(now = new Date().toISOString()): PromptTemplate[] {
  return DEFAULT_TEMPLATE_SEEDS.map((template) => ({
    ...template,
    isFavorite: false,
    createdAt: now,
    updatedAt: now,
  }));
}

function isPromptTemplate(value: unknown): value is PromptTemplate {
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

