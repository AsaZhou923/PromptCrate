import {
  createDefaultTemplates,
  isPromptTemplate,
  PromptTemplate,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
  validateTemplateCollection,
} from "./templates";
import { LANGUAGE_STORAGE_KEY, resolveLocale } from "./i18n";
import { MEMORY_VALUES_KEY } from "./variable-memory";

export type PromptCrateStore = {
  schemaVersion: number;
  templates: PromptTemplate[];
};

export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
  QUOTA_BYTES?: number;
};

export const INVALID_TEMPLATES_BACKUPS_KEY = "promptCrate.invalidTemplatesBackups";
export const MAX_TEMPLATE_BACKUPS = 5;

export type TemplateBackup = {
  id: string;
  reason: string;
  backedUpAt: string;
  templates: unknown;
};

export type LibraryMetadata = {
  bytesInUse: number | null;
  quotaBytes: number | null;
  backups: TemplateBackup[];
};

export function getChromeLocalStorage(): StorageAreaLike {
  return chrome.storage.local;
}

export async function initializePromptCrateStorage(
  storage = getChromeLocalStorage(),
  now = new Date().toISOString(),
): Promise<PromptCrateStore> {
  const existing = await storage.get([
    STORAGE_KEYS.schemaVersion,
    STORAGE_KEYS.templates,
    LANGUAGE_STORAGE_KEY,
    MEMORY_VALUES_KEY,
    STORAGE_KEYS.invalidTemplatesBackup,
    INVALID_TEMPLATES_BACKUPS_KEY,
  ]);

  const storedTemplates = existing[STORAGE_KEYS.templates];
  const updates: Record<string, unknown> = {};
  let templates: PromptTemplate[];
  let resetTemplates = false;
  let backupReason: string | undefined;

  if (Array.isArray(storedTemplates) && storedTemplates.every(isPromptTemplate)) {
    const validation = validateTemplateCollection(storedTemplates, now);

    if (validation.ok) {
      templates = validation.templates;

      if (!areTemplatesEqual(storedTemplates, templates)) {
        updates[STORAGE_KEYS.templates] = templates;
      }
    } else {
      resetTemplates = true;
      templates = createDefaultTemplates(now, resolveLocale(existing[LANGUAGE_STORAGE_KEY]));
      updates[STORAGE_KEYS.templates] = templates;
      backupReason = validation.error;
    }
  } else {
    resetTemplates = true;
    templates = createDefaultTemplates(now, resolveLocale(existing[LANGUAGE_STORAGE_KEY]));
    updates[STORAGE_KEYS.templates] = templates;

    if (storedTemplates !== undefined) backupReason = "Stored templates are not valid PromptCrate templates.";
  }

  const store: PromptCrateStore = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    templates,
  };

  if (backupReason) {
    const history = readTemplateBackups(existing);
    const previous = history.find((backup) => sameBackupValue(backup.templates, storedTemplates));
    let id = previous?.id ?? `backup-${now}`;
    let suffix = 2;
    while (!previous && history.some((backup) => backup.id === id)) id = `backup-${now}-${suffix++}`;
    const backup = { id, reason: backupReason, backedUpAt: now, templates: storedTemplates };
    // Store each payload once: the compatible legacy slot owns the newest snapshot.
    updates[INVALID_TEMPLATES_BACKUPS_KEY] = history
      .filter((entry) => entry.id !== id && !sameBackupValue(entry.templates, storedTemplates))
      .slice(0, MAX_TEMPLATE_BACKUPS - 1);
    updates[STORAGE_KEYS.invalidTemplatesBackup] = backup;
  }

  if (resetTemplates && existing[MEMORY_VALUES_KEY] !== undefined) {
    updates[MEMORY_VALUES_KEY] = {};
  }

  if (existing[STORAGE_KEYS.schemaVersion] !== STORAGE_SCHEMA_VERSION) {
    updates[STORAGE_KEYS.schemaVersion] = store.schemaVersion;
  }

  if (Object.keys(updates).length > 0) {
    await storage.set(updates);
  }

  return store;
}

export async function readPromptTemplates(
  storage = getChromeLocalStorage(),
): Promise<PromptTemplate[]> {
  const store = await initializePromptCrateStorage(storage);
  return store.templates;
}

export async function readLibraryMetadata(storage = getChromeLocalStorage()): Promise<LibraryMetadata> {
  // Do not initialize here: a failed reset must not prevent exporting an existing backup.
  const existing = await storage.get([INVALID_TEMPLATES_BACKUPS_KEY, STORAGE_KEYS.invalidTemplatesBackup]);
  const bytesInUse = storage.getBytesInUse ? await storage.getBytesInUse(null) : null;
  const quotaBytes = storage.QUOTA_BYTES === undefined ? 10 * 1024 * 1024 : storage.QUOTA_BYTES;
  if (bytesInUse !== null && (!Number.isInteger(bytesInUse) || bytesInUse < 0)) {
    throw new Error("Invalid storage usage response.");
  }
  return {
    bytesInUse,
    quotaBytes: Number.isInteger(quotaBytes) && quotaBytes > 0 ? quotaBytes : null,
    backups: readTemplateBackups(existing),
  };
}

function readTemplateBackups(existing: Record<string, unknown>): TemplateBackup[] {
  const stored = existing[INVALID_TEMPLATES_BACKUPS_KEY];
  const history = Array.isArray(stored) ? stored : [];
  const candidates = [existing[STORAGE_KEYS.invalidTemplatesBackup], ...history];
  const backups: TemplateBackup[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (typeof value.reason !== "string" || typeof value.backedUpAt !== "string" || !Object.hasOwn(value, "templates")) continue;
    if (backups.some((backup) => sameBackupValue(backup.templates, value.templates))) continue;
    const matching = history.find((entry): entry is TemplateBackup =>
      !!entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.length > 0 &&
      Object.hasOwn(entry, "templates") && sameBackupValue(entry.templates, value.templates));
    const base = typeof value.id === "string" && value.id ? value.id : matching?.id ?? `legacy-${value.backedUpAt}`;
    let id = base;
    let suffix = 2;
    while (backups.some((backup) => backup.id === id)) id = `${base}-${suffix++}`;
    backups.push({ id, reason: value.reason, backedUpAt: value.backedUpAt, templates: value.templates });
    if (backups.length === MAX_TEMPLATE_BACKUPS) break;
  }
  return backups;
}

function sameBackupValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function writePromptTemplates(
  templates: PromptTemplate[],
  storage = getChromeLocalStorage(),
  storageUpdates: Record<string, unknown> = {},
): Promise<void> {
  const validation = validateTemplateCollection(templates);

  if (!validation.ok) {
    throw new Error(validation.error);
  }

  await storage.set({
    ...storageUpdates,
    [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
    [STORAGE_KEYS.templates]: validation.templates,
  });
}

export async function updatePromptTemplate(
  template: PromptTemplate,
  storage = getChromeLocalStorage(),
): Promise<PromptTemplate[]> {
  const templates = await readPromptTemplates(storage);
  const index = templates.findIndex((item) => item.id === template.id);
  const nextTemplates = index === -1
    ? [...templates, template]
    : templates.map((item) => (item.id === template.id ? template : item));

  await writePromptTemplates(nextTemplates, storage);
  return nextTemplates;
}

function areTemplatesEqual(left: PromptTemplate[], right: PromptTemplate[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
