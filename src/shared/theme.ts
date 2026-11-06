export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "promptCrate.theme";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export async function getThemePreference(): Promise<ThemePreference> {
  const stored = await chrome.storage.local.get([THEME_STORAGE_KEY]);
  return parseThemePreference(stored[THEME_STORAGE_KEY]);
}

export async function setThemePreference(value: ThemePreference): Promise<void> {
  if (value !== "system" && value !== "light" && value !== "dark") {
    throw new Error("Invalid theme preference.");
  }
  await chrome.storage.local.set({ [THEME_STORAGE_KEY]: value });
}

export function observeTheme(target: HTMLElement): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference: ThemePreference = "system";
  let active = true;
  let changed = false;
  const apply = () => {
    target.dataset.theme = preference === "system" ? (media.matches ? "dark" : "light") : preference;
  };
  const onMediaChange = () => {
    if (preference === "system") apply();
  };
  const onStorageChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !(THEME_STORAGE_KEY in changes)) return;
    changed = true;
    preference = parseThemePreference(changes[THEME_STORAGE_KEY].newValue);
    apply();
  };
  apply();
  media.addEventListener("change", onMediaChange);
  chrome.storage.onChanged.addListener(onStorageChange);
  void getThemePreference().then((value) => {
    if (!active || changed) return;
    preference = value;
    apply();
  }).catch((error: unknown) => {
    console.warn("[prompt-crate] Could not load theme preference", error);
  });
  return () => {
    active = false;
    media.removeEventListener("change", onMediaChange);
    chrome.storage.onChanged.removeListener(onStorageChange);
  };
}

const LIGHT_THEME = `
  color-scheme: light;
  --pc-bg: #f8faf9;
  --pc-surface: #fffdf8;
  --pc-input: #ffffff;
  --pc-text: #172026;
  --pc-muted: #526470;
  --pc-border: #b8c6cf;
  --pc-divider: #d8e2e6;
  --pc-item: #f6f0e7;
  --pc-selected: #ecf4f1;
  --pc-accent: #2f7f78;
  --pc-accent-text: #ffffff;
  --pc-focus: rgba(47, 127, 120, 0.2);
  --pc-danger: #9f3228;
  --pc-preview-bg: #f2f7f5;
  --pc-preview-border: #d6e2de;
  --pc-shadow: rgba(23, 32, 38, 0.18);
`;

const DARK_THEME = `
  color-scheme: dark;
  --pc-bg: #10191d;
  --pc-surface: #18262c;
  --pc-input: #142127;
  --pc-text: #e2edef;
  --pc-muted: #a9bec5;
  --pc-border: #49616a;
  --pc-divider: #314951;
  --pc-item: #22333b;
  --pc-selected: #294b48;
  --pc-accent: #73c8ba;
  --pc-accent-text: #102421;
  --pc-focus: rgba(115, 200, 186, 0.28);
  --pc-danger: #ffb4a7;
  --pc-preview-bg: #182e31;
  --pc-preview-border: #3d5d60;
  --pc-shadow: rgba(0, 0, 0, 0.4);
`;

// Separate selectors keep document and shadow styles valid in their own contexts.
export const THEME_STYLES = `
  :root { ${LIGHT_THEME} }
  :host { ${LIGHT_THEME} }
  :root[data-theme="dark"] { ${DARK_THEME} }
  :host([data-theme="dark"]) { ${DARK_THEME} }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { ${DARK_THEME} }
    :host(:not([data-theme="light"])) { ${DARK_THEME} }
  }
`;
