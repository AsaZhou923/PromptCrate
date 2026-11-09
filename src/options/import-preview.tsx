import { useState } from "react";
import { tr } from "../shared/i18n";
import type { ImportMode, TemplateExportPayload } from "../shared/import-export";
import type { PromptTemplate } from "../shared/templates";

type ImportPreviewProps = {
  payload: TemplateExportPayload;
  existing: PromptTemplate[];
  saving: boolean;
  onApply: (templates: PromptTemplate[], mode: ImportMode) => Promise<void>;
  onCancel: () => void;
};

export function ImportPreview({ payload, existing, saving, onApply, onCancel }: ImportPreviewProps) {
  const [selection, setSelection] = useState(() => ({
    payload,
    ids: new Set(payload.templates.map((template) => template.id)),
  }));
  const selectedIds = selection.payload === payload
    ? selection.ids : new Set(payload.templates.map((template) => template.id));
  const selected = payload.templates.filter((template) => selectedIds.has(template.id));
  const existingIds = new Set(existing.map((template) => template.id));
  const added = selected.filter((template) => !existingIds.has(template.id)).length;
  const replaced = selected.length - added;

  function toggleTemplate(id: string, checked: boolean): void {
    const ids = new Set(selectedIds);
    if (checked) ids.add(id);
    else ids.delete(id);
    setSelection({ payload, ids });
  }

  return (
    <section className="import-preview" aria-label={tr("Import preview")}>
      <style>{IMPORT_PREVIEW_STYLES}</style>
      <div className="import-preview-heading">
        <h3>{tr("Import preview")}</h3>
        <button type="button" disabled={saving} onClick={onCancel}>{tr("Cancel import")}</button>
      </div>
      <p className="import-preview-summary" role="status">
        {tr("New: $1 · Replace: $2", added, replaced)}
      </p>
      <div className="import-preview-selection">
        <button type="button" disabled={saving || selected.length === payload.templates.length}
          onClick={() => setSelection({ payload, ids: new Set(payload.templates.map((template) => template.id)) })}>
          {tr("Select all imports")}
        </button>
        <button type="button" disabled={saving || selected.length === 0}
          onClick={() => setSelection({ payload, ids: new Set() })}>
          {tr("Clear import selection")}
        </button>
      </div>
      <ul className="import-preview-list">
        {payload.templates.map((template) => (
          <li key={template.id}>
            <label>
              <input type="checkbox" checked={selectedIds.has(template.id)} disabled={saving}
                aria-label={tr('Import "$1"', template.title)}
                onChange={(event) => toggleTemplate(template.id, event.target.checked)} />
              <span className="import-preview-template">
                <strong>{template.title}</strong>
                <span>{template.id}</span>
              </span>
              <span className="import-preview-kind">
                {tr(existingIds.has(template.id) ? "Replace existing" : "New template")}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {payload.templates.length === 0 ? <p>{tr("No templates to import.")}</p> : null}
      <p className="import-preview-explanation">
        {tr("Merge keeps other templates. Overwrite replaces the entire library with only the selected imports.")}
      </p>
      <div className="import-actions">
        <button type="button" disabled={saving || selected.length === 0}
          onClick={() => void onApply(selected, "merge")}>
          {tr("Merge")}
        </button>
        <button type="button" disabled={saving || selected.length === 0}
          onClick={() => void onApply(selected, "overwrite")}>
          {tr("Overwrite")}
        </button>
      </div>
    </section>
  );
}

const IMPORT_PREVIEW_STYLES = `
  .import-preview { display: grid; gap: 10px; min-width: 0; padding: 12px; border: 1px solid var(--pc-border); border-radius: 8px; }
  .import-preview-heading, .import-preview-selection { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .import-preview-heading { justify-content: space-between; }
  .import-preview h3 { margin: 0; font-size: 14px; }
  .import-preview-summary { font-size: 12px; font-weight: 700; }
  .import-preview-list { display: grid; gap: 8px; max-height: 220px; overflow: auto; padding: 0; margin: 0; list-style: none; }
  .import-preview-list label { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; background: var(--pc-item); }
  .import-preview-list input { width: 16px; min-height: 16px; flex: 0 0 16px; padding: 0; }
  .import-preview-template { display: grid; min-width: 0; flex: 1; gap: 3px; overflow-wrap: anywhere; }
  .import-preview-template > span, .import-preview-kind, .import-preview-explanation { color: var(--pc-muted); font-size: 12px; font-weight: 400; }
  .import-preview-kind { flex: 0 0 auto; }
  .import-preview .import-actions { flex-wrap: wrap; }
`;
