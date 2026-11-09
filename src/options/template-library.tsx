import { useEffect, useMemo, useRef, useState } from "react";
import { localizeText, tr } from "../shared/i18n";
import { createTemplateSearch, type PromptTemplate } from "../shared/templates";

type LibrarySort = "ranked" | "manual" | "title" | "updated";

export type TemplateLibraryProps = {
  templates: PromptTemplate[];
  selectedId: string | null;
  saving: boolean;
  onSelect: (template: PromptTemplate) => void;
  onDeleteMany: (previous: PromptTemplate[]) => Promise<void>;
  onExport: (templates: PromptTemplate[]) => void;
  onReorder: (ids: string[], expected: PromptTemplate[]) => Promise<void>;
};

export function TemplateLibrary({
  templates, selectedId, saving, onSelect, onDeleteMany, onExport, onReorder,
}: TemplateLibraryProps) {
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSort] = useState<LibrarySort>("ranked");
  const [selection, setSelection] = useState<Map<string, string>>(new Map());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draggedId = useRef<string | null>(null);
  const search = useMemo(() => createTemplateSearch(templates), [templates]);
  const availableTags = useMemo(() => [...new Set(templates.flatMap((template) => template.tags))]
    .sort((left, right) => left.localeCompare(right)), [templates]);
  const selectedTemplates = templates.filter((template) => selection.get(template.id) === template.createdAt);
  const disabled = saving || pending;
  const canReorder = sort === "manual" && query.trim() === "" && tags.length === 0 && !disabled;

  useEffect(() => {
    const identities = new Map(templates.map((template) => [template.id, template.createdAt]));
    setSelection((current) => {
      const retained = [...current].filter(([id, createdAt]) => identities.get(id) === createdAt);
      return retained.length === current.size ? current : new Map(retained);
    });
    setTags((current) => {
      const retained = current.filter((tag) => availableTags.includes(tag));
      return retained.length === current.length ? current : retained;
    });
  }, [templates, availableTags]);

  const visibleTemplates = useMemo(() => {
    const matches = search(query).filter((template) => tags.every((tag) => template.tags.includes(tag)));
    if (sort === "manual") {
      const matchingIds = new Set(matches.map((template) => template.id));
      return templates.filter((template) => matchingIds.has(template.id));
    }
    if (sort === "title") {
      return matches.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    }
    if (sort === "updated") {
      return matches.sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0) ||
        left.title.localeCompare(right.title));
    }
    return matches;
  }, [query, search, sort, tags, templates]);

  function toggleSelection(template: PromptTemplate, checked: boolean): void {
    setSelection((current) => {
      const next = new Map(current);
      if (checked) next.set(template.id, template.createdAt);
      else next.delete(template.id);
      return next;
    });
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  function move(sourceId: string, targetId: string): void {
    if (!canReorder || sourceId === targetId) return;
    const ids = templates.map((template) => template.id);
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, sourceId);
    void perform(() => onReorder(ids, templates));
  }

  return (
    <section className="template-library" aria-label={tr("Template library")}>
      <style>{LIBRARY_STYLES}</style>
      <input className="search" type="search" aria-label={tr("Search templates")}
        placeholder={tr("Search templates")} value={query} onChange={(event) => setQuery(event.target.value)} />

      {availableTags.length > 0 ? (
        <fieldset className="library-tags">
          <legend>{tr("Filter by tags (match all)")}</legend>
          <div className="library-tag-list">
            {availableTags.map((tag) => (
              <button key={tag} type="button" className="library-tag" aria-pressed={tags.includes(tag)}
                onClick={() => setTags((current) => current.includes(tag)
                  ? current.filter((value) => value !== tag) : [...current, tag])}>
                {tag}
              </button>
            ))}
          </div>
          {tags.length > 0 ? <button type="button" className="library-clear-tags" onClick={() => setTags([])}>
            {tr("Clear tag filters")}
          </button> : null}
        </fieldset>
      ) : null}

      <label className="library-sort">
        <span>{tr("Sort templates")}</span>
        <select aria-label={tr("Sort templates")} value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
          <option value="ranked">{tr("Recommended")}</option>
          <option value="manual">{tr("Manual order")}</option>
          <option value="title">{tr("Title")}</option>
          <option value="updated">{tr("Recently updated")}</option>
        </select>
      </label>
      {sort === "manual" ? <p className="muted library-order-hint">
        {query.trim() || tags.length ? tr("Clear search and tag filters to reorder templates.")
          : tr("Drag the reorder handle or use Move up and Move down. This changes the Options list order.")}
      </p> : null}

      <div className="library-bulk" aria-label={tr("Bulk actions")}>
        <p className="muted" role="status">{tr("$1 selected", selectedTemplates.length)}</p>
        <div className="library-bulk-buttons">
          <button type="button" disabled={disabled || visibleTemplates.length === 0} onClick={() => {
            setSelection((current) => new Map([...current, ...visibleTemplates.map((template) =>
              [template.id, template.createdAt] as const)]));
          }}>{tr("Select visible")}</button>
          <button type="button" disabled={disabled || selectedTemplates.length === 0}
            onClick={() => setSelection(new Map())}>{tr("Clear selection")}</button>
          <button type="button" disabled={disabled || selectedTemplates.length === 0}
            onClick={() => onExport(selectedTemplates)}>{tr("Export selected")}</button>
          <button type="button" disabled={disabled || selectedTemplates.length === 0}
            onClick={() => void perform(() => onDeleteMany(selectedTemplates))}>{tr("Delete selected")}</button>
        </div>
      </div>

      {error ? <p className="library-error" role="alert">{localizeText(error)}</p> : null}
      <div className="template-list library-template-list">
        {visibleTemplates.length === 0 ? <p className="muted">{tr("No templates.")}</p> : visibleTemplates.map((template, index) => (
          <div className="library-row" key={template.id}
            onDragOver={(event) => {
              if (canReorder && draggedId.current) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId = draggedId.current;
              draggedId.current = null;
              if (sourceId) move(sourceId, template.id);
            }}>
            <label className="library-select">
              <input type="checkbox" checked={selection.get(template.id) === template.createdAt} disabled={disabled}
                aria-label={tr('Select "$1"', template.title)}
                onChange={(event) => toggleSelection(template, event.target.checked)} />
            </label>
            <button className={template.id === selectedId ? "template-row selected" : "template-row"}
              type="button" disabled={disabled} onClick={() => onSelect(template)}>
              <span className="row-title">{template.isFavorite ? "* " : ""}{template.title}</span>
              <span className="row-tags">{template.tags.join(", ")}</span>
            </button>
            {sort === "manual" ? <div className="library-order-actions">
              <button type="button" className="library-drag" draggable={canReorder} disabled={!canReorder}
                aria-label={tr('Reorder "$1"', template.title)} title={tr('Reorder "$1"', template.title)}
                onDragStart={(event) => {
                  if (!canReorder) { event.preventDefault(); return; }
                  draggedId.current = template.id;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", template.id);
                }}
                onDragEnd={() => { draggedId.current = null; }}>↕</button>
              <button type="button" disabled={!canReorder || index === 0}
                aria-label={tr('Move "$1" up', template.title)} title={tr("Move up")}
                onClick={() => move(template.id, visibleTemplates[index - 1].id)}>↑</button>
              <button type="button" disabled={!canReorder || index === visibleTemplates.length - 1}
                aria-label={tr('Move "$1" down', template.title)} title={tr("Move down")}
                onClick={() => move(template.id, visibleTemplates[index + 1].id)}>↓</button>
            </div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

const LIBRARY_STYLES = `
  .template-library { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .library-tags { min-width: 0; margin: 0; padding: 0; border: 0; }
  .library-tags legend { margin-bottom: 6px; color: var(--pc-muted); font-size: 12px; }
  .library-tag-list { display: flex; flex-wrap: wrap; gap: 5px; max-height: 100px; overflow: auto; }
  .library-tag, .library-clear-tags { padding: 4px 7px; font-size: 12px; }
  .library-tag[aria-pressed="true"] { color: var(--pc-accent-text); background: var(--pc-accent); border-color: var(--pc-accent); }
  .library-clear-tags { margin-top: 6px; }
  .library-sort { display: grid; gap: 5px; }
  .library-bulk { display: grid; gap: 6px; }
  .library-bulk-buttons { display: flex; flex-wrap: wrap; gap: 5px; }
  .library-bulk-buttons button { min-height: 28px; padding: 4px 6px; font-size: 11px; }
  .library-template-list { flex: 1 1 auto; min-height: 120px; }
  .library-row { display: flex; align-items: stretch; gap: 5px; min-width: 0; }
  .library-select { display: flex; align-items: center; justify-content: center; flex: 0 0 20px; }
  .library-select input { width: 16px; min-height: 16px; margin: 0; padding: 0; }
  .library-row > .template-row { flex: 1 1 auto; min-width: 0; }
  .library-order-actions { display: grid; gap: 2px; flex: 0 0 25px; }
  .library-order-actions button { padding: 0 3px; min-height: 20px; font-size: 12px; }
  .library-drag { cursor: grab; }
  .library-error { color: var(--pc-danger); font-size: 12px; }
`;
