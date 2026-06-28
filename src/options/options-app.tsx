import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  applyTemplateImport,
  createTemplateExportPayload,
  parseTemplateImportJson,
  TemplateExportPayload,
} from "../shared/import-export";
import { MESSAGE_TYPE } from "../shared/message-contract";
import { readPromptTemplates, writePromptTemplates } from "../shared/storage";
import {
  normalizeTags,
  normalizeTemplate,
  PromptTemplate,
  searchTemplates,
  sortTemplatesForMenu,
  validateTemplate,
} from "../shared/templates";

type TemplateFormState = {
  id: string;
  title: string;
  body: string;
  tags: string;
  isFavorite: boolean;
};

const EMPTY_FORM: TemplateFormState = {
  id: "",
  title: "",
  body: "",
  tags: "",
  isFavorite: false,
};

function OptionsApp() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateFormState>(EMPTY_FORM);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Loading templates...");
  const [error, setError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<TemplateExportPayload | null>(null);

  useEffect(() => {
    void readPromptTemplates()
      .then((items) => {
        setTemplates(items);
        setStatus(`${items.length} templates loaded.`);
      })
      .catch((caughtError: unknown) => {
        setError(getErrorMessage(caughtError));
        setStatus("Could not load templates.");
      });
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [selectedId, templates],
  );

  const visibleTemplates = useMemo(
    () => sortTemplatesForMenu(searchTemplates(templates, query)),
    [query, templates],
  );

  function selectTemplate(template: PromptTemplate): void {
    setSelectedId(template.id);
    setForm(templateToForm(template));
    setError(null);
  }

  function startNewTemplate(): void {
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setStatus("New template.");
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const now = new Date().toISOString();
    const existing = selectedTemplate;
    const candidate = normalizeTemplate({
      id: form.id || createTemplateId(form.title),
      title: form.title,
      body: form.body,
      tags: normalizeTags(splitTags(form.tags)),
      isFavorite: form.isFavorite,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
    });

    const validationErrors = validateTemplate(candidate);

    if (validationErrors.length > 0) {
      setError(validationErrors.map((item) => item.message).join(" "));
      return;
    }

    const duplicate = templates.find(
      (template) => template.id === candidate.id && template.id !== selectedId,
    );

    if (duplicate) {
      setError("Template ID already exists.");
      return;
    }

    const nextTemplates = selectedId
      ? templates.map((template) =>
          template.id === selectedId ? candidate : template,
        )
      : [...templates, candidate];

    await persistTemplates(nextTemplates, `Saved "${candidate.title}".`);
    setSelectedId(candidate.id);
    setForm(templateToForm(candidate));
  }

  async function deleteTemplate(): Promise<void> {
    if (!selectedTemplate) {
      return;
    }

    if (!confirm(`Delete "${selectedTemplate.title}"?`)) {
      return;
    }

    const nextTemplates = templates.filter((template) => template.id !== selectedTemplate.id);
    await persistTemplates(nextTemplates, `Deleted "${selectedTemplate.title}".`);
    setSelectedId(null);
    setForm(EMPTY_FORM);
  }

  async function duplicateTemplate(): Promise<void> {
    if (!selectedTemplate) {
      return;
    }

    const now = new Date().toISOString();
    const copy: PromptTemplate = {
      ...selectedTemplate,
      id: createUniqueTemplateId(`${selectedTemplate.id}-copy`, templates),
      title: `${selectedTemplate.title} copy`,
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: undefined,
    };
    const nextTemplates = [...templates, copy];

    await persistTemplates(nextTemplates, `Copied "${selectedTemplate.title}".`);
    setSelectedId(copy.id);
    setForm(templateToForm(copy));
  }

  async function toggleFavorite(template: PromptTemplate): Promise<void> {
    const nextTemplates = templates.map((item) =>
      item.id === template.id
        ? {
            ...item,
            isFavorite: !item.isFavorite,
            updatedAt: new Date().toISOString(),
          }
        : item,
    );

    await persistTemplates(nextTemplates, "Favorite updated.");

    if (selectedId === template.id) {
      setForm((currentForm) => ({
        ...currentForm,
        isFavorite: !template.isFavorite,
      }));
    }
  }

  function exportTemplates(): void {
    const payload = createTemplateExportPayload(templates);
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `promptcrate-templates-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${templates.length} templates.`);
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    const rawJson = await file.text();
    const parsed = parseTemplateImportJson(rawJson);

    if (!parsed.ok) {
      setPendingImport(null);
      setError(parsed.error);
      setStatus("Import failed.");
      return;
    }

    setError(null);
    setPendingImport(parsed.payload);
    setStatus(`${parsed.payload.templates.length} templates ready to import.`);
  }

  async function applyPendingImport(mode: "merge" | "overwrite"): Promise<void> {
    if (!pendingImport) {
      return;
    }

    if (mode === "overwrite" && !confirm("Overwrite all existing templates?")) {
      return;
    }

    const result = applyTemplateImport(templates, pendingImport.templates, mode);
    await persistTemplates(
      result.templates,
      result.overwritten
        ? `Imported ${result.added} templates by overwrite.`
        : `Imported ${result.added} new and ${result.updated} updated templates.`,
    );
    setPendingImport(null);
  }

  async function persistTemplates(
    nextTemplates: PromptTemplate[],
    message: string,
  ): Promise<void> {
    setError(null);

    try {
      await writePromptTemplates(nextTemplates);
      setTemplates(nextTemplates);
      setStatus(message);
      await notifyTemplatesUpdated();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
      setStatus("Save failed.");
    }
  }

  return (
    <main className="options-shell">
      <style>{OPTIONS_STYLES}</style>

      <aside className="sidebar" aria-label="Templates">
        <div className="toolbar">
          <h1>PromptCrate</h1>
          <button type="button" onClick={startNewTemplate}>
            New
          </button>
        </div>

        <input
          className="search"
          type="search"
          placeholder="Search templates"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="template-list">
          {visibleTemplates.length === 0 ? (
            <p className="muted">No templates.</p>
          ) : (
            visibleTemplates.map((template) => (
              <button
                className={
                  template.id === selectedId ? "template-row selected" : "template-row"
                }
                key={template.id}
                type="button"
                onClick={() => selectTemplate(template)}
              >
                <span className="row-title">
                  {template.isFavorite ? "* " : ""}
                  {template.title}
                </span>
                <span className="row-tags">{template.tags.join(", ")}</span>
              </button>
            ))
          )}
        </div>

        <section className="import-export" aria-label="Import and export">
          <button type="button" onClick={exportTemplates}>
            Export JSON
          </button>
          <label className="file-button">
            Import JSON
            <input type="file" accept="application/json" onChange={handleImportFile} />
          </label>
          {pendingImport ? (
            <div className="import-actions">
              <button type="button" onClick={() => void applyPendingImport("merge")}>
                Merge
              </button>
              <button type="button" onClick={() => void applyPendingImport("overwrite")}>
                Overwrite
              </button>
            </div>
          ) : null}
        </section>
      </aside>

      <section className="editor" aria-label="Template editor">
        <form onSubmit={(event) => void saveTemplate(event)}>
          <div className="editor-header">
            <div>
              <h2>{selectedTemplate ? "Edit template" : "New template"}</h2>
              <p className={error ? "status error" : "status"}>
                {error ?? status}
              </p>
            </div>

            <div className="editor-actions">
              <button
                type="button"
                disabled={!selectedTemplate}
                onClick={() => selectedTemplate && void toggleFavorite(selectedTemplate)}
              >
                {form.isFavorite ? "Unfavorite" : "Favorite"}
              </button>
              <button
                type="button"
                disabled={!selectedTemplate}
                onClick={() => void duplicateTemplate()}
              >
                Copy
              </button>
              <button
                type="button"
                disabled={!selectedTemplate}
                onClick={() => void deleteTemplate()}
              >
                Delete
              </button>
              <button type="submit" className="primary">
                Save
              </button>
            </div>
          </div>

          <div className="form-grid">
            <label>
              <span>ID</span>
              <input
                value={form.id}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    id: event.target.value,
                  }))
                }
                placeholder="rewrite-clearer"
              />
            </label>

            <label>
              <span>Title</span>
              <input
                value={form.title}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    title: event.target.value,
                  }))
                }
                placeholder="Rewrite clearer"
              />
            </label>

            <label className="wide">
              <span>Tags</span>
              <input
                value={form.tags}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    tags: event.target.value,
                  }))
                }
                placeholder="writing, rewrite"
              />
            </label>

            <label className="favorite-check">
              <input
                type="checkbox"
                checked={form.isFavorite}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    isFavorite: event.target.checked,
                  }))
                }
              />
              <span>Favorite</span>
            </label>

            <label className="body-field">
              <span>Body</span>
              <textarea
                value={form.body}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    body: event.target.value,
                  }))
                }
                placeholder="Rewrite {{text}} in a clearer tone."
              />
            </label>
          </div>
        </form>
      </section>
    </main>
  );
}

