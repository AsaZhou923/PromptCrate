import {
  findDuplicateTemplateIds,
  isPromptTemplate,
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

export function parseTemplateImportJson(rawJson: string): ImportParseResult {
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
      error: "Import file must contain an object.",
    };
  }

  const payload = parsed as TemplateExportPayload;

  if (payload.schemaVersion !== STORAGE_SCHEMA_VERSION) {
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

  for (const template of payload.templates) {
    if (!isPromptTemplate(template)) {
      return {
        ok: false,
        error: `Template at index ${normalizedTemplates.length + 1} is invalid.`,
      };
    }

    normalizedTemplates.push(normalizeTemplate(template));
  }

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
      error: `Import file contains duplicate template id: ${duplicateIds[0]}.`,
    };
  }

  return {
    ok: true,
    payload: {
      schemaVersion: payload.schemaVersion,
      exportedAt: typeof payload.exportedAt === "string"
        ? payload.exportedAt
        : new Date().toISOString(),
      templates: normalizedTemplates,
    },
  };
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
