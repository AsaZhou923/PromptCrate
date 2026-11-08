import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinValues } from "../../src/content/builtin-values";

afterEach(() => { document.body.innerHTML = ""; });

describe("requested builtin values", () => {
  it("formats one local clock snapshot without reading page metadata", () => {
    const forbidden = new Proxy({}, { get: () => { throw new Error("Page metadata was not requested"); } }) as Document;
    expect(createBuiltinValues(["@date", "@time"], null, forbidden, new Date(2026, 10, 8, 9, 7)))
      .toEqual({ "@date": "2026-11-08", "@time": "09:07" });
  });

  it("does not read document contents for an ordinary template", () => {
    const forbidden = new Proxy({}, { get: () => { throw new Error("Unexpected document read"); } }) as Document;
    expect(createBuiltinValues([], null, forbidden)).toEqual({});
  });

  it("reads only requested URL/title fields", () => {
    let titleReads = 0;
    const source = {
      location: { href: "https://example.test/path" },
      get title() { titleReads += 1; return "{{literal title}}"; },
      get body() { throw new Error("Body must not be read"); },
    } as unknown as Document;
    expect(createBuiltinValues(["@url"], null, source)).toEqual({ "@url": "https://example.test/path" });
    expect(titleReads).toBe(0);
    expect(createBuiltinValues(["@title"], null, source)).toEqual({ "@title": "{{literal title}}" });
    expect(titleReads).toBe(1);
  });

  it("uses the input selection saved before menu focus", () => {
    const target = document.createElement("textarea");
    target.value = "Before selected after";
    document.body.append(target);
    expect(createBuiltinValues(["@selection"], { kind: "text-control", target, start: 7, end: 15 }))
      .toEqual({ "@selection": "selected" });
    target.remove();
    expect(createBuiltinValues(["@selection"], { kind: "text-control", target, start: 7, end: 15 }))
      .toEqual({ "@selection": "" });
  });

  it("reads only the saved editable range rather than the whole editor", () => {
    const target = document.createElement("div");
    target.textContent = "Before selected after";
    document.body.append(target);
    const range = document.createRange();
    range.setStart(target.firstChild!, 7);
    range.setEnd(target.firstChild!, 15);
    expect(createBuiltinValues(["@selection"], { kind: "contenteditable", target, range }))
      .toEqual({ "@selection": "selected" });
  });
});
