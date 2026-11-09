import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TemplateLibrary } from "./template-library";
import { ImportPreview } from "./import-preview";
import { LibraryHealth } from "./library-health";
import { VariablePreview } from "./variable-preview";
import { localizeText, observeLanguage, setLanguagePreference, tr, type LanguagePreference } from "../shared/i18n";
import {
  clearVariableMemory, loadVariableMemory, MEMORY_ENABLED_KEY, setVariableMemoryEnabled,
} from "../shared/variable-memory";
import {
  createTemplateExportPayload,
  parseTemplateImportJson,
  parseTemplateBackup,
  TemplateExportPayload,
} from "../shared/import-export";
import { loadPromptTemplates, commitTemplateMutation, loadLibraryMetadata, type LibraryMetadata, type TemplateBackup } from "../shared/template-client";
import { sameTemplateRevision, type TemplateMutation, type MutationResult } from "../shared/template-mutations";
import {
  getThemePreference, observeTheme, parseThemePreference, setThemePreference,
  THEME_STORAGE_KEY, THEME_STYLES, type ThemePreference,
} from "../shared/theme";
import {
  normalizeTags,
  normalizeTemplate,
  PromptTemplate,
  STORAGE_KEYS,
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

type EditorState = {
  selectedId: string | null;
  form: TemplateFormState;
  baseline: PromptTemplate | null;
};

const EMPTY_EDITOR: EditorState = { selectedId: null, form: EMPTY_FORM, baseline: null };
type PendingImport = { payload: TemplateExportPayload; expected: PromptTemplate[] };

function OptionsApp() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const { selectedId, form, baseline } = editor;
  const editorRef = useRef(editor);
  const writingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const [status, setStatus] = useState("Loading templates...");
  const [error, setError] = useState<string | string[] | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [metadata, setMetadata] = useState<LibraryMetadata | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const templatesRef = useRef(templates);
  templatesRef.current = templates;
  const formRef = useRef<HTMLFormElement>(null);
  const importSequence = useRef(0);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [themeSaving, setThemeSaving] = useState(false);
  const [shortcut, setShortcut] = useState<string | null | undefined>(undefined);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [language, setLanguage] = useState<LanguagePreference>("system");
  const [languageSaving, setLanguageSaving] = useState(false);
  const [rememberVariables, setRememberVariables] = useState(false);
  const [memorySaving, setMemorySaving] = useState(true);
  const [, setLocaleRevision] = useState(0);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!isEditorDirty(editorRef.current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const saveKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !event.isComposing) {
        event.preventDefault();
        if (!event.repeat && !writingRef.current) formRef.current?.requestSubmit();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("keydown", saveKey);
    return () => {
      importSequence.current += 1;
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", saveKey);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const value = await loadLibraryMetadata();
        if (mounted && request === sequence) {
          setMetadata(value);
          setMetadataError(null);
        }
      } catch (error) {
        if (mounted && request === sequence) setMetadataError(`Could not load library details. ${getErrorMessage(error)}`);
      }
    };
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local") void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    void refresh();
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);

  useEffect(() => observeLanguage((preference, locale) => {
    document.documentElement.lang = locale === "zh_CN" ? "zh-CN" : "en";
    setLanguage(preference);
    // A system preference can resolve differently without changing its stored value.
    setLocaleRevision((revision) => revision + 1);
  }), []);

  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !(MEMORY_ENABLED_KEY in changes)) return;
      preferenceChanged = true;
      setRememberVariables(changes[MEMORY_ENABLED_KEY].newValue === true);
    };
    chrome.storage.onChanged.addListener(onChanged);
    void loadVariableMemory().then((value) => {
      if (mounted && !preferenceChanged) setRememberVariables(value.enabled);
    }).catch((error: unknown) => {
      if (mounted) setPreferencesError(`Could not update variable memory. ${getErrorMessage(error)}`);
    }).finally(() => {
      if (mounted) setMemorySaving(false);
    });
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    const stopObserving = observeTheme(document.documentElement);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !(THEME_STORAGE_KEY in changes)) return;
      preferenceChanged = true;
      setTheme(parseThemePreference(changes[THEME_STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    void getThemePreference().then((value) => {
      if (mounted && !preferenceChanged) setTheme(value);
    }).catch((error: unknown) => {
      if (mounted) setPreferencesError(`Could not load theme. ${getErrorMessage(error)}`);
    });
    void chrome.commands.getAll().then((commands) => {
      if (mounted) setShortcut(commands.find((command) => command.name === "open-prompt-menu")?.shortcut ?? "");
    }).catch((error: unknown) => {
      if (mounted) {
        setShortcut(null);
        setPreferencesError(`Could not read the shortcut. ${getErrorMessage(error)}`);
      }
    });
    return () => {
      mounted = false;
      stopObserving();
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const items = await loadPromptTemplates();
        if (!mounted || request !== sequence) {
          return;
        }
        setTemplates(items);
        setStatus((current) => current === "Loading templates..." || current === "Could not load templates."
          ? `${items.length} templates loaded.` : current);
        const current = editorRef.current;
        if (writingRef.current || !current.selectedId) {
          return;
        }
        const latest = items.find((item) => item.id === current.selectedId);
        if (sameTemplateRevision(latest, current.baseline)) {
          return;
        }
        const originalForm = current.baseline ? templateToForm(current.baseline) : EMPTY_FORM;
        if (JSON.stringify(current.form) === JSON.stringify(originalForm)) {
          replaceEditor(latest
            ? { selectedId: latest.id, form: templateToForm(latest), baseline: latest }
            : EMPTY_EDITOR);
          setError(null);
        } else {
          setError(latest
            ? "Template changed in another tab. Your draft is preserved. Reselect the template to load the latest version before saving."
            : "Template was deleted in another tab. Your draft is preserved. Use Keep as new to save a copy.");
        }
      } catch (caughtError) {
        if (mounted && request === sequence) {
          setError(getErrorMessage(caughtError));
          setStatus((current) => current === "Loading templates..." ? "Could not load templates." : current);
        }
      }
    };
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && STORAGE_KEYS.templates in changes) {
        void refresh();
      }
    };
    refreshRef.current = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    void refresh();
    return () => {
      mounted = false;
      sequence += 1;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  function replaceEditor(next: EditorState): void {
    editorRef.current = next;
    setEditor(next);
  }

  function setForm(update: (current: TemplateFormState) => TemplateFormState): void {
    const current = editorRef.current;
    replaceEditor({ ...current, form: update(current.form) });
  }

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [selectedId, templates],
  );

  const hasConflict = baseline !== null && !sameTemplateRevision(selectedTemplate, baseline);

  function mayDiscardDraft(): boolean {
    return !isEditorDirty(editorRef.current) || confirm(tr("Discard unsaved changes?"));
  }

  function selectTemplate(template: PromptTemplate): void {
    if (editorRef.current.selectedId === template.id && sameTemplateRevision(editorRef.current.baseline, template)) return;
    if (writingRef.current || !mayDiscardDraft()) return;
    replaceEditor({ selectedId: template.id, form: templateToForm(template), baseline: template });
    setError(null);
  }

  function startNewTemplate(): void {
    if (writingRef.current || !mayDiscardDraft()) return;
    replaceEditor(EMPTY_EDITOR);
    setError(null);
    setStatus("New template.");
  }

  async function changeTheme(value: ThemePreference): Promise<void> {
    setThemeSaving(true);
    setPreferencesError(null);
    try {
      await setThemePreference(value);
      setTheme(value);
    } catch (error) {
      setPreferencesError(`Could not save the theme. ${getErrorMessage(error)}`);
    } finally {
      setThemeSaving(false);
    }
  }

  async function changeLanguage(value: LanguagePreference): Promise<void> {
    setLanguageSaving(true);
    setPreferencesError(null);
    try {
      await setLanguagePreference(value);
      setLanguage(value);
    } catch (error) {
      setPreferencesError(`Could not save language. ${getErrorMessage(error)}`);
    } finally {
      setLanguageSaving(false);
    }
  }

  async function updateVariableMemory(enabled?: boolean): Promise<void> {
    setMemorySaving(true);
    setPreferencesError(null);
    try {
      const next = enabled === undefined
        ? await clearVariableMemory() : await setVariableMemoryEnabled(enabled);
      setRememberVariables(next.enabled);
      if (enabled === undefined) setStatus("Remembered values cleared.");
    } catch (error) {
      setPreferencesError(`Could not update variable memory. ${getErrorMessage(error)}`);
    } finally {
      setMemorySaving(false);
    }
  }

  async function configureShortcut(): Promise<void> {
    setPreferencesError(null);
    try {
      await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    } catch (error) {
      setPreferencesError(`Could not open shortcut settings. ${getErrorMessage(error)}`);
    }
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const now = new Date().toISOString();
    const existing = baseline;
    if (selectedId && !existing) {
      setError("Selected template no longer exists. Select a template or create a new one.");
      return;
    }

    const candidate = normalizeTemplate({
      id: form.id.trim() || createTemplateId(form.title),
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
      setError(validationErrors.map((item) => item.message));
      return;
    }

    const duplicate = templates.find(
      (template) => template.id === candidate.id && template.id !== selectedId,
    );

    if (form.id.trim() && duplicate) {
      setError("Template ID already exists.");
      return;
    }

    await persistMutation({
      kind: "save", template: candidate, previous: existing,
      autoId: form.id.trim() ? undefined : createTemplateId(form.title),
    }, () => `Saved "${candidate.title}".`, (result) => {
      const saved = result.templates.find((item) => item.id === result.savedId)!;
      replaceEditor({ selectedId: saved.id, form: templateToForm(saved), baseline: saved });
    });
  }

  async function deleteTemplate(): Promise<void> {
    if (!selectedTemplate || !baseline) {
      return;
    }

    if (!mayDiscardDraft()) return;

    if (!confirm(tr('Delete "$1"?', selectedTemplate.title))) {
      return;
    }

    await persistMutation({ kind: "delete", previous: baseline },
      () => `Deleted "${selectedTemplate.title}".`, () => replaceEditor(EMPTY_EDITOR));
  }

  async function duplicateTemplate(): Promise<void> {
    if (!selectedTemplate) {
      return;
    }

    if (!mayDiscardDraft()) return;

    const now = new Date().toISOString();
    const copy: PromptTemplate = {
      ...selectedTemplate,
      id: `${selectedTemplate.id}-copy`,
      title: `${selectedTemplate.title} copy`,
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: undefined,
    };
    await persistMutation({
      kind: "save", template: copy, previous: null, autoId: `${selectedTemplate.id}-copy`,
    }, () => `Copied "${selectedTemplate.title}".`, (result) => {
      const saved = result.templates.find((item) => item.id === result.savedId)!;
      replaceEditor({ selectedId: saved.id, form: templateToForm(saved), baseline: saved });
    });
  }

  function exportTemplates(items: PromptTemplate[] = templates): void {
    downloadJson(createTemplateExportPayload(items), `promptcrate-templates-${new Date().toISOString().slice(0, 10)}.json`);
    setStatus(`Exported ${items.length} templates.`);
  }

  async function deleteMany(previous: PromptTemplate[]): Promise<void> {
    if (previous.some((item) => item.id === editorRef.current.selectedId) && !mayDiscardDraft()) return;
    if (!confirm(tr("Delete $1 selected templates?", previous.length))) return;
    await persistMutation({ kind: "deleteMany", previous }, () => `Deleted ${previous.length} templates.`, () => {
      if (previous.some((item) => item.id === editorRef.current.selectedId)) replaceEditor(EMPTY_EDITOR);
    });
  }

  async function reorder(ids: string[], expected: PromptTemplate[]): Promise<void> {
    await persistMutation({ kind: "reorder", ids, expected }, () => "Template order saved.", () => {});
  }

  function recoverBackup(backup: TemplateBackup): void {
    importSequence.current += 1;
    const recovered = parseTemplateBackup(backup.templates);
    if (!recovered.templates.length) {
      setError("No valid templates could be recovered. Export the backup to inspect it.");
      return;
    }
    setPendingImport({ payload: createTemplateExportPayload(recovered.templates), expected: templatesRef.current });
    setError(null);
    setStatus(`Recovered ${recovered.templates.length} templates for preview; skipped ${recovered.skipped} invalid entries.`);
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    const request = ++importSequence.current;
    const expected = templatesRef.current;
    let parsed: ReturnType<typeof parseTemplateImportJson>;
    try {
      parsed = parseTemplateImportJson(await file.text());
    } catch (error) {
      if (request === importSequence.current) {
        setError(getErrorMessage(error));
        setStatus("Import failed.");
      }
      return;
    }
    if (request !== importSequence.current) return;

    if (!parsed.ok) {
      setError(parsed.error);
      setStatus("Import failed.");
      return;
    }

    setError(null);
    setPendingImport({ payload: parsed.payload, expected });
    setStatus(`${parsed.payload.templates.length} templates ready to import.`);
  }

  async function applyPendingImport(items: PromptTemplate[], mode: "merge" | "overwrite"): Promise<void> {
    if (!pendingImport) {
      return;
    }

    if (items.length === 0 || !mayDiscardDraft()) return;

    if (mode === "overwrite" && !confirm(tr("Overwrite all existing templates?"))) {
      return;
    }

    const importing = pendingImport;
    // A file read started before this explicit application must not replace its preview mid-write.
    importSequence.current += 1;
    await persistMutation({ kind: "import", templates: items, mode, expected: pendingImport.expected },
      (result) => result.overwritten
        ? `Imported ${result.added} templates by overwrite.`
        : `Imported ${result.added} new and ${result.updated} updated templates.`,
      (result) => {
        const selected = result.templates.find((template) => template.id === selectedId);
        replaceEditor(selected
          ? { selectedId: selected.id, form: templateToForm(selected), baseline: selected }
          : EMPTY_EDITOR);
        setPendingImport((current) => current === importing ? null : current);
      });
  }

  async function persistMutation(
    mutation: TemplateMutation,
    message: (result: MutationResult) => string,
    onSuccess: (result: MutationResult) => void,
  ): Promise<void> {
    if (writingRef.current) {
      return;
    }
    writingRef.current = true;
    setSaving(true);
    setError(null);

    try {
      const result = await commitTemplateMutation(mutation);
      setTemplates(result.templates);
      onSuccess(result);
      setStatus(message(result));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
      setStatus("Save failed.");
    } finally {
      writingRef.current = false;
      setSaving(false);
      void refreshRef.current();
    }
  }

  return (
    <main className="options-shell">
      <style>{OPTIONS_STYLES}</style>

      <aside className="sidebar" aria-label={tr("Templates")}>
        <div className="toolbar">
          <h1>PromptCrate</h1>
          <button type="button" disabled={saving} onClick={startNewTemplate}>
            {tr("New")}
          </button>
        </div>

        <details className="preferences">
          <summary>{tr("Preferences")}</summary>
          <div className="preferences-controls">
          <label>
            <span>{tr("Language")}</span>
            <select value={language} disabled={languageSaving} onChange={(event) => void changeLanguage(event.target.value as LanguagePreference)}>
              <option value="system">{tr("System")}</option>
              <option value="en">English</option>
              <option value="zh_CN">简体中文</option>
            </select>
          </label>
          <label>
            <span>{tr("Theme")}</span>
            <select value={theme} disabled={themeSaving} onChange={(event) => void changeTheme(event.target.value as ThemePreference)}>
              <option value="system">{tr("System")}</option>
              <option value="light">{tr("Light")}</option>
              <option value="dark">{tr("Dark")}</option>
            </select>
          </label>
          <p className="muted">
            {shortcut === undefined ? tr("Loading shortcut...") : shortcut === null
              ? tr("Shortcut unavailable. Use the toolbar button or configure a shortcut.") : shortcut
              ? tr("Shortcut: $1", shortcut) : tr("Shortcut not assigned. Use the toolbar button or configure a shortcut.")}
          </p>
          <button type="button" onClick={() => void configureShortcut()}>{tr("Configure shortcut")}</button>
          <label className="favorite-check">
            <input type="checkbox" checked={rememberVariables} disabled={memorySaving}
              onChange={(event) => void updateVariableMemory(event.target.checked)} />
            <span>{tr("Remember variable values")}</span>
          </label>
          <p className="muted">{tr("Variable values are saved only on this device after you opt in. Turning this off clears remembered values.")}</p>
          <button type="button" disabled={memorySaving} onClick={() => void updateVariableMemory()}>{tr("Clear remembered values")}</button>
          {preferencesError ? <p className="preference-error" role="status">{localizeText(preferencesError)}</p> : null}
          </div>
        </details>

        <TemplateLibrary templates={templates} selectedId={selectedId} saving={saving}
          onSelect={selectTemplate} onDeleteMany={deleteMany} onExport={exportTemplates} onReorder={reorder} />

        <section className="import-export" aria-label={tr("Import and export")}>
          <button type="button" onClick={() => exportTemplates()}>
            {tr("Export JSON")}
          </button>
          <label className="file-button">
            {tr("Import JSON")}
            <input type="file" disabled={saving} accept="application/json" onChange={handleImportFile} />
          </label>
        </section>
      </aside>

      <section className="editor" aria-label={tr("Template editor")}>
        <LibraryHealth metadata={metadata} error={metadataError} saving={saving} onRecover={recoverBackup}
          onExportBackup={(backup) => downloadJson(backup.templates, `promptcrate-backup-${backup.id.replace(/[^a-z0-9_.-]/gi, "_")}.json`)} />
        {pendingImport ? <ImportPreview payload={pendingImport.payload} existing={templates} saving={saving}
          onApply={applyPendingImport} onCancel={() => { importSequence.current += 1; setPendingImport(null); }} /> : null}
        <form ref={formRef} onSubmit={(event) => void saveTemplate(event)}>
          <fieldset className="editor-fields" disabled={saving}>
          <div className="editor-header">
            <div>
              <h2>{tr(selectedTemplate ? "Edit template" : "New template")}</h2>
              <p className={error ? "status error" : "status"}>
                {Array.isArray(error) ? error.map(localizeText).join(" ") : localizeText(error ?? status)}
              </p>
            </div>

            <div className="editor-actions">
              {hasConflict ? (
                <button type="button" onClick={() => {
                  replaceEditor({ selectedId: null, baseline: null, form: { ...form, id: "" } });
                  setError(null);
                  setStatus("Draft kept as a new template. Click Save to create it.");
                }}>
                  {tr("Keep as new")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={!selectedTemplate}
                onClick={() => void duplicateTemplate()}
              >
                {tr("Copy")}
              </button>
              <button
                type="button"
                disabled={!selectedTemplate}
                onClick={() => void deleteTemplate()}
              >
                {tr("Delete")}
              </button>
              <button type="submit" className="primary">
                {tr("Save")}
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
              <span>{tr("Title")}</span>
              <input
                value={form.title}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    title: event.target.value,
                  }))
                }
                placeholder={tr("Rewrite clearer")}
              />
            </label>

            <label className="wide">
              <span>{tr("Tags")}</span>
              <input
                value={form.tags}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    tags: event.target.value,
                  }))
                }
                placeholder={tr("writing, rewrite")}
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
              <span>{tr("Favorite")}</span>
            </label>

            <label className="body-field">
              <span>{tr("Body")}</span>
              <textarea
                aria-label={tr("Body")}
                value={form.body}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    body: event.target.value,
                  }))
                }
                placeholder={tr("Rewrite {{text}} in a clearer tone.")}
              />
            </label>
          </div>
          <VariablePreview body={form.body} />
          </fieldset>
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

