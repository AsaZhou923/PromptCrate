import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import english from "../../public/_locales/en/messages.json";
import chinese from "../../public/_locales/zh_CN/messages.json";

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const key = "promptCrate.language";

function setup(language = "en-US", preference: unknown = undefined) {
  const listeners = new Set<Listener>();
  const get = vi.fn(async (): Promise<Record<string, unknown>> => ({ [key]: preference }));
  const set = vi.fn().mockResolvedValue(undefined);
  const getMessage = vi.fn().mockReturnValue("");
  vi.stubGlobal("chrome", {
    i18n: { getUILanguage: () => language, getMessage },
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
  });
  return {
    get, set, getMessage, listeners,
    change(value: unknown, area = "local") {
      for (const listener of listeners) listener({ [key]: { newValue: value } }, area);
    },
  };
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("localization catalogs", () => {
  it("keeps semantic keys and named substitution definitions aligned", () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
    for (const catalog of [english, chinese]) {
      for (const [id, entry] of Object.entries(catalog)) {
        expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(entry.message.length).toBeGreaterThan(0);
        const placeholders = "placeholders" in entry ? entry.placeholders : {};
        const tokens = [...entry.message.matchAll(/\$([A-Z0-9_]+)\$/g)].map((match) => match[1].toLowerCase());
        expect([...new Set(tokens)].sort(), id).toEqual(Object.keys(placeholders).sort());
      }
    }
    for (const id of Object.keys(english) as (keyof typeof english)[]) {
      const source = english[id];
      const target = chinese[id];
      expect("placeholders" in target ? target.placeholders : {}, id)
        .toEqual("placeholders" in source ? source.placeholders : {});
    }
  });
});

