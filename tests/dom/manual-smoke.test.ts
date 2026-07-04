import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("manual smoke fixture", () => {
  it("contains the manual insertion targets required by the release checklist", () => {
    const html = readFileSync(
      resolve(process.cwd(), "fixtures/manual-inputs.html"),
      "utf8",
    );
    document.body.innerHTML = html;

    expect(document.querySelector("textarea#textarea")).not.toBeNull();
    expect(document.querySelector('input#text-input[type="text"]')).not.toBeNull();
    expect(document.querySelector('input#search-input[type="search"]')).not.toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(document.querySelector("#shadow-host")).not.toBeNull();
    expect(document.querySelector("iframe#iframe-input")).not.toBeNull();
    expect(html).toContain('id="shadow-input"');
    expect(html).toContain('id="iframe-textarea"');
    expect(document.querySelector("textarea#long-textarea")).not.toBeNull();
    expect(document.querySelector('input#prefilled-input[value="Existing content"]')).not.toBeNull();
  });
});
