import type { SavedSelection } from "./input-target";

/** Read only the metadata explicitly referenced by the template the user chose. */
export function createBuiltinValues(
  names: readonly string[],
  saved: SavedSelection | null,
  currentDocument: Document = document,
  now = new Date(),
): Record<string, string> {
  const values: Record<string, string> = {};
  const pad = (value: number) => String(value).padStart(2, "0");
  for (const name of new Set(names)) {
    switch (name) {
      case "@date":
        values[name] = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        break;
      case "@time":
        values[name] = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        break;
      case "@url":
        values[name] = currentDocument.location.href;
        break;
      case "@title":
        values[name] = currentDocument.title;
        break;
      case "@selection":
        values[name] = "";
        if (saved?.target.isConnected) {
          if (saved.kind === "text-control") {
            values[name] = saved.target.value.slice(saved.start, saved.end);
          } else if (saved.range && saved.target.contains(saved.range.commonAncestorContainer)) {
            values[name] = saved.range.toString();
          }
        }
        break;
    }
  }
  return values;
}
