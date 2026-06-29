import {
  createSelectionTracker,
  insertTextAtSavedSelection,
  SavedSelection,
} from "./input-target";
import { MESSAGE_TYPE, isRuntimeMessage } from "../shared/message-contract";
import { readPromptTemplates, writePromptTemplates } from "../shared/storage";
import {
  extractTemplateVariables,
  PromptTemplate,
  renderTemplate,
  searchTemplates,
  sortTemplatesForMenu,
  TemplateVariable,
  touchTemplateLastUsed,
} from "../shared/templates";

declare global {
  interface Window {
    __promptCrateContentEntryLoaded?: boolean;
  }
}

const HOST_ID = "promptcrate-menu-host";
const MENU_WIDTH = 420;

type MenuState = {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  templates: PromptTemplate[];
  query: string;
  selectedIndex: number;
  savedSelection: SavedSelection | null;
  chosenTemplate: PromptTemplate | null;
  values: Record<string, string>;
  error: string | null;
};

if (!window.__promptCrateContentEntryLoaded) {
  window.__promptCrateContentEntryLoaded = true;

  const selectionTracker = createSelectionTracker();
  let state: MenuState | null = null;

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isRuntimeMessage(message)) {
      return;
    }

    if (
      message.type === MESSAGE_TYPE.OPEN_PROMPT_MENU ||
      message.type === MESSAGE_TYPE.REOPEN_MENU
    ) {
      void openPromptMenu();
    }

    if (message.type === MESSAGE_TYPE.TEMPLATES_UPDATED && state) {
      void reloadTemplates();
    }
  });

  window.addEventListener("promptcrate:open-menu", () => {
    void openPromptMenu();
  });

  async function openPromptMenu(): Promise<void> {
    selectionTracker.rememberCurrentSelection();
    const { host, shadow } = ensureMenuHost();
    const savedSelection = selectionTracker.getSavedSelection();

    state = {
      host,
      shadow,
      templates: [],
      query: "",
      selectedIndex: 0,
      savedSelection,
      chosenTemplate: null,
      values: {},
      error: savedSelection ? null : "Focus a text field before opening PromptCrate.",
    };

    attachOutsideClickHandler(host);
    positionHost(host);

    if (!savedSelection) {
      renderMenu();
      return;
    }

    state.templates = sortTemplatesForMenu(await readPromptTemplates());
    renderMenu({ focusSearch: true });
  }

  async function reloadTemplates(): Promise<void> {
    if (!state) {
      return;
    }

    state.templates = sortTemplatesForMenu(await readPromptTemplates());
    renderMenu();
  }

  function ensureMenuHost(): { host: HTMLDivElement; shadow: ShadowRoot } {
    const existing = document.getElementById(HOST_ID);

    if (existing instanceof HTMLDivElement && existing.shadowRoot) {
      return { host: existing, shadow: existing.shadowRoot };
    }

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.width = `${MENU_WIDTH}px`;
    host.style.maxWidth = "calc(100vw - 24px)";
    host.style.top = "72px";
    host.style.left = "50%";
    host.style.transform = "translateX(-50%)";
    const shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);

    return { host, shadow };
  }

  function positionHost(host: HTMLDivElement): void {
    host.style.display = "block";
  }

  function closeMenu(): void {
    if (!state) {
      return;
    }

    const focusTarget = state.savedSelection?.target;
    state.host.style.display = "none";
    state.shadow.textContent = "";
    detachOutsideClickHandler();
    state = null;

    if (focusTarget?.isConnected) {
      queueMicrotask(() => {
        focusTarget.focus();
      });
    }
  }

  function attachOutsideClickHandler(host: HTMLDivElement): void {
    detachOutsideClickHandler();
    document.addEventListener("mousedown", handleOutsideMouseDown, true);

    function handleOutsideMouseDown(event: MouseEvent): void {
      const path = event.composedPath();
      if (!path.includes(host)) {
        closeMenu();
      }
    }

    outsideClickCleanup = () => {
      document.removeEventListener("mousedown", handleOutsideMouseDown, true);
    };
  }

  let outsideClickCleanup: (() => void) | null = null;

  function detachOutsideClickHandler(): void {
    outsideClickCleanup?.();
    outsideClickCleanup = null;
  }

  function renderMenu(options: { focusSearch?: boolean } = {}): void {
    if (!state) {
      return;
    }

    state.shadow.textContent = "";
    state.shadow.append(createStyles());

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "PromptCrate");
    panel.tabIndex = -1;
    panel.addEventListener("keydown", handlePanelKeyDown);

    if (state.error && !state.savedSelection) {
      panel.append(createHeader("PromptCrate"), createNotice(state.error));
      state.shadow.append(panel);
      queueMicrotask(() => {
        panel.focus();
      });
      return;
    }

    if (state.chosenTemplate) {
      panel.append(createHeader(state.chosenTemplate.title), createVariableForm());
    } else {
      panel.append(createHeader("PromptCrate"), createTemplateList(options.focusSearch));
    }

    state.shadow.append(panel);
  }

  function createHeader(title: string): HTMLElement {
    const header = document.createElement("header");
    header.className = "header";

    const heading = document.createElement("h2");
    heading.textContent = title;

    const closeButton = document.createElement("button");
    closeButton.className = "icon-button";
    closeButton.type = "button";
    closeButton.title = "Close";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "\u00d7";
    closeButton.addEventListener("click", closeMenu);

    header.append(heading, closeButton);
    return header;
  }

  function createTemplateList(focusSearch = false): HTMLElement {
    if (!state) {
      return document.createElement("div");
    }

    const wrapper = document.createElement("div");
    wrapper.className = "list-view";

    const searchInput = document.createElement("input");
    searchInput.className = "search";
    searchInput.type = "search";
    searchInput.setAttribute("role", "combobox");
    searchInput.setAttribute("aria-controls", "promptcrate-template-list");
    searchInput.setAttribute("aria-expanded", "true");
    searchInput.setAttribute("aria-autocomplete", "list");
    searchInput.placeholder = "Search templates";
    searchInput.value = state.query;
    searchInput.addEventListener("input", () => {
      if (!state) {
        return;
      }

      state.query = searchInput.value;
      state.selectedIndex = 0;
      renderMenu({ focusSearch: true });
    });
    searchInput.addEventListener("keydown", handleListKeyDown);

    const filteredTemplates = getFilteredTemplates();
    const activeOptionId = filteredTemplates[state.selectedIndex]
      ? `promptcrate-template-option-${state.selectedIndex}`
      : null;

    if (activeOptionId) {
      searchInput.setAttribute("aria-activedescendant", activeOptionId);
    }

    const list = document.createElement("div");
    list.id = "promptcrate-template-list";
    list.className = "template-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Templates");

    if (filteredTemplates.length === 0) {
      list.append(createNotice("No matching templates."));
    } else {
      filteredTemplates.forEach((template, index) => {
        const item = document.createElement("div");
        item.id = `promptcrate-template-option-${index}`;
        item.className = index === state?.selectedIndex
          ? "template-item selected"
          : "template-item";
        item.tabIndex = -1;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === state?.selectedIndex));
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        item.addEventListener("click", () => {
          void chooseTemplate(template);
        });

        const title = document.createElement("span");
        title.className = "template-title";
        title.textContent = template.isFavorite ? `* ${template.title}` : template.title;

        const body = document.createElement("span");
        body.className = "template-body";
        body.textContent = template.body;

        const tags = document.createElement("span");
        tags.className = "template-tags";
        tags.textContent = template.tags.join(", ");

        item.append(title, body, tags);
        list.append(item);
      });
    }

    wrapper.append(searchInput, list);

    if (focusSearch) {
      queueMicrotask(() => {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      });
    }

    return wrapper;
  }

  function handleListKeyDown(event: KeyboardEvent): void {
    if (!state) {
      return;
    }

    const filteredTemplates = getFilteredTemplates();

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.selectedIndex = Math.min(
        state.selectedIndex + 1,
        Math.max(filteredTemplates.length - 1, 0),
      );
      renderMenu({ focusSearch: true });
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
      renderMenu({ focusSearch: true });
      return;
    }

    if (event.key === "Enter" && filteredTemplates[state.selectedIndex]) {
      event.preventDefault();
      void chooseTemplate(filteredTemplates[state.selectedIndex]);
    }
  }

  function handlePanelKeyDown(event: KeyboardEvent): void {
    if (!state) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (event.key === "Tab") {
      trapFocus(event);
    }
  }

  function trapFocus(event: KeyboardEvent): void {
    if (!state) {
      return;
    }

    const focusableElements = getFocusableElements(state.shadow);

    if (focusableElements.length === 0) {
      event.preventDefault();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = state.shadow.activeElement;

    if (event.shiftKey && activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
      return;
    }

    if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  function getFocusableElements(root: ShadowRoot): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])',
    )].filter(
      (element) => {
        const style = window.getComputedStyle(element);

        return (
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-hidden") !== "true" &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      },
    );
  }

  async function chooseTemplate(template: PromptTemplate): Promise<void> {
    if (!state) {
      return;
    }

    const variables = extractTemplateVariables(template.body);

    if (variables.length === 0) {
      await insertRenderedTemplate(template, template.body);
      return;
    }

    state.chosenTemplate = template;
    state.values = {};
    state.error = null;
    renderMenu();
  }

  function createVariableForm(): HTMLElement {
    if (!state?.chosenTemplate) {
      return document.createElement("div");
    }

    const template = state.chosenTemplate;
    const variables = extractTemplateVariables(template.body);
    const wrapper = document.createElement("form");
    wrapper.className = "variable-form";
    wrapper.addEventListener("submit", (event) => {
      event.preventDefault();
      void handleVariableSubmit(variables);
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    });

    for (const variable of variables) {
      const label = document.createElement("label");
      label.className = "field";

      const span = document.createElement("span");
      span.textContent = variable.required ? variable.name : `${variable.name} (optional)`;

      const input = document.createElement("input");
      input.type = "text";
      input.value = state.values[variable.name] ?? "";
      input.required = variable.required;
      input.addEventListener("input", () => {
        if (!state) {
          return;
        }

        state.values = {
          ...state.values,
          [variable.name]: input.value,
        };
        updatePreview(wrapper, template);
      });

      label.append(span, input);
      wrapper.append(label);
    }

    const preview = document.createElement("pre");
    preview.className = "preview";
    preview.dataset.role = "preview";
    preview.textContent = createPreviewText(template, state.values);
    wrapper.append(preview);

    if (state.error) {
      wrapper.append(createNotice(state.error, "error"));
    }

    const actions = document.createElement("div");
    actions.className = "actions";

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.textContent = "Back";
    backButton.addEventListener("click", () => {
      if (!state) {
        return;
      }

      state.chosenTemplate = null;
      state.values = {};
      state.error = null;
      renderMenu({ focusSearch: true });
    });

    const insertButton = document.createElement("button");
    insertButton.type = "submit";
    insertButton.className = "primary";
    insertButton.textContent = "Insert";

    actions.append(backButton, insertButton);
    wrapper.append(actions);

    queueMicrotask(() => {
      wrapper.querySelector("input")?.focus();
    });

    return wrapper;
  }

  async function handleVariableSubmit(variables: TemplateVariable[]): Promise<void> {
    if (!state?.chosenTemplate) {
      return;
    }

    const missingVariable = variables.find(
      (variable) =>
        variable.required &&
        (state?.values[variable.name] ?? "").trim().length === 0,
    );

    if (missingVariable) {
      state.error = `Fill ${missingVariable.name} before inserting.`;
      renderMenu();
      return;
    }

    try {
      const rendered = renderTemplate(state.chosenTemplate.body, state.values);
      await insertRenderedTemplate(state.chosenTemplate, rendered);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      renderMenu();
    }
  }

  async function insertRenderedTemplate(
    template: PromptTemplate,
    renderedText: string,
  ): Promise<void> {
    if (!state) {
      return;
    }

    const didInsert = insertTextAtSavedSelection(state.savedSelection, renderedText);

    if (!didInsert) {
      state.error = "PromptCrate could not insert into this field.";
      renderMenu();
      return;
    }

    const currentTemplates = await readPromptTemplates();
    const nextTemplates = currentTemplates.map((item) =>
      item.id === template.id ? touchTemplateLastUsed(item) : item,
    );
    await writePromptTemplates(nextTemplates);
    state.templates = sortTemplatesForMenu(nextTemplates);
    closeMenu();
  }

  function getFilteredTemplates(): PromptTemplate[] {
    if (!state) {
      return [];
    }

    return sortTemplatesForMenu(searchTemplates(state.templates, state.query));
  }

  function updatePreview(form: HTMLElement, template: PromptTemplate): void {
    if (!state) {
      return;
    }

    const preview = form.querySelector<HTMLElement>('[data-role="preview"]');
    if (preview) {
      preview.textContent = createPreviewText(template, state.values);
    }
  }

  function createPreviewText(
    template: PromptTemplate,
    values: Record<string, string>,
  ): string {
    return template.body.replace(/{{\s*([^{}]+?)\s*}}/g, (placeholder, rawName: string) => {
      const trimmedName = rawName.trim();
      const isOptional = trimmedName.endsWith("?");
      const name = (isOptional ? trimmedName.slice(0, -1) : trimmedName).trim();
      const value = values[name] ?? "";

      return value.length > 0 ? value : placeholder;
    });
  }

  function createNotice(message: string, tone: "info" | "error" = "info"): HTMLElement {
    const notice = document.createElement("p");
    notice.className = `notice ${tone}`;
    notice.textContent = message;
    return notice;
  }

  function createStyles(): HTMLStyleElement {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      .panel {
        width: 100%;
        max-height: min(620px, calc(100vh - 96px));
        overflow: hidden;
        color: #172026;
        background: #fffdf8;
        border: 1px solid #c9d4dc;
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(23, 32, 38, 0.18);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid #e2e8ec;
      }

      h2 {
        margin: 0;
        overflow: hidden;
        font-size: 15px;
        line-height: 1.3;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      button,
      input {
        font: inherit;
      }

      .icon-button {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 6px;
        color: #41515d;
        background: transparent;
        cursor: pointer;
      }

      .icon-button:hover,
      .icon-button:focus-visible {
        background: #eef3f4;
        outline: none;
      }

      .list-view {
        padding: 12px;
      }

      .search {
        width: 100%;
        padding: 9px 10px;
        color: #172026;
        border: 1px solid #b8c6cf;
        border-radius: 7px;
        background: #ffffff;
      }

      .search:focus {
        border-color: #2f7f78;
        outline: 2px solid rgba(47, 127, 120, 0.2);
      }

      .template-list {
        display: grid;
        gap: 6px;
        max-height: 420px;
        margin-top: 10px;
        overflow: auto;
      }

      .template-item {
        display: grid;
        gap: 4px;
        width: 100%;
        min-height: 72px;
        padding: 10px;
        text-align: left;
        color: #172026;
        border: 1px solid transparent;
        border-radius: 7px;
        background: #f6f0e7;
        cursor: pointer;
      }

      .template-item:hover,
      .template-item.selected {
        border-color: #2f7f78;
        background: #ecf4f1;
      }

      .template-title {
        font-weight: 700;
      }

      .template-body,
      .template-tags {
        overflow: hidden;
        color: #526470;
        font-size: 12px;
        line-height: 1.35;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .variable-form {
        display: grid;
        gap: 12px;
        padding: 12px;
      }

      .field {
        display: grid;
        gap: 5px;
        color: #334650;
        font-size: 12px;
        font-weight: 700;
      }

      .field input {
        width: 100%;
        padding: 8px 10px;
        color: #172026;
        border: 1px solid #b8c6cf;
        border-radius: 7px;
        background: #ffffff;
      }

      .preview {
        max-height: 160px;
        margin: 0;
        overflow: auto;
        white-space: pre-wrap;
        color: #20313a;
        background: #f2f7f5;
        border: 1px solid #d6e2de;
        border-radius: 7px;
        padding: 10px;
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .actions button {
        min-width: 76px;
        padding: 8px 10px;
        border: 1px solid #b8c6cf;
        border-radius: 7px;
        color: #172026;
        background: #ffffff;
        cursor: pointer;
      }

      .actions .primary {
        color: #ffffff;
        border-color: #256b65;
        background: #2f7f78;
      }

      .notice {
        margin: 12px;
        color: #526470;
        line-height: 1.4;
      }

      .notice.error {
        color: #9f3228;
      }
    `;
    return style;
  }
}
