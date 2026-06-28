import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("manual smoke fixture", () => {
  it("contains textarea, input, and contenteditable targets", () => {
    const html = readFileSync(
      resolve(process.cwd(), "fixtures/manual-inputs.html"),
      "utf8",
    );
    document.body.innerHTML = html;

    expect(document.querySelector("textarea#textarea")).not.toBeNull();
    expect(document.querySelector('input#text-input[type="text"]')).not.toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
  });
});
