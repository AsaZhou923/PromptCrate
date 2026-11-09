import {
  isPromptTemplate,
  normalizeTemplate,
  type PromptTemplate,
  touchTemplateLastUsed,
  validateTemplateCollection,
} from "./templates";
import { applyTemplateImport } from "./import-export";

export type TemplateMutation =
  | { kind: "save"; template: PromptTemplate; previous: PromptTemplate | null; autoId?: string }
  | { kind: "delete"; previous: PromptTemplate }
  | { kind: "deleteMany"; previous: PromptTemplate[] }
  | { kind: "reorder"; ids: string[]; expected: PromptTemplate[] }
  | { kind: "import"; templates: PromptTemplate[]; mode: "merge" | "overwrite"; expected: PromptTemplate[] }
  | { kind: "touch"; id: string };

export type MutationResult = {
  templates: PromptTemplate[];
  savedId?: string;
  added?: number;
  updated?: number;
  overwritten?: boolean;
};

export function sameTemplateRevision(
  left: PromptTemplate | null | undefined,
  right: PromptTemplate | null | undefined,
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return left.id === right.id && left.title === right.title && left.body === right.body &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags) &&
    left.isFavorite === right.isFavorite && left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt;
}

export function isTemplateMutation(value: unknown): value is TemplateMutation {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const mutation = value as Record<string, unknown>;
  switch (mutation.kind) {
    case "save":
      return isPromptTemplate(mutation.template) &&
        (mutation.previous === null || isPromptTemplate(mutation.previous)) &&
        (mutation.autoId === undefined || (typeof mutation.autoId === "string" && mutation.autoId.trim().length > 0));
    case "delete":
      return isPromptTemplate(mutation.previous);
    case "deleteMany":
      return isTemplateArray(mutation.previous) && mutation.previous.length > 0;
    case "reorder":
      return Array.isArray(mutation.ids) && mutation.ids.every((id) => typeof id === "string") &&
        isTemplateArray(mutation.expected);
    case "import":
      return isTemplateArray(mutation.templates) && isTemplateArray(mutation.expected) &&
        (mutation.mode === "merge" || mutation.mode === "overwrite");
    case "touch":
      return typeof mutation.id === "string" && mutation.id.trim().length > 0;
    default:
      return false;
  }
}

