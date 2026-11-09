import {
  getChromeLocalStorage,
  readPromptTemplates,
  readLibraryMetadata,
  type StorageAreaLike,
  writePromptTemplates,
} from "../shared/storage";
import { applyTemplateMutation, type TemplateMutation, validateTemplateMutation } from "../shared/template-mutations";
import { filterVariableValues, pruneVariableMemory } from "../shared/variable-memory-data";
import { isStringMap, MEMORY_ENABLED_KEY, MEMORY_VALUES_KEY, type VariableMemoryState } from "../shared/variable-memory";

export function createTemplateStore(storage: StorageAreaLike = getChromeLocalStorage()) {
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = tail.then(operation);
    // A failed request must not poison subsequent reads or writes.
    tail = pending.catch(() => undefined);
    return pending;
  }

  return {
    read() {
      return enqueue(() => readPromptTemplates(storage));
    },
    readLibraryMetadata() {
      return enqueue(() => readLibraryMetadata(storage));
    },
    mutate(mutation: TemplateMutation) {
      return enqueue(async () => {
        validateTemplateMutation(mutation);
        const current = await readPromptTemplates(storage);
        const result = applyTemplateMutation(current, mutation);
        if (JSON.stringify(current) !== JSON.stringify(result.templates)) {
          const memory = await storage.get([MEMORY_ENABLED_KEY, MEMORY_VALUES_KEY]);
          const values = memory[MEMORY_ENABLED_KEY] === true
            ? pruneVariableMemory(memory[MEMORY_VALUES_KEY], result.templates) : {};
          const updates = memory[MEMORY_VALUES_KEY] !== undefined &&
            JSON.stringify(values) !== JSON.stringify(memory[MEMORY_VALUES_KEY])
            ? { [MEMORY_VALUES_KEY]: values } : {};
          await writePromptTemplates(result.templates, storage, updates);
        }
        return result;
      });
    },
    readVariableMemory(templateId?: string, createdAt?: string) {
      return enqueue(async (): Promise<VariableMemoryState> => {
        if (templateId !== undefined && (typeof templateId !== "string" || typeof createdAt !== "string")) {
          throw new Error("Invalid template identity.");
        }
        const templates = await readPromptTemplates(storage);
        const memory = await storage.get([MEMORY_ENABLED_KEY, MEMORY_VALUES_KEY]);
        const enabled = memory[MEMORY_ENABLED_KEY] === true;
        const records = enabled ? pruneVariableMemory(memory[MEMORY_VALUES_KEY], templates) : {};
        return { enabled, values: templateId !== undefined && Object.hasOwn(records, templateId) &&
          records[templateId].createdAt === createdAt
          ? records[templateId].values : {} };
      });
    },
    setVariableMemoryEnabled(enabled: boolean) {
      return enqueue(async (): Promise<VariableMemoryState> => {
        if (typeof enabled !== "boolean") throw new Error("Invalid variable memory preference.");
        await readPromptTemplates(storage);
        await storage.set({ [MEMORY_ENABLED_KEY]: enabled, ...(!enabled ? { [MEMORY_VALUES_KEY]: {} } : {}) });
        return { enabled, values: {} };
      });
    },
    clearVariableMemory() {
      return enqueue(async (): Promise<VariableMemoryState> => {
        await readPromptTemplates(storage);
        const memory = await storage.get([MEMORY_ENABLED_KEY]);
        await storage.set({ [MEMORY_VALUES_KEY]: {} });
        return { enabled: memory[MEMORY_ENABLED_KEY] === true, values: {} };
      });
    },
    rememberVariableValues(templateId: string, values: Record<string, string>, createdAt: string) {
      return enqueue(async (): Promise<VariableMemoryState> => {
        if (typeof templateId !== "string" || typeof createdAt !== "string" || !isStringMap(values)) {
          throw new Error("Invalid variable values.");
        }
        const templates = await readPromptTemplates(storage);
        const memory = await storage.get([MEMORY_ENABLED_KEY, MEMORY_VALUES_KEY]);
        if (memory[MEMORY_ENABLED_KEY] !== true) return { enabled: false, values: {} };
        const template = templates.find((item) => item.id === templateId);
        if (!template || template.createdAt !== createdAt) return { enabled: true, values: {} };
        const records = pruneVariableMemory(memory[MEMORY_VALUES_KEY], templates);
        const filtered = filterVariableValues(template, values);
        if (Object.keys(filtered).length) {
          Object.defineProperty(records, templateId, { value: { createdAt: template.createdAt, values: filtered }, enumerable: true, configurable: true, writable: true });
        } else {
          delete records[templateId];
        }
        await storage.set({ [MEMORY_VALUES_KEY]: records });
        return { enabled: true, values: filtered };
      });
    },
  };
}
