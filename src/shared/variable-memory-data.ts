import { extractTemplateVariables, type PromptTemplate } from "./templates";
import { isStringMap } from "./variable-memory";

export type VariableMemoryRecords = Record<string, { createdAt: string; values: Record<string, string> }>;

export function filterVariableValues(template: PromptTemplate, values: unknown): Record<string, string> {
  if (!isStringMap(values)) return {};
  return Object.fromEntries(extractTemplateVariables(template.body).flatMap((variable) => {
    if (variable.builtin || !Object.hasOwn(values, variable.name)) return [];
    const value = values[variable.name];
    if ((variable.required && !value.trim()) ||
      (value.trim() && variable.options && !variable.options.includes(value))) return [];
    return [[variable.name, value]];
  }));
}

export function pruneVariableMemory(raw: unknown, templates: PromptTemplate[]): VariableMemoryRecords {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const records = raw as Record<string, unknown>;
  return Object.fromEntries(templates.flatMap((template) => {
    if (!Object.hasOwn(records, template.id)) return [];
    const entry = records[template.id];
    if (typeof entry !== "object" || entry === null || !Object.hasOwn(entry, "createdAt") ||
      !Object.hasOwn(entry, "values")) return [];
    const record = entry as { createdAt: unknown; values: unknown };
    if (record.createdAt !== template.createdAt) return [];
    const values = filterVariableValues(template, record.values);
    return Object.keys(values).length ? [[template.id, { createdAt: template.createdAt, values }]] : [];
  }));
}
