import {
  createDefaultTemplates,
  isPromptTemplate,
  PromptTemplate,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
  validateTemplateCollection,
} from "./templates";

export type PromptCrateStore = {
  schemaVersion: number;
  templates: PromptTemplate[];
};

export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
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
  ]);

  const storedTemplates = existing[STORAGE_KEYS.templates];
  const updates: Record<string, unknown> = {};
  let templates: PromptTemplate[];

  if (Array.isArray(storedTemplates) && storedTemplates.every(isPromptTemplate)) {
    const validation = validateTemplateCollection(storedTemplates, now);

    if (validation.ok) {
      templates = validation.templates;

      if (!areTemplatesEqual(storedTemplates, templates)) {
        updates[STORAGE_KEYS.templates] = templates;
      }
    } else {
      templates = createDefaultTemplates(now);
      updates[STORAGE_KEYS.templates] = templates;
      updates[STORAGE_KEYS.invalidTemplatesBackup] = {
        reason: validation.error,
        backedUpAt: now,
        templates: storedTemplates,
      };
    }
  } else {
    templates = createDefaultTemplates(now);
    updates[STORAGE_KEYS.templates] = templates;

    if (Array.isArray(storedTemplates)) {
      updates[STORAGE_KEYS.invalidTemplatesBackup] = {
        reason: "Stored templates are not valid PromptCrate templates.",
        backedUpAt: now,
        templates: storedTemplates,
      };
    }
  }

  const store: PromptCrateStore = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    templates,
  };

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

export async function writePromptTemplates(
  templates: PromptTemplate[],
  storage = getChromeLocalStorage(),
): Promise<void> {
  const validation = validateTemplateCollection(templates);

  if (!validation.ok) {
    throw new Error(validation.error);
  }

  await storage.set({
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
