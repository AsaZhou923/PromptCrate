import { useEffect, useMemo, useState } from "react";
import { localizeText, tr } from "../shared/i18n";
import { extractTemplateVariables, getTemplateDefaultValues, renderTemplate, validateTemplate } from "../shared/templates";

export function VariablePreview({ body }: { body: string }) {
  const variables = useMemo(() => extractTemplateVariables(body), [body]);
  const defaults = useMemo(() => getTemplateDefaultValues(body), [body]);
  const [draft, setDraft] = useState({ body, values: defaults });
  const values = draft.body === body ? draft.values : defaults;
  useEffect(() => setDraft({ body, values: defaults }), [body, defaults]);
  const diagnostics = useMemo(() => validateTemplate({
    id: "preview", title: "Preview", body, tags: [], isFavorite: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }).filter((error) => error.field === "variables"), [body]);
  const context = {
    "@date": "2026-01-01", "@time": "12:00", "@url": "https://example.com/",
    "@title": tr("Example page"), "@selection": tr("Example selected text"),
  };
  return <section className="variable-preview" aria-label={tr("Template preview")}>
    <style>{`
      .variable-preview { display:grid; min-width:0; overflow-wrap:anywhere; gap:10px; margin-top:20px; padding:14px; border:1px solid var(--pc-divider); border-radius:8px; }
      .variable-preview h3 { margin:0; font-size:14px; }
      .variable-preview ul { margin:0; padding-left:20px; font-size:12px; }
      .variable-preview .preview-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; }
      .variable-preview textarea { min-height:64px; max-height:140px; }
      .variable-preview .template-preview { max-height:240px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; margin:0; padding:12px; background:var(--pc-preview-bg); border-radius:6px; }
      .variable-preview .variable-diagnostics { color:var(--pc-danger); }
    `}</style>
    <h3>{tr("Variables")}</h3>
    {variables.length ? <ul>{variables.map((variable) => <li key={variable.name}>
      {variable.label ?? variable.name} — {tr(variable.builtin ? "Automatic" : variable.required ? "Required" : "Optional")}
    </li>)}</ul> : <p className="muted">{tr("No variables detected.")}</p>}
    {diagnostics.length > 0 && <ul className="variable-diagnostics" role="alert">
      {diagnostics.map((error) => <li key={error.message}>{localizeText(error.message)}</li>)}
    </ul>}
    <div className="preview-fields">{variables.filter((variable) => !variable.builtin).map((variable) => {
      const value = Object.hasOwn(values, variable.name) ? values[variable.name] : "";
      const update = (value: string) => setDraft({ body, values: { ...values, [variable.name]: value } });
      return <label key={variable.name}>
        <span>{tr("Preview value: $1", variable.label ?? variable.name)}</span>
        {variable.options ? <select aria-label={tr("Preview value: $1", variable.label ?? variable.name)} value={value} onChange={(event) => update(event.target.value)}>
          {!variable.required && <option value="">{tr("(optional)")}</option>}
          {variable.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select> : <textarea aria-label={tr("Preview value: $1", variable.label ?? variable.name)} value={value} onChange={(event) => update(event.target.value)} />}
      </label>;
    })}</div>
    <pre className="template-preview">{renderTemplate(body, values, { preview: true, context })}</pre>
    <p className="muted">{tr("Preview values are examples and are not saved. Built-in values use sample page information.")}</p>
  </section>;
}