describe("language preferences and rendering", () => {
  it("uses explicit preferences and detects all Chinese browser locales", async () => {
    setup("zh-TW");
    const { resolveLocale } = await import("../../src/shared/i18n");
    expect(resolveLocale()).toBe("zh_CN");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("invalid")).toBe("zh_CN");
    vi.unstubAllGlobals();
    expect(resolveLocale()).toBe("en");
  });

  it("reads malformed preferences as system and writes only the language key", async () => {
    const mock = setup("en", {});
    const { getLanguagePreference, setLanguagePreference } = await import("../../src/shared/i18n");
    expect(await getLanguagePreference()).toBe("system");
    await setLanguagePreference("zh_CN");
    expect(mock.set).toHaveBeenCalledExactlyOnceWith({ [key]: "zh_CN" });
    mock.set.mockRejectedValueOnce(new Error("Quota exceeded"));
    await expect(setLanguagePreference("en")).rejects.toThrow("Quota exceeded");
    await expect(setLanguagePreference("bad" as "en")).rejects.toThrow("Invalid language preference.");
  });

  it("uses native Chrome messages only for the native language", async () => {
    const mock = setup("en-US");
    const { tr, setLanguagePreference } = await import("../../src/shared/i18n");
    mock.getMessage.mockImplementation((key: string) => key === "ui_catalog_locale" ? "en" : "Native message");
    expect(tr("Fill $1 before inserting.", "name")).toBe("Native message");
    expect(mock.getMessage).toHaveBeenCalledWith("fill_variable", ["name"]);
    mock.getMessage.mockClear();
    await setLanguagePreference("zh_CN");
    expect(tr("Fill $1 before inserting.", "$& <text>")).toBe("请先填写 $& <text>，再插入。");
    expect(tr("Imported $1 new and $2 updated templates.", 2, 3)).toBe("已导入 2 个新模板并更新 3 个模板。");
    expect(mock.getMessage.mock.calls.every(([key]) => key === "ui_catalog_locale")).toBe(true);
    expect(tr("Unknown $1", "$1")).toBe("Unknown $1");
  });

  it("falls back to bundled messages when Chrome i18n is absent or has no message", async () => {
    setup("zh-CN");
    const { tr } = await import("../../src/shared/i18n");
    expect(tr("Close")).toBe("关闭");
    vi.stubGlobal("chrome", {});
    expect(tr("Close")).toBe("Close");
    vi.unstubAllGlobals();
    expect(tr("Close")).toBe("Close");
  });

  it("renders an explicit locale without changing the current UI language", async () => {
    setup("en");
    const { tr, trForLocale } = await import("../../src/shared/i18n");
    expect(trForLocale("zh_CN", "Fill $1 before inserting.", "name")).toBe("请先填写 name，再插入。");
    expect(trForLocale("zh_CN", "Unknown $1", "value")).toBe("Unknown value");
    expect(tr("Close")).toBe("Close");
  });

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-SG", "zh"])(
    "uses bundled Chinese when native %s falls back to English", async (language) => {
      const mock = setup(language);
      mock.getMessage.mockImplementation((key: string) => key === "ui_catalog_locale" ? "en" : "Close");
      const { tr, setLanguagePreference } = await import("../../src/shared/i18n");
      expect(tr("Close")).toBe("关闭");
      await setLanguagePreference("zh_CN");
      expect(tr("Close")).toBe("关闭");
      expect(mock.getMessage.mock.calls.every(([key]) => key === "ui_catalog_locale")).toBe(true);
    },
  );

  it.each(["zh-CN", "zh_CN"])("uses native messages when the shipped Chinese catalog matches %s", async (language) => {
    const mock = setup(language);
    mock.getMessage.mockImplementation((key: string) => key === "ui_catalog_locale" ? "zh_CN" : "原生消息");
    const { tr } = await import("../../src/shared/i18n");
    expect(tr("Close")).toBe("原生消息");
    expect(mock.getMessage).toHaveBeenCalledWith("close", []);
  });

  it("uses the loaded catalog marker when native messages disagree with the UI language", async () => {
    const mock = setup("en-US", "en");
    mock.getMessage.mockImplementation((key: string) => key === "ui_catalog_locale" ? "zh_CN" : "已加载 7 个模板。");
    const { tr, trForLocale, setLanguagePreference } = await import("../../src/shared/i18n");
    await setLanguagePreference("en");
    expect(tr("$1 templates loaded.", 7)).toBe("7 templates loaded.");
    expect(mock.getMessage.mock.calls.every(([key]) => key === "ui_catalog_locale")).toBe(true);
    expect(trForLocale("zh_CN", "$1 templates loaded.", 7)).toBe("已加载 7 个模板。");
    expect(mock.getMessage).toHaveBeenCalledWith("templates_loaded", ["7"]);
  });

  it("translates formatted status and error patterns without modifying unknown text", async () => {
    setup();
    const { localizeText, setLanguagePreference } = await import("../../src/shared/i18n");
    const status = 'Saved "My $1 [draft]".';
    expect(localizeText(status)).toBe(status);
    await setLanguagePreference("zh_CN");
    expect(localizeText(status)).toBe("已保存“My $1 [draft]”。");
    expect(localizeText("Template at index 4 is invalid.")).toBe("第 4 个模板无效。");
    expect(localizeText("Could not load theme. Quota exceeded")).toBe("无法加载主题。Quota exceeded");
    expect(localizeText("Invalid variable options: tone")).toBe("变量选项无效：tone");
    expect(localizeText("Custom unknown technical error [0x01]")).toBe("Custom unknown technical error [0x01]");
  });

  it("ignores a stale initial read after a storage change and removes listeners", async () => {
    const mock = setup();
    let resolveRead!: (value: Record<string, unknown>) => void;
    mock.get.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { observeLanguage, tr } = await import("../../src/shared/i18n");
    const callback = vi.fn();
    const stop = observeLanguage(callback);
    expect(callback).toHaveBeenLastCalledWith("system", "en");
    mock.change("zh_CN", "sync");
    expect(tr("Close")).toBe("Close");
    mock.change("zh_CN");
    resolveRead({ [key]: "en" });
    await Promise.resolve();
    await Promise.resolve();
    expect(tr("Close")).toBe("关闭");
    expect(callback).toHaveBeenLastCalledWith("zh_CN", "zh_CN");
    stop();
    const count = callback.mock.calls.length;
    mock.change("en");
    expect(callback).toHaveBeenCalledTimes(count);
    expect(mock.listeners.size).toBe(0);
  });

  it("ignores a delayed read after unmount and keeps fallback on a rejected read", async () => {
    const mock = setup("zh-CN");
    let resolveRead!: (value: Record<string, unknown>) => void;
    mock.get.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { observeLanguage } = await import("../../src/shared/i18n");
    const callback = vi.fn();
    const stop = observeLanguage(callback);
    stop();
    resolveRead({ [key]: "en" });
    await Promise.resolve();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledExactlyOnceWith("system", "zh_CN");
    mock.get.mockRejectedValueOnce(new Error("Storage unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stopAgain = observeLanguage(callback);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenLastCalledWith("system", "zh_CN");
    stopAgain();
  });

  it("localizes only a newly created seed while preserving IDs, names and English defaults", async () => {
    const { localizeDefaultSeed } = await import("../../src/shared/i18n");
    const seed = { id: "rewrite-clearer", title: "Rewrite clearer", body: english.default_rewrite_clearer_body.message, tags: ["writing", "rewrite"], extra: 42 };
    expect(localizeDefaultSeed(seed, "en")).toEqual(seed);
    const translated = localizeDefaultSeed(seed, "zh_CN");
    expect(translated).toEqual({ ...seed, title: "改写得更清晰", body: '请改写以下文本，使其更清晰、简洁，并保留原意：\n\n{{text "待改写文本"}}', tags: ["写作", "改写"] });
    expect(seed.title).toBe("Rewrite clearer");
    const custom = { ...seed, id: "user-template" };
    expect(localizeDefaultSeed(custom, "zh_CN")).toEqual(custom);
    expect(Object.keys(chinese).filter((id) => /^default_.*_title$/.test(id))).toHaveLength(7);
  });
});