function templateToForm(template: PromptTemplate): TemplateFormState {
  return {
    id: template.id,
    title: template.title,
    body: template.body,
    tags: template.tags.join(", "),
    isFavorite: template.isFavorite,
  };
}

function splitTags(tags: string): string[] {
  return tags.split(",");
}

function createTemplateId(title: string): string {
  const slug = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || `template-${Date.now()}`;
}

function createUniqueTemplateId(baseId: string, templates: PromptTemplate[]): string {
  const existingIds = new Set(templates.map((template) => template.id));
  let candidate = baseId;
  let suffix = 2;

  while (existingIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

async function notifyTemplatesUpdated(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.TEMPLATES_UPDATED });
  } catch {
    return;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OPTIONS_STYLES = `
  :root {
    color-scheme: light;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #172026;
    background: #f8faf9;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
  }

  button,
  input,
  textarea {
    font: inherit;
  }

  button {
    border: 1px solid #b8c6cf;
    border-radius: 7px;
    color: #172026;
    background: #fff;
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    border-color: #2f7f78;
    outline: none;
  }

  .options-shell {
    display: grid;
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
    min-height: 100vh;
  }

  .sidebar {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    gap: 12px;
    min-height: 100vh;
    padding: 18px;
    border-right: 1px solid #d8e2e6;
    background: #fffdf8;
  }

  .toolbar,
  .editor-header,
  .editor-actions,
  .import-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .toolbar,
  .editor-header {
    justify-content: space-between;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 18px;
  }

  h2 {
    font-size: 20px;
  }

  .toolbar button,
  .editor-actions button,
  .import-export button,
  .file-button {
    min-height: 34px;
    padding: 7px 10px;
  }

  .primary {
    color: #fff;
    border-color: #256b65;
    background: #2f7f78;
  }

  .search,
  input,
  textarea {
    width: 100%;
    border: 1px solid #b8c6cf;
    border-radius: 7px;
    color: #172026;
    background: #fff;
  }

  .search,
  input {
    min-height: 38px;
    padding: 8px 10px;
  }

  textarea {
    min-height: 280px;
    padding: 10px;
    resize: vertical;
  }

  input:focus,
  textarea:focus {
    border-color: #2f7f78;
    outline: 2px solid rgba(47, 127, 120, 0.2);
  }

  .template-list {
    display: grid;
    align-content: start;
    gap: 6px;
    overflow: auto;
  }

  .template-row {
    display: grid;
    gap: 3px;
    min-height: 58px;
    padding: 9px;
    text-align: left;
    background: #f6f0e7;
  }

  .template-row.selected {
    border-color: #2f7f78;
    background: #ecf4f1;
  }

  .row-title {
    overflow-wrap: anywhere;
    font-weight: 700;
  }

  .row-tags,
  .muted,
  .status {
    color: #526470;
    font-size: 12px;
  }

  .status.error {
    color: #9f3228;
  }

  .import-export {
    display: grid;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid #d8e2e6;
  }

  .file-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #b8c6cf;
    border-radius: 7px;
    background: #fff;
    cursor: pointer;
  }

  .file-button input {
    display: none;
  }

  .editor {
    min-width: 0;
    padding: 24px;
  }

  .editor-header {
    gap: 16px;
    margin-bottom: 18px;
  }

  .editor-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  label {
    display: grid;
    gap: 6px;
    color: #334650;
    font-size: 12px;
    font-weight: 700;
  }

  .wide,
  .body-field {
    grid-column: 1 / -1;
  }

  .favorite-check {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .favorite-check input {
    width: 16px;
    min-height: 16px;
  }

  @media (max-width: 800px) {
    .options-shell {
      grid-template-columns: 1fr;
    }

    .sidebar {
      min-height: auto;
      border-right: 0;
      border-bottom: 1px solid #d8e2e6;
    }

    .form-grid {
      grid-template-columns: 1fr;
    }
  }
`;

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Options page root element #root not found");
}

createRoot(rootElement).render(<OptionsApp />);
