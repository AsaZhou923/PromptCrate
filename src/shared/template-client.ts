import { MESSAGE_TYPE } from "./message-contract";
import { isPromptTemplate, type PromptTemplate } from "./templates";
import type { MutationResult, TemplateMutation } from "./template-mutations";
import type { LibraryMetadata, TemplateBackup } from "./storage";

export type { LibraryMetadata, TemplateBackup } from "./storage";

export async function loadLibraryMetadata(): Promise<LibraryMetadata> {
  const response: unknown = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.READ_LIBRARY_METADATA });
  if (typeof response === "object" && response !== null) {
    const result = response as Record<string, unknown>;
    if (result.ok === false && typeof result.error === "string") throw new Error(result.error);
    if (result.ok === true && isLibraryMetadata(result.metadata)) return result.metadata;
  }
  throw new Error("Invalid response from library metadata storage.");
}

function isLibraryMetadata(value: unknown): value is LibraryMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return (metadata.bytesInUse === null || isCount(metadata.bytesInUse)) &&
    (metadata.quotaBytes === null || (isCount(metadata.quotaBytes) && metadata.quotaBytes > 0)) &&
    Array.isArray(metadata.backups) && metadata.backups.every(isTemplateBackup) &&
    new Set(metadata.backups.map((backup) => backup.id)).size === metadata.backups.length;
}

function isTemplateBackup(value: unknown): value is TemplateBackup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const backup = value as Record<string, unknown>;
  return typeof backup.id === "string" && backup.id.length > 0 && typeof backup.reason === "string" &&
    typeof backup.backedUpAt === "string" && Object.hasOwn(backup, "templates");
}

export async function loadPromptTemplates(): Promise<PromptTemplate[]> {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.READ_TEMPLATES });
  return readResult(response).templates;
}

export async function commitTemplateMutation(mutation: TemplateMutation): Promise<MutationResult> {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.MUTATE_TEMPLATES, mutation });
  return readResult(response);
}

function readResult(response: unknown): MutationResult {
  if (typeof response !== "object" || response === null) {
    throw new Error("Invalid response from template storage.");
  }
  const result = response as Record<string, unknown>;
  if (result.ok === false && typeof result.error === "string") {
    throw new Error(result.error);
  }
  if (result.ok !== true || !Array.isArray(result.templates) || !result.templates.every(isPromptTemplate) ||
    (result.savedId !== undefined && typeof result.savedId !== "string") ||
    (result.added !== undefined && !isCount(result.added)) ||
    (result.updated !== undefined && !isCount(result.updated)) ||
    (result.overwritten !== undefined && typeof result.overwritten !== "boolean")) {
    throw new Error("Invalid response from template storage.");
  }
  return {
    templates: result.templates,
    ...(result.savedId === undefined ? {} : { savedId: result.savedId as string }),
    ...(result.added === undefined ? {} : { added: result.added as number }),
    ...(result.updated === undefined ? {} : { updated: result.updated as number }),
    ...(result.overwritten === undefined ? {} : { overwritten: result.overwritten as boolean }),
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
