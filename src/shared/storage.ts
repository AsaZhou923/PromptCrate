import {
  createDefaultTemplates,
  isPromptTemplate,
  PromptTemplate,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
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
  const templates = Array.isArray(storedTemplates) &&
    storedTemplates.every(isPromptTemplate)
    ? storedTemplates
    : createDefaultTemplates(now);

  const store: PromptCrateStore = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    templates,
  };

  if (
    existing[STORAGE_KEYS.schemaVersion] !== STORAGE_SCHEMA_VERSION ||
    storedTemplates !== templates
  ) {
    await storage.set({
      [STORAGE_KEYS.schemaVersion]: store.schemaVersion,
      [STORAGE_KEYS.templates]: store.templates,
    });
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
  await storage.set({
    [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
    [STORAGE_KEYS.templates]: templates,
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

