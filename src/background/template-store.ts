import {
  getChromeLocalStorage,
  readPromptTemplates,
  type StorageAreaLike,
  writePromptTemplates,
} from "../shared/storage";
import { applyTemplateMutation, type TemplateMutation, validateTemplateMutation } from "../shared/template-mutations";

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
    mutate(mutation: TemplateMutation) {
      return enqueue(async () => {
        validateTemplateMutation(mutation);
        const current = await readPromptTemplates(storage);
        const result = applyTemplateMutation(current, mutation);
        if (JSON.stringify(current) !== JSON.stringify(result.templates)) {
          await writePromptTemplates(result.templates, storage);
        }
        return result;
      });
    },
  };
}
