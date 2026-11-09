import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateLibrary, type TemplateLibraryProps } from "../../src/options/template-library";
import type { PromptTemplate } from "../../src/shared/templates";

vi.mock("../../src/shared/i18n", () => ({
  tr: (source: string, ...values: (string | number)[]) => source.replace(/\$(\d+)/g,
    (token, index: string) => String(values[Number(index) - 1] ?? token)),
  localizeText: (source: string) => source,
}));

const template = (id: string, tags: string[], updatedAt = "2026-11-09T00:00:00Z"): PromptTemplate => ({
  id, title: id, body: `Body for ${id}`, tags, isFavorite: false,
  createdAt: "2026-11-09T00:00:00Z", updatedAt,
});
const records = [template("Zulu", ["writing"]), template("Alpha", ["writing", "rewrite"]), template("Beta", ["other"])];
let root: Root;
let host: HTMLDivElement;
let props: TemplateLibraryProps;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    templates: records, selectedId: null, saving: false, onSelect: vi.fn(),
    onDeleteMany: vi.fn().mockResolvedValue(undefined), onExport: vi.fn(),
    onReorder: vi.fn().mockResolvedValue(undefined),
  };
  await render();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(() => root.render(<TemplateLibrary {...props} />));
}

function button(text: string): HTMLButtonElement {
  const result = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!result) throw new Error(`No button ${text}`);
  return result;
}

function labelled<T extends HTMLElement>(label: string): T {
  const result = [...host.querySelectorAll<HTMLElement>("[aria-label]")]
    .find((item) => item.getAttribute("aria-label") === label);
  if (!result) throw new Error(`No field ${label}`);
  return result as T;
}

const titles = () => [...host.querySelectorAll(".template-row .row-title")].map((item) => item.textContent);
const click = async (element: HTMLElement) => { await act(() => element.click()); };
async function sort(value: string) {
  const select = host.querySelector("select")!;
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Options template library", () => {
  it("retains ranked selection buttons independently from bulk checkboxes", async () => {
    expect(titles()).toEqual(["Alpha", "Beta", "Zulu"]);
    await click(host.querySelector<HTMLButtonElement>(".template-row")!);
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(records[1]);
    expect(host.querySelector(".template-row input")).toBeNull();
    expect(button("Delete selected").disabled).toBe(true);
  });

  it("requires every selected tag and combines filters with search", async () => {
    await click(button("writing"));
    expect(titles()).toEqual(["Alpha", "Zulu"]);
    await click(button("rewrite"));
    expect(titles()).toEqual(["Alpha"]);
    const search = host.querySelector<HTMLInputElement>("input.search")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Beta");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(titles()).toEqual([]);
    await click(button("Clear tag filters"));
    expect(titles()).toEqual(["Beta"]);
  });

  it("selects visible rows, exports selected records, and retains selection after failure", async () => {
    await click(button("writing"));
    await click(button("Select visible"));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("2 selected");
    await click(button("Export selected"));
    expect(props.onExport).toHaveBeenCalledExactlyOnceWith([records[0], records[1]]);
    props.onDeleteMany = vi.fn().mockRejectedValue(new Error("Storage full"));
    await render();
    await click(button("Delete selected"));
    expect(props.onDeleteMany).toHaveBeenCalledExactlyOnceWith([records[0], records[1]]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Storage full");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("2 selected");
    await click(button("Clear selection"));
    expect(button("Export selected").disabled).toBe(true);
  });

  it("drops selections for removed or recreated identities without selecting replacements", async () => {
    await click(labelled<HTMLInputElement>('Select "Alpha"'));
    await click(labelled<HTMLInputElement>('Select "Beta"'));
    props.templates = [records[0], { ...records[1], createdAt: "2026-11-09T01:00:00Z" }];
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("0 selected");
    expect(labelled<HTMLInputElement>('Select "Alpha"').checked).toBe(false);
  });

  it("reorders the complete stored array through accessible controls and blocks filtered moves", async () => {
    await sort("manual");
    expect(titles()).toEqual(["Zulu", "Alpha", "Beta"]);
    expect(labelled<HTMLButtonElement>('Move "Zulu" up').disabled).toBe(true);
    await click(labelled<HTMLButtonElement>('Move "Alpha" down'));
    expect(props.onReorder).toHaveBeenCalledExactlyOnceWith(["Zulu", "Beta", "Alpha"], records);
    // The parent applies committed results; this component never speculatively rearranges data.
    expect(titles()).toEqual(["Zulu", "Alpha", "Beta"]);
    await click(button("writing"));
    expect(labelled<HTMLButtonElement>('Move "Alpha" up').disabled).toBe(true);
    expect(labelled<HTMLButtonElement>('Reorder "Alpha"').draggable).toBe(false);
  });

  it("sorts by update time and disables all mutations while another write is active", async () => {
    props.templates = [records[0], { ...records[1], updatedAt: "2026-11-09T02:00:00Z" }, records[2]];
    await render();
    await sort("updated");
    expect(titles()).toEqual(["Alpha", "Beta", "Zulu"]);
    await click(button("Select visible"));
    props.saving = true;
    await render();
    expect(button("Delete selected").disabled).toBe(true);
    expect(labelled<HTMLInputElement>('Select "Alpha"').disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".template-row")!.disabled).toBe(true);
  });
});
