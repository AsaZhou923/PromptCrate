import { MESSAGE_TYPE } from "./message-contract";

export const MEMORY_ENABLED_KEY = "promptCrate.rememberVariables";
export const MEMORY_VALUES_KEY = "promptCrate.variableValues";

export type VariableMemoryState = { enabled: boolean; values: Record<string, string> };

export function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

export async function loadVariableMemory(templateId?: string, createdAt?: string): Promise<VariableMemoryState> {
  return readState(await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.READ_VARIABLE_MEMORY, templateId, createdAt }));
}

export async function setVariableMemoryEnabled(enabled: boolean): Promise<VariableMemoryState> {
  return readState(await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.SET_VARIABLE_MEMORY, enabled }));
}

export async function clearVariableMemory(): Promise<VariableMemoryState> {
  return readState(await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.CLEAR_VARIABLE_MEMORY }));
}

export async function rememberVariableValues(templateId: string, values: Record<string, string>, createdAt: string): Promise<void> {
  readState(await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.REMEMBER_VARIABLE_VALUES, templateId, values, createdAt }));
}

function readState(response: unknown): VariableMemoryState {
  if (typeof response === "object" && response !== null) {
    const result = response as Record<string, unknown>;
    if (result.ok === false && typeof result.error === "string") throw new Error(result.error);
    if (result.ok === true && typeof result.enabled === "boolean" && isStringMap(result.values)) {
      return { enabled: result.enabled, values: Object.fromEntries(Object.entries(result.values)) };
    }
  }
  throw new Error("Invalid response from variable memory storage.");
}
