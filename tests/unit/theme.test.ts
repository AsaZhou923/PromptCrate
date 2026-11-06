import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getThemePreference, observeTheme, setThemePreference, THEME_STORAGE_KEY, THEME_STYLES,
} from "../../src/shared/theme";

function setupTheme(stored: unknown = undefined, dark = false) {
  const storageListeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const mediaListeners = new Set<() => void>();
  const get = vi.fn(async () => ({ [THEME_STORAGE_KEY]: stored }));
  const set = vi.fn().mockResolvedValue(undefined);
  const media = {
    matches: dark,
    addEventListener: vi.fn((_type: string, listener: () => void) => mediaListeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => mediaListeners.delete(listener)),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  vi.stubGlobal("chrome", {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => storageListeners.add(listener),
        removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => storageListeners.delete(listener),
      },
    },
  });
  return {
    get, set, media, storageListeners, mediaListeners,
    storageChange(value: unknown, area = "local") {
      for (const listener of storageListeners) listener({ [THEME_STORAGE_KEY]: { newValue: value } }, area);
    },
    systemChange(value: boolean) {
      media.matches = value;
      for (const listener of mediaListeners) listener();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  document.querySelector("[data-theme-test]")?.remove();
});

describe("theme preference", () => {
  it.each([undefined, null, "invalid", {}, "system"])("defaults malformed or missing preference to system: %j", async (value) => {
    setupTheme(value);
    expect(await getThemePreference()).toBe("system");
  });

  it("writes only the theme setting and propagates persistence failures", async () => {
    const mock = setupTheme();
    await setThemePreference("dark");
    expect(mock.set).toHaveBeenCalledExactlyOnceWith({ [THEME_STORAGE_KEY]: "dark" });
    mock.set.mockRejectedValueOnce(new Error("Quota exceeded"));
    await expect(setThemePreference("light")).rejects.toThrow("Quota exceeded");
  });

  it("follows the system until an explicit preference is selected", async () => {
    const mock = setupTheme("system", true);
    const target = document.createElement("div");
    const stop = observeTheme(target);
    await vi.waitFor(() => expect(target.dataset.theme).toBe("dark"));
    mock.systemChange(false);
    expect(target.dataset.theme).toBe("light");
    mock.storageChange("light");
    mock.systemChange(true);
    expect(target.dataset.theme).toBe("light");
    mock.storageChange("dark", "sync");
    expect(target.dataset.theme).toBe("light");
    mock.storageChange(undefined);
    expect(target.dataset.theme).toBe("dark");
    stop();
  });

  it("applies a stored manual theme even when the system differs", async () => {
    setupTheme("dark", false);
    const target = document.createElement("div");
    const stop = observeTheme(target);
    await vi.waitFor(() => expect(target.dataset.theme).toBe("dark"));
    stop();
  });

  it("does not let a delayed initial read overwrite a newer storage change", async () => {
    const mock = setupTheme();
    let resolveRead!: (value: Record<typeof THEME_STORAGE_KEY, unknown>) => void;
    mock.get.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const target = document.createElement("div");
    const stop = observeTheme(target);
    mock.storageChange("dark");
    resolveRead({ [THEME_STORAGE_KEY]: "light" });
    await Promise.resolve();
    await Promise.resolve();
    expect(target.dataset.theme).toBe("dark");
    stop();
  });

  it("removes listeners and ignores a read that resolves after cleanup", async () => {
    const mock = setupTheme();
    let resolveRead!: (value: Record<typeof THEME_STORAGE_KEY, unknown>) => void;
    mock.get.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const target = document.createElement("div");
    const stop = observeTheme(target);
    stop();
    resolveRead({ [THEME_STORAGE_KEY]: "dark" });
    await Promise.resolve();
    await Promise.resolve();
    mock.systemChange(true);
    mock.storageChange("dark");
    expect(target.dataset.theme).toBe("light");
    expect(mock.storageListeners.size).toBe(0);
    expect(mock.mediaListeners.size).toBe(0);
  });

  it("keeps the system fallback and reports a failed initial read", async () => {
    const mock = setupTheme(undefined, true);
    mock.get.mockRejectedValueOnce(new Error("Storage unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = document.createElement("div");
    const stop = observeTheme(target);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(target.dataset.theme).toBe("dark");
    stop();
  });

  it("applies manual document colors through the shared CSS tokens", () => {
    const style = document.createElement("style");
    style.dataset.themeTest = "true";
    style.textContent = THEME_STYLES;
    document.head.append(style);
    document.documentElement.dataset.theme = "dark";
    expect(getComputedStyle(document.documentElement).getPropertyValue("--pc-bg").trim()).toBe("#10191d");
    document.documentElement.dataset.theme = "light";
    expect(getComputedStyle(document.documentElement).getPropertyValue("--pc-bg").trim()).toBe("#f8faf9");
  });
});
