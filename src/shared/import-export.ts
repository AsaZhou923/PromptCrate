import {
  findDuplicateTemplateIds,
  normalizeTemplate,
  PromptTemplate,
  STORAGE_SCHEMA_VERSION,
  validateTemplate,
} from "./templates";

export type TemplateExportPayload = {
  schemaVersion: number;
  exportedAt: string;
  templates: PromptTemplate[];
};

export type ImportParseResult =
  | {
      ok: true;
      payload: TemplateExportPayload;
    }
  | {
      ok: false;
      error: string;
    };

export type ImportMode = "merge" | "overwrite";

export type ImportResult = {
  templates: PromptTemplate[];
  added: number;
  updated: number;
  overwritten: boolean;
};

export function createTemplateExportPayload(
  templates: PromptTemplate[],
  now = new Date().toISOString(),
): TemplateExportPayload {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    exportedAt: now,
    templates,
  };
}

export function stringifyTemplateExport(
  templates: PromptTemplate[],
  now = new Date().toISOString(),
): string {
  return `${JSON.stringify(createTemplateExportPayload(templates, now), null, 2)}\n`;
}

export function parseTemplateImportJson(
  rawJson: string,
  now = new Date().toISOString(),
): ImportParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      ok: false,
      error: "The selected file is not valid JSON.",
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      error: "Import file must contain an object or array.",
    };
  }

  const payload: Record<string, unknown> = Array.isArray(parsed) ? { templates: parsed } : parsed as Record<string, unknown>;

  if (Object.hasOwn(payload, "schemaVersion") && payload.schemaVersion !== STORAGE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Unsupported schemaVersion: ${String(payload.schemaVersion)}.`,
    };
  }

  if (!Array.isArray(payload.templates)) {
    return {
      ok: false,
      error: "Import file must contain a templates array.",
    };
  }

  const normalizedTemplates: PromptTemplate[] = [];
  const reservedIds = collectExplicitIds(payload.templates);

  for (const template of payload.templates) {
    const normalized = normalizeImportedTemplate(template, now);
    if (!normalized) {
      return {
        ok: false,
        error: `Template at index ${normalizedTemplates.length + 1} is invalid.`,
      };
    }

    if (!hasExplicitId(template)) {
      normalized.id = allocateTemplateId(normalized.title, reservedIds);
    }
    normalizedTemplates.push(normalized);
  }

  const duplicateIds = findDuplicateTemplateIds(normalizedTemplates);

  if (duplicateIds.length > 0) {
    return {
      ok: false,
      error: `Import file contains duplicate template id: ${duplicateIds[0]}.`,
    };
  }

  return {
    ok: true,
    payload: {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      exportedAt: isTimestamp(payload.exportedAt)
        ? payload.exportedAt
        : now,
      templates: normalizedTemplates,
    },
  };
}

/** Salvage valid entries without changing storage or discarding the raw backup. */
export function parseTemplateBackup(
  templatesUnknown: unknown,
  now = new Date().toISOString(),
): { templates: PromptTemplate[]; skipped: number } {
  if (!Array.isArray(templatesUnknown)) return { templates: [], skipped: 1 };
  const reservedIds = collectExplicitIds(templatesUnknown);
  const seen = new Set<string>();
  const templates: PromptTemplate[] = [];
  let skipped = 0;
  for (const candidate of templatesUnknown) {
    const normalized = normalizeImportedTemplate(candidate, now);
    if (!normalized || (seen.has(normalized.id) && hasExplicitId(candidate))) {
      skipped += 1;
      continue;
    }
    if (!hasExplicitId(candidate)) {
      normalized.id = allocateTemplateId(normalized.title, reservedIds);
    }
    seen.add(normalized.id);
    templates.push(normalized);
  }
  return { templates, skipped };
}

function normalizeImportedTemplate(value: unknown, now: string): PromptTemplate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!Object.hasOwn(entry, "title") || typeof entry.title !== "string" ||
    !Object.hasOwn(entry, "body") || typeof entry.body !== "string") return null;
  if ((Object.hasOwn(entry, "id") && typeof entry.id !== "string") ||
    (Object.hasOwn(entry, "isFavorite") && typeof entry.isFavorite !== "boolean") ||
    (Object.hasOwn(entry, "tags") && (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === "string"))) ||
    ["createdAt", "updatedAt", "lastUsedAt"].some((field) => Object.hasOwn(entry, field) && !isTimestamp(entry[field]))) {
    return null;
  }
  const template = normalizeTemplate({
    id: Object.hasOwn(entry, "id") ? entry.id as string : "template",
    title: entry.title,
    body: entry.body,
    tags: Object.hasOwn(entry, "tags") ? entry.tags as string[] : [],
    isFavorite: Object.hasOwn(entry, "isFavorite") ? entry.isFavorite as boolean : false,
    createdAt: Object.hasOwn(entry, "createdAt") ? entry.createdAt as string : now,
    updatedAt: Object.hasOwn(entry, "updatedAt") ? entry.updatedAt as string : now,
    ...(Object.hasOwn(entry, "lastUsedAt") ? { lastUsedAt: entry.lastUsedAt as string } : {}),
  }, Object.hasOwn(entry, "updatedAt") ? entry.updatedAt as string : now);
  return validateTemplate(template).length === 0 ? template : null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function collectExplicitIds(entries: unknown[]): Set<string> {
  return new Set(entries.flatMap((entry) => typeof entry === "object" && entry !== null &&
    Object.hasOwn(entry, "id") && "id" in entry && typeof entry.id === "string" ? [entry.id.trim()] : []));
}

function hasExplicitId(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "id");
}

function allocateTemplateId(title: string, reservedIds: Set<string>): string {
  const base = title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "template";
  let id = base;
  let suffix = 2;
  while (reservedIds.has(id)) id = `${base}-${suffix++}`;
  reservedIds.add(id);
  return id;
}

export function applyTemplateImport(
  existingTemplates: PromptTemplate[],
  importedTemplates: PromptTemplate[],
  mode: ImportMode,
): ImportResult {
  if (mode === "overwrite") {
    return {
      templates: importedTemplates,
      added: importedTemplates.length,
      updated: 0,
      overwritten: true,
    };
  }

  const templatesById = new Map<string, PromptTemplate>(
    existingTemplates.map((template) => [template.id, template]),
  );
  let added = 0;
  let updated = 0;

  for (const importedTemplate of importedTemplates) {
    if (templatesById.has(importedTemplate.id)) {
      updated += 1;
    } else {
      added += 1;
    }

    templatesById.set(importedTemplate.id, importedTemplate);
  }

  return {
    templates: [...templatesById.values()],
    added,
    updated,
    overwritten: false,
  };
}