export function applyTemplateMutation(
  current: PromptTemplate[],
  mutation: TemplateMutation,
  now = new Date().toISOString(),
): MutationResult {
  validateTemplateMutation(mutation);

  switch (mutation.kind) {
    case "save": {
      const previous = mutation.previous;
      const stored = previous ? current.find((item) => item.id === previous.id) : undefined;
      if (previous && !sameTemplateRevision(stored, previous)) {
        throw new Error("Template changed or was deleted in another tab. Reselect it before saving.");
      }
      const id = mutation.autoId
        ? createUniqueId(mutation.autoId.trim(), current.filter((item) => item.id !== previous?.id))
        : mutation.template.id.trim();
      if (current.some((item) => item.id === id && item.id !== previous?.id)) {
        throw new Error("Template ID already exists.");
      }
      const template = normalizeTemplate({
        ...mutation.template,
        id,
        createdAt: stored?.createdAt ?? mutation.template.createdAt,
        lastUsedAt: stored ? stored.lastUsedAt : mutation.template.lastUsedAt,
      }, now);
      const templates = previous
        ? current.map((item) => item.id === previous.id ? template : item)
        : [...current, template];
      return { templates: validateTemplates(templates), savedId: id };
    }
    case "delete": {
      const stored = current.find((item) => item.id === mutation.previous.id);
      if (!sameTemplateRevision(stored, mutation.previous)) {
        throw new Error("Template changed or was deleted in another tab. Reselect it before deleting.");
      }
      return { templates: current.filter((item) => item.id !== mutation.previous.id) };
    }
    case "deleteMany": {
      const currentById = new Map(current.map((item) => [item.id, item]));
      if (mutation.previous.some((previous) => !sameTemplateRevision(currentById.get(previous.id), previous))) {
        throw new Error("Selected templates changed or were deleted in another tab. Reselect them before deleting.");
      }
      const removed = new Set(mutation.previous.map((previous) => previous.id));
      return { templates: current.filter((item) => !removed.has(item.id)) };
    }
    case "reorder": {
      if (current.length !== mutation.expected.length || current.some((item, index) =>
        item.id !== mutation.expected[index].id || !sameTemplateRevision(item, mutation.expected[index]))) {
        throw new Error("Templates changed in another tab. Reload the latest templates before reordering.");
      }
      const currentById = new Map(current.map((item) => [item.id, item]));
      return { templates: mutation.ids.map((id) => currentById.get(id)!) };
    }
    case "import": {
      const imported = validateTemplates(mutation.templates);
      const currentById = new Map(current.map((item) => [item.id, item]));
      const expectedById = new Map(mutation.expected.map((item) => [item.id, item]));
      const conflict = mutation.mode === "overwrite"
        ? current.length !== mutation.expected.length ||
          current.some((item) => !sameTemplateRevision(item, expectedById.get(item.id)))
        : imported.some((item) => !sameTemplateRevision(currentById.get(item.id), expectedById.get(item.id)));
      if (conflict) {
        throw new Error("Templates changed in another tab. Reload the latest templates before importing.");
      }
      const withUsage = imported.map((item) => ({
        ...item,
        lastUsedAt: mostRecentUsage(currentById.get(item.id)?.lastUsedAt, item.lastUsedAt),
      }));
      const result = applyTemplateImport(current, withUsage, mutation.mode);
      return { ...result, templates: validateTemplates(result.templates) };
    }
    case "touch":
      return {
        templates: current.map((item) => item.id === mutation.id
          ? touchTemplateLastUsed(item, mostRecentUsage(item.lastUsedAt, now) ?? now)
          : item),
      };
  }
}

export function validateTemplateMutation(mutation: unknown): asserts mutation is TemplateMutation {
  if (!isTemplateMutation(mutation)) {
    throw new Error("Invalid template mutation.");
  }
  switch (mutation.kind) {
    case "save":
      validateTemplates([{ ...mutation.template, id: mutation.autoId ?? mutation.template.id }]);
      if (mutation.previous) {
        validateTemplates([mutation.previous]);
      }
      break;
    case "delete":
      validateTemplates([mutation.previous]);
      break;
    case "deleteMany":
      validateTemplates(mutation.previous);
      break;
    case "reorder": {
      validateTemplates(mutation.expected);
      const expectedIds = new Set(mutation.expected.map((item) => item.id));
      if (mutation.ids.length !== mutation.expected.length || new Set(mutation.ids).size !== mutation.ids.length ||
        mutation.ids.some((id) => !expectedIds.has(id))) {
        throw new Error("Template order must contain every current template exactly once.");
      }
      break;
    }
    case "import":
      validateTemplates(mutation.templates);
      validateTemplates(mutation.expected);
      break;
    case "touch":
      if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(mutation.id)) {
        throw new Error("Invalid template id.");
      }
  }
}

function isTemplateArray(value: unknown): value is PromptTemplate[] {
  return Array.isArray(value) && value.every(isPromptTemplate);
}

function validateTemplates(templates: PromptTemplate[]): PromptTemplate[] {
  const validation = validateTemplateCollection(templates);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  return validation.templates;
}

function createUniqueId(base: string, templates: PromptTemplate[]): string {
  const ids = new Set(templates.map((item) => item.id));
  let id = base;
  let suffix = 2;
  while (ids.has(id)) {
    id = `${base}-${suffix++}`;
  }
  return id;
}

function mostRecentUsage(left: string | undefined, right: string | undefined): string | undefined {
  const leftTime = Date.parse(left ?? "");
  const rightTime = Date.parse(right ?? "");
  if (Number.isNaN(rightTime)) {
    return left;
  }
  return Number.isNaN(leftTime) || rightTime > leftTime ? right : left;
}
