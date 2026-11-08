import englishMessages from "../../public/_locales/en/messages.json";
import chineseMessages from "../../public/_locales/zh_CN/messages.json";

export type UiLocale = "en" | "zh_CN";
export type LanguagePreference = "system" | UiLocale;
export const LANGUAGE_STORAGE_KEY = "promptCrate.language";

interface Message {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
const catalogs: Record<UiLocale, Record<string, Message>> = { en: englishMessages, zh_CN: chineseMessages };
let currentPreference: LanguagePreference = "system";

function parsePreference(value: unknown): LanguagePreference {
  return value === "en" || value === "zh_CN" ? value : "system";
}

export function resolveLocale(preference?: unknown): UiLocale {
  if (preference === "en" || preference === "zh_CN") return preference;
  return typeof chrome !== "undefined" && chrome.i18n?.getUILanguage?.().toLowerCase().startsWith("zh")
    ? "zh_CN" : "en";
}

export async function getLanguagePreference(): Promise<LanguagePreference> {
  const stored = await chrome.storage.local.get([LANGUAGE_STORAGE_KEY]);
  return parsePreference(stored[LANGUAGE_STORAGE_KEY]);
}

export async function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  if (preference !== "system" && preference !== "en" && preference !== "zh_CN") {
    throw new Error("Invalid language preference.");
  }
  await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: preference });
  currentPreference = preference;
}

export function observeLanguage(callback: (preference: LanguagePreference, locale: UiLocale) => void): () => void {
  let active = true;
  let changed = false;
  const apply = (preference: LanguagePreference) => {
    if (!active) return;
    currentPreference = preference;
    callback(preference, resolveLocale(preference));
  };
  const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !(LANGUAGE_STORAGE_KEY in changes)) return;
    changed = true;
    apply(parsePreference(changes[LANGUAGE_STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(onChange);
  apply(currentPreference);
  void getLanguagePreference().then((preference) => {
    if (!changed) apply(preference);
  }).catch((error: unknown) => {
    if (active) console.warn("[prompt-crate] Could not load language preference", error);
  });
  return () => {
    active = false;
    chrome.storage.onChanged.removeListener(onChange);
  };
}

function normalize(message: Message): string {
  return message.message.replace(/\$([a-z][a-z0-9_]*)\$/gi, (token, name: string) =>
    message.placeholders?.[name.toLowerCase()]?.content ?? token);
}

function format(source: string, substitutions: readonly (string | number)[]): string {
  return source.replace(/\$(\d+)/g, (token, index: string) => String(substitutions[Number(index) - 1] ?? token));
}

const sourceKeys = new Map(Object.entries(catalogs.en)
  .filter(([key]) => !key.startsWith("default_") && key !== "ui_catalog_locale")
  .map(([key, message]) => [normalize(message), key]));

function translate(key: string, locale: UiLocale, substitutions: readonly (string | number)[]): string {
  // The loaded Chrome catalog can differ from getUILanguage (including OS and
  // regional fallbacks). Its own marker proves which language getMessage uses.
  if (typeof chrome !== "undefined" && chrome.i18n?.getMessage && chrome.i18n.getMessage("ui_catalog_locale") === locale) {
    const native = chrome.i18n.getMessage(key, substitutions.map(String));
    if (native) return native;
  }
  return format(normalize(catalogs[locale][key] ?? catalogs.en[key]), substitutions);
}

export function tr(source: string, ...substitutions: (string | number)[]): string {
  return trForLocale(resolveLocale(currentPreference), source, ...substitutions);
}

export function trForLocale(locale: UiLocale, source: string, ...substitutions: (string | number)[]): string {
  const key = sourceKeys.get(source);
  return key ? translate(key, locale, substitutions) : format(source, substitutions);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patterns = [...sourceKeys].filter(([source]) => /\$\d+/.test(source)).map(([source, key]) => {
  const indices: number[] = [];
  let position = 0;
  let pattern = "";
  for (const match of source.matchAll(/\$(\d+)/g)) {
    pattern += escapeRegex(source.slice(position, match.index)) + "([\\s\\S]*?)";
    indices.push(Number(match[1]) - 1);
    position = match.index + match[0].length;
  }
  return { key, indices, expression: new RegExp("^" + pattern + escapeRegex(source.slice(position)) + "$"), source };
}).sort((left, right) => right.source.length - left.source.length);

export function localizeText(text: string): string {
  if (sourceKeys.has(text)) return tr(text);
  for (const { key, indices, expression } of patterns) {
    const match = expression.exec(text);
    if (!match) continue;
    const substitutions: string[] = [];
    indices.forEach((index, capture) => { substitutions[index] = match[capture + 1]; });
    return translate(key, resolveLocale(currentPreference), substitutions);
  }
  return text;
}

export function localizeDefaultSeed<T extends { id: string; title: string; body: string; tags: string[] }>(seed: T, locale: UiLocale): T {
  if (locale === "en") return { ...seed, tags: [...seed.tags] };
  const prefix = "default_" + seed.id.replace(/-/g, "_");
  const catalog = catalogs[locale];
  return {
    ...seed,
    title: catalog[prefix + "_title"]?.message ?? seed.title,
    body: catalog[prefix + "_body"]?.message ?? seed.body,
    tags: catalog[prefix + "_tags"]?.message.split(",") ?? [...seed.tags],
  };
}