function isEditorDirty(editor: EditorState): boolean {
  return JSON.stringify(editor.form) !== JSON.stringify(editor.baseline ? templateToForm(editor.baseline) : EMPTY_FORM);
}

function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function splitTags(tags: string): string[] {
  return tags.split(/[,，、;；\r\n]+/);
}

function createTemplateId(title: string): string {
  const slug = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || `template-${Date.now()}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OPTIONS_STYLES = `
  ${THEME_STYLES}
  :root {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--pc-text);
    background: var(--pc-bg);
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
  }

  .editor-fields {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  button,
  input,
  textarea,
  select {
    font: inherit;
  }

  button {
    border: 1px solid var(--pc-border);
    border-radius: 7px;
    color: var(--pc-text);
    background: var(--pc-input);
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    border-color: var(--pc-accent);
    outline: none;
  }

  .options-shell {
    display: grid;
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
    min-height: 100vh;
  }

  .sidebar {
    display: grid;
    grid-template-rows: auto auto minmax(min-content, 1fr) auto;
    gap: 12px;
    min-height: 0;
    height: 100vh;
    overflow-y: auto;
    padding: 18px;
    border-right: 1px solid var(--pc-divider);
    background: var(--pc-surface);
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
    color: var(--pc-accent-text);
    border-color: var(--pc-accent);
    background: var(--pc-accent);
  }

  .search,
  input,
  textarea,
  select {
    width: 100%;
    border: 1px solid var(--pc-border);
    border-radius: 7px;
    color: var(--pc-text);
    background: var(--pc-input);
  }

  .search,
  input,
  select {
    min-height: 38px;
    padding: 8px 10px;
  }

  textarea {
    min-height: 280px;
    padding: 10px;
    resize: vertical;
  }

  input:focus,
  textarea:focus,
  select:focus {
    border-color: var(--pc-accent);
    outline: 2px solid var(--pc-focus);
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
    background: var(--pc-item);
  }

  .template-row.selected {
    border-color: var(--pc-accent);
    background: var(--pc-selected);
  }

  .row-title {
    overflow-wrap: anywhere;
    font-weight: 700;
  }

  .row-tags,
  .muted,
  .status {
    color: var(--pc-muted);
    font-size: 12px;
  }

  .status.error {
    color: var(--pc-danger);
  }

  .preferences {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--pc-divider);
  }

  .preferences summary { cursor: pointer; font-size: 12px; font-weight: 700; padding: 6px 0; }
  .preferences-controls { display: grid; gap: 8px; padding-top: 10px; }

  .preferences button {
    min-height: 34px;
    padding: 7px 10px;
  }

  .preference-error {
    color: var(--pc-danger);
    font-size: 12px;
  }

  .import-export {
    display: grid;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--pc-divider);
  }

  .file-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--pc-border);
    border-radius: 7px;
    background: var(--pc-input);
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
    color: var(--pc-text);
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
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--pc-divider);
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
