import {
  createSelectionTracker,
  insertTextAtSavedSelection,
  SavedSelection,
} from "./input-target";
import { MESSAGE_TYPE, isRuntimeMessage } from "../shared/message-contract";
import { loadPromptTemplates, commitTemplateMutation } from "../shared/template-client";
import { calculateMenuPosition } from "./menu-position";
import { observeTheme, THEME_STYLES } from "../shared/theme";
import { createBuiltinValues } from "./builtin-values";
import { localizeText, observeLanguage, resolveLocale, tr } from "../shared/i18n";
import { loadVariableMemory, MEMORY_ENABLED_KEY, rememberVariableValues } from "../shared/variable-memory";
import {
  extractTemplateVariables,
  PromptTemplate,
  renderTemplate,
  createTemplateSearch,
  TemplateVariable,
  getTemplateDefaultValues,
} from "../shared/templates";

declare global {
  interface Window {
    __promptCrateContentEntryLoaded?: boolean;
  }
}

const HOST_ID = "promptcrate-menu-host";
const MENU_WIDTH = 420;
const MAX_VISIBLE_RESULTS = 100;

type MenuState = {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  search: ReturnType<typeof createTemplateSearch>;
  query: string;
  selectedIndex: number;
  isComposing: boolean;
  savedSelection: SavedSelection | null;
  chosenTemplate: PromptTemplate | null;
  values: Record<string, string>;
  context: Record<string, string>;
  memoryEnabled: boolean;
  memoryRevision: number;
  variableDraftRevision: number;
  error: string | null;
  invalidVariable: string | null;
};

if (!window.__promptCrateContentEntryLoaded) {
  window.__promptCrateContentEntryLoaded = true;

  let menuHost: { host: HTMLDivElement; shadow: ShadowRoot } | null = null;
  const selectionTracker = createSelectionTracker(
    document,
    (element) => element === menuHost?.host,
  );
  let state: MenuState | null = null;
  let positionFrame: number | null = null;
  let panelObserver: ResizeObserver | null = null;
  let locale = resolveLocale();
  observeLanguage((_preference, nextLocale) => {
    locale = nextLocale;
    if (menuHost) menuHost.host.lang = locale.replace("_", "-");
    if (!state || state.isComposing) return;
    const active = state.shadow.activeElement;
    const name = active instanceof HTMLElement ? active.dataset.variableName : undefined;
    const selection = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;
    const searchFocused = active?.classList.contains("search");
    renderMenu({ focusSearch: searchFocused });
    if (name) queueMicrotask(() => {
      const field = [...(state?.shadow.querySelectorAll<HTMLTextAreaElement | HTMLSelectElement>("[data-variable-name]") ?? [])]
        .find((element) => element.dataset.variableName === name);
      field?.focus();
      if (field instanceof HTMLTextAreaElement && selection) field.setSelectionRange(selection[0], selection[1]);
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (state && area === "local" && MEMORY_ENABLED_KEY in changes) {
      state.memoryEnabled = changes[MEMORY_ENABLED_KEY].newValue === true;
      state.memoryRevision += 1;
    }
  });
  window.addEventListener("resize", schedulePosition);
  document.addEventListener("scroll", schedulePosition, true);

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

  async function openPromptMenu(): Promise<void> {
    // Repeated commands keep the original target, query, and unfinished variable values.
    if (state) {
      positionHost(state.host);
      return;
    }

    selectionTracker.rememberCurrentSelection();
    const { host, shadow } = ensureMenuHost();
    const savedSelection = selectionTracker.getSavedSelection();

    const openingState: MenuState = {
      host,
      shadow,
      search: createTemplateSearch([]),
      query: "",
      selectedIndex: 0,
      isComposing: false,
      savedSelection,
      chosenTemplate: null,
      values: {},
      context: {},
      memoryEnabled: false,
      memoryRevision: 0,
      variableDraftRevision: 0,
      error: savedSelection ? null : "Focus a text field before opening PromptCrate. Read-only and disabled fields are not supported.",
      invalidVariable: null,
    };

    state = openingState;
    attachOutsideClickHandler(host);
    positionHost(host);

    if (!savedSelection) {
      renderMenu();
      return;
    }

    try {
      const templates = await loadPromptTemplates();
      // A close or a newer open may have replaced this request while storage was loading.
      if (state !== openingState) {
        return;
      }
      openingState.search = createTemplateSearch(templates);
    } catch (error) {
      if (state !== openingState) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      openingState.error = `Could not load templates. Close PromptCrate and try again. ${detail}`;
    }
    renderMenu({ focusSearch: true });
  }

  async function reloadTemplates(): Promise<void> {
    if (!state) {
      return;
    }

    const currentState = state;
    try {
      const templates = await loadPromptTemplates();
      if (state !== currentState) {
        return;
      }

      currentState.search = createTemplateSearch(templates);
      if (!currentState.chosenTemplate && !currentState.isComposing) {
        updateTemplateResults();
      }
    } catch (error) {
      console.warn("[prompt-crate] Could not refresh templates", error);
    }
  }

  function ensureMenuHost(): { host: HTMLDivElement; shadow: ShadowRoot } {
    if (menuHost) {
      return menuHost;
    }

    // Never adopt a page-created host or an old script instance's root.
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.lang = locale.replace("_", "-");
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.width = `${MENU_WIDTH}px`;
    host.style.maxWidth = "calc(100vw - 24px)";
    host.style.top = "12px";
    host.style.left = "12px";
    observeTheme(host);
    const shadow = host.attachShadow({ mode: "closed" });
    // Gate control actions: Chromium can emit an untrusted compositionend for a native IME commit.
    for (const type of [
      "click", "mousedown", "keydown", "keyup", "keypress", "submit",
    ]) {
      shadow.addEventListener(type, (event) => {
        if (!event.isTrusted) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }
    // Let menu controls handle their events before they reach the host page.
    for (const type of [
      "keydown", "keyup", "keypress", "beforeinput", "input",
      "compositionstart", "compositionupdate", "compositionend",
    ]) {
      shadow.addEventListener(type, (event) => {
        if (state && type === "compositionstart") {
          state.isComposing = true;
        } else if (state && type === "compositionend") {
          state.isComposing = false;
        }
        event.stopPropagation();
      });
    }
    document.documentElement.appendChild(host);

    menuHost = { host, shadow };
    return menuHost;
  }

  function positionHost(host: HTMLDivElement): void {
    if (!host.isConnected) {
      const existing = document.getElementById(HOST_ID);
      if (existing !== host) {
        existing?.remove();
      }
      document.documentElement.appendChild(host);
    }
    host.style.display = "block";
    schedulePosition();
  }

  function schedulePosition(): void {
    if (!state || positionFrame !== null) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      if (!state) return;
      const panel = state.shadow.querySelector<HTMLElement>(".panel");
      if (!panel) return;
      let anchor = null;
      const saved = state.savedSelection;
      if (saved?.target.isConnected) {
        if (saved.kind === "contenteditable" && saved.range) {
          try {
            const rect = saved.range.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) anchor = rect;
          } catch { /* A page edit may have invalidated the saved range. */ }
        }
        anchor ??= saved.target.getBoundingClientRect();
      }
      const rect = panel.getBoundingClientRect();
      const position = calculateMenuPosition(anchor, rect, { width: innerWidth, height: innerHeight });
      state.host.style.left = `${position.left}px`;
      state.host.style.top = `${position.top}px`;
      panel.style.maxHeight = `${Math.min(620, position.maxHeight)}px`;
    });
  }

  function observePanel(panel: HTMLElement): void {
    panelObserver?.disconnect();
    panelObserver = new ResizeObserver(schedulePosition);
    panelObserver.observe(panel);
    schedulePosition();
  }

  function closeMenu(): void {
    if (!state) {
      return;
    }

    const focusTarget = state.savedSelection?.target;
    state.host.style.display = "none";
    state.shadow.textContent = "";
    panelObserver?.disconnect();
    panelObserver = null;
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    positionFrame = null;
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

    state.isComposing = false;
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
      observePanel(panel);
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
    observePanel(panel);
  }

  function createHeader(title: string): HTMLElement {
    const header = document.createElement("header");
    header.className = "header";

    const heading = document.createElement("h2");
    heading.textContent = title;

    const closeButton = document.createElement("button");
    closeButton.className = "icon-button";
    closeButton.type = "button";
    closeButton.title = tr("Close");
    closeButton.setAttribute("aria-label", tr("Close"));
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

    if (state.error) {
      wrapper.append(createNotice(state.error, "error"));
    }

    const searchInput = document.createElement("input");
    searchInput.className = "search";
    searchInput.type = "search";
    searchInput.setAttribute("role", "combobox");
    searchInput.setAttribute("aria-controls", "promptcrate-template-list");
    searchInput.setAttribute("aria-expanded", "true");
    searchInput.setAttribute("aria-autocomplete", "list");
    searchInput.placeholder = tr("Search templates");
    searchInput.value = state.query;
    const updateQuery = () => {
      if (!state || state.isComposing) {
        return;
      }

      state.query = searchInput.value;
      state.selectedIndex = 0;
      updateTemplateResults();
    };
    searchInput.addEventListener("input", (event) => {
      if (!(event as InputEvent).isComposing) {
        updateQuery();
      }
    });
    searchInput.addEventListener("compositionend", () => {
      if (state) {
        state.isComposing = false;
      }
      updateQuery();
    });
    searchInput.addEventListener("keydown", handleListKeyDown);

    const list = document.createElement("div");
    list.id = "promptcrate-template-list";
    list.className = "template-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", tr("Templates"));
    renderTemplateResults(list, searchInput);

    wrapper.append(searchInput, list);

    if (focusSearch) {
      queueMicrotask(() => {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      });
    }

    return wrapper;
  }

  function updateTemplateResults(): void {
    const list = state?.shadow.querySelector<HTMLElement>(".template-list");
    const searchInput = state?.shadow.querySelector<HTMLInputElement>("input.search");
    if (list && searchInput) {
      renderTemplateResults(list, searchInput);
      schedulePosition();
    }
  }

  function renderTemplateResults(list: HTMLElement, searchInput: HTMLInputElement): void {
    if (!state) {
      return;
    }

    const matches = state.search(state.query);
    const filteredTemplates = matches.slice(0, MAX_VISIBLE_RESULTS);
    state.selectedIndex = Math.min(state.selectedIndex, Math.max(filteredTemplates.length - 1, 0));
    list.replaceChildren();
    list.scrollTop = 0;

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
        if (template.isFavorite) {
          const favorite = document.createElement("span");
          favorite.textContent = "★ ";
          favorite.setAttribute("role", "img");
          favorite.setAttribute("aria-label", tr("Favorite"));
          title.append(favorite);
        }
        title.append(document.createTextNode(template.title));

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
    if (matches.length > MAX_VISIBLE_RESULTS) {
      list.append(createNotice(`Showing the first ${MAX_VISIBLE_RESULTS} of ${matches.length} matches. Refine your search.`));
    }

    updateSelectedTemplate(list, searchInput);
  }

  function updateSelectedTemplate(
    list: HTMLElement,
    searchInput: HTMLInputElement,
    scrollIntoView = false,
  ): void {
    const items = [...list.querySelectorAll<HTMLElement>(".template-item")];
    items.forEach((item, index) => {
      const selected = index === state?.selectedIndex;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    const selectedItem = items[state?.selectedIndex ?? -1];
    if (selectedItem) {
      searchInput.setAttribute("aria-activedescendant", selectedItem.id);
      if (scrollIntoView) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    } else {
      searchInput.removeAttribute("aria-activedescendant");
    }
  }

  function handleListKeyDown(event: KeyboardEvent): void {
    if (!state || isComposingKey(event)) {
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
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
    } else if (event.key === "Enter" && filteredTemplates[state.selectedIndex]) {
      event.preventDefault();
      void chooseTemplate(filteredTemplates[state.selectedIndex]);
      return;
    } else {
      return;
    }

    const list = state.shadow.querySelector<HTMLElement>(".template-list");
    const searchInput = state.shadow.querySelector<HTMLInputElement>("input.search");
    if (list && searchInput) {
      updateSelectedTemplate(list, searchInput, true);
    }
  }

  function isComposingKey(event: KeyboardEvent): boolean {
    return Boolean(state?.isComposing || event.isComposing || event.keyCode === 229);
  }

  function handlePanelKeyDown(event: KeyboardEvent): void {
    if (!state || isComposingKey(event)) {
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
    if (!state || state.chosenTemplate) {
      return;
    }

    const currentState = state;
    const variables = extractTemplateVariables(template.body);
    currentState.context = createBuiltinValues(variables.filter((variable) => variable.builtin).map((variable) => variable.name), currentState.savedSelection);

    if (variables.every((variable) => variable.builtin)) {
      try {
        await insertRenderedTemplate(template, renderTemplate(template.body, {}, { context: currentState.context }));
      } catch (error) {
        currentState.error = error instanceof Error ? error.message : String(error);
        renderMenu();
      }
      return;
    }

    currentState.chosenTemplate = template;
    currentState.invalidVariable = null;
    currentState.values = getTemplateDefaultValues(template.body);
    currentState.error = null;
    const draftRevision = ++currentState.variableDraftRevision;
    const memoryRevision = currentState.memoryRevision;
    try {
      const memory = await loadVariableMemory(template.id, template.createdAt);
      if (state !== currentState) return;
      if (currentState.memoryRevision === memoryRevision) currentState.memoryEnabled = memory.enabled;
      if (currentState.chosenTemplate !== template || currentState.variableDraftRevision !== draftRevision) return;
      if (memory.enabled && currentState.memoryRevision === memoryRevision) {
        for (const variable of variables.filter((entry) => !entry.builtin)) {
          const value = Object.hasOwn(memory.values, variable.name) ? memory.values[variable.name] : undefined;
          if (value !== undefined && (!variable.required || value.trim()) &&
            (!variable.options || variable.options.includes(value) || (!variable.required && value === ""))) {
            Object.defineProperty(currentState.values, variable.name, { value, enumerable: true, writable: true, configurable: true });
          }
        }
      }
    } catch (error) {
      console.warn("[prompt-crate] Could not load variable memory", error);
    }
    if (state !== currentState || currentState.chosenTemplate !== template || currentState.variableDraftRevision !== draftRevision) return;
    renderMenu();
  }

  function createVariableForm(): HTMLElement {
    if (!state?.chosenTemplate) {
      return document.createElement("div");
    }

    const template = state.chosenTemplate;
    const variables = extractTemplateVariables(template.body).filter((variable) => !variable.builtin);
    const wrapper = document.createElement("form");
    wrapper.className = "variable-form";
    wrapper.addEventListener("submit", (event) => {
      event.preventDefault();
      void handleVariableSubmit(variables);
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !isComposingKey(event)) {
        event.preventDefault();
        wrapper.requestSubmit();
      }
    });

    for (const variable of variables) {
      const label = document.createElement("label");
      label.className = "field";

      const span = document.createElement("span");
      const fieldName = variable.label ?? variable.name;
      span.textContent = variable.required ? fieldName : `${fieldName} ${tr("(optional)")}`;

      const input = variable.options ? document.createElement("select") : document.createElement("textarea");
      if (input instanceof HTMLTextAreaElement) input.rows = 2;
      if (input instanceof HTMLSelectElement) {
        const choices = variable.required ? variable.options! : ["", ...variable.options!];
        for (const value of choices) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          input.append(option);
        }
      }
      input.dataset.variableName = variable.name;
      input.value = getVariableValue(variable.name);
      input.required = variable.required;
      input.addEventListener("input", () => {
        if (!state) {
          return;
        }

        state.values = {
          ...state.values,
          [variable.name]: input.value,
        };
        state.variableDraftRevision += 1;
        if (input instanceof HTMLTextAreaElement) resizeVariableInput(input);
        updatePreview(wrapper, template);
      });

      label.append(span, input);
      wrapper.append(label);
    }

    const preview = document.createElement("pre");
    preview.className = "preview";
    preview.dataset.role = "preview";
    preview.textContent = renderTemplate(template.body, state.values, { preview: true, context: state.context });
    wrapper.append(preview);

    if (state.error) {
      wrapper.append(createNotice(state.error, "error"));
    }

    const hint = document.createElement("p");
    hint.className = "form-hint";
    hint.textContent = tr("Enter for a new line. Ctrl/⌘+Enter to insert.");
    wrapper.append(hint);

    const actions = document.createElement("div");
    actions.className = "actions";

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.textContent = tr("Back");
    backButton.addEventListener("click", () => {
      if (!state) {
        return;
      }

      state.chosenTemplate = null;
      state.values = {};
      state.error = null;
      state.invalidVariable = null;
      renderMenu({ focusSearch: true });
    });

    const insertButton = document.createElement("button");
    insertButton.type = "submit";
    insertButton.className = "primary";
    insertButton.textContent = tr("Insert");
    insertButton.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");

    actions.append(backButton, insertButton);
    wrapper.append(actions);

    queueMicrotask(() => {
      wrapper.querySelectorAll("textarea").forEach(resizeVariableInput);
      const fields = [...wrapper.querySelectorAll<HTMLTextAreaElement | HTMLSelectElement>("[data-variable-name]")];
      (fields.find((field) => field.dataset.variableName === state?.invalidVariable) ?? fields[0])?.focus();
    });

    return wrapper;
  }

  function resizeVariableInput(input: HTMLTextAreaElement): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
  }

  function getVariableValue(name: string): string {
    return state && Object.prototype.hasOwnProperty.call(state.values, name)
      ? state.values[name]
      : "";
  }

  async function handleVariableSubmit(variables: TemplateVariable[]): Promise<void> {
    if (!state?.chosenTemplate) {
      return;
    }

    const missingVariable = variables.find(
      (variable) =>
        variable.required &&
        getVariableValue(variable.name).trim().length === 0,
    );

    if (missingVariable) {
      state.invalidVariable = missingVariable.name;
      state.error = `Fill ${missingVariable.name} before inserting.`;
      renderMenu();
      return;
    }

    try {
      const rendered = renderTemplate(state.chosenTemplate.body, state.values, { context: state.context });
      await insertRenderedTemplate(state.chosenTemplate, rendered);
    } catch (error) {
      if (!state) {
        return;
      }
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

    const memory = state.memoryEnabled ? { ...state.values } : null;
    closeMenu();
    if (memory) void rememberVariableValues(template.id, memory, template.createdAt).catch((error: unknown) => {
      console.warn("[prompt-crate] Could not remember variable values", error);
    });
    void commitTemplateMutation({ kind: "touch", id: template.id }).catch((error: unknown) => {
      console.warn("[prompt-crate] Could not record template usage", error);
    });
  }

  function getFilteredTemplates(): PromptTemplate[] {
    if (!state) {
      return [];
    }

    return state.search(state.query).slice(0, MAX_VISIBLE_RESULTS);
  }

  function updatePreview(form: HTMLElement, template: PromptTemplate): void {
    if (!state) {
      return;
    }

    const preview = form.querySelector<HTMLElement>('[data-role="preview"]');
    if (preview) {
      preview.textContent = renderTemplate(template.body, state.values, { preview: true, context: state.context });
    }
  }

  function createNotice(message: string, tone: "info" | "error" = "info"): HTMLElement {
    const notice = document.createElement("p");
    notice.className = `notice ${tone}`;
    notice.setAttribute("role", tone === "error" ? "alert" : "status");
    notice.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    notice.textContent = localizeText(message);
    return notice;
  }

  function createStyles(): HTMLStyleElement {
    const style = document.createElement("style");
    style.textContent = THEME_STYLES + `
      :host {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      .panel {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-height: min(620px, calc(100vh - 24px));
        overflow: hidden;
        color: var(--pc-text);
        background: var(--pc-surface);
        border: 1px solid var(--pc-border);
        border-radius: 8px;
        box-shadow: 0 18px 48px var(--pc-shadow);
      }

      .header {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--pc-divider);
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
      input,
      select,
      textarea {
        font: inherit;
      }

      .icon-button {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 6px;
        color: var(--pc-muted);
        background: transparent;
        cursor: pointer;
      }

      .icon-button:hover,
      .icon-button:focus-visible {
        background: var(--pc-selected);
        outline: none;
      }

      .list-view {
        display: flex;
        flex-direction: column;
        min-height: 0;
        padding: 12px;
      }

      .search {
        flex-shrink: 0;
        width: 100%;
        padding: 9px 10px;
        color: var(--pc-text);
        border: 1px solid var(--pc-border);
        border-radius: 7px;
        background: var(--pc-input);
      }

      .search:focus {
        border-color: var(--pc-accent);
        outline: 2px solid var(--pc-focus);
      }

      .template-list {
        display: grid;
        min-height: 0;
        flex: 1 1 auto;
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
        color: var(--pc-text);
        border: 1px solid transparent;
        border-radius: 7px;
        background: var(--pc-item);
        cursor: pointer;
      }

      .template-item:hover,
      .template-item.selected {
        border-color: var(--pc-accent);
        background: var(--pc-selected);
      }

      .template-title {
        font-weight: 700;
      }

      .template-body,
      .template-tags {
        overflow: hidden;
        color: var(--pc-muted);
        font-size: 12px;
        line-height: 1.35;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .variable-form {
        display: grid;
        min-height: 0;
        overflow: auto;
        gap: 12px;
        padding: 12px;
      }

      .field {
        display: grid;
        gap: 5px;
        color: var(--pc-muted);
        font-size: 12px;
        font-weight: 700;
      }

      .field textarea,
      .field select {
        width: 100%;
        min-height: 64px;
        max-height: 160px;
        resize: vertical;
        padding: 8px 10px;
        color: var(--pc-text);
        border: 1px solid var(--pc-border);
        border-radius: 7px;
        background: var(--pc-input);
      }

      .field select { min-height: 38px; }

      .form-hint {
        margin: 0;
        color: var(--pc-muted);
        font-size: 12px;
        font-weight: 400;
      }

      .preview {
        max-height: 160px;
        margin: 0;
        overflow: auto;
        white-space: pre-wrap;
        color: var(--pc-text);
        background: var(--pc-preview-bg);
        border: 1px solid var(--pc-preview-border);
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
        border: 1px solid var(--pc-border);
        border-radius: 7px;
        color: var(--pc-text);
        background: var(--pc-input);
        cursor: pointer;
      }

      .actions .primary {
        color: var(--pc-accent-text);
        border-color: var(--pc-accent);
        background: var(--pc-accent);
      }

      .notice {
        margin: 12px;
        color: var(--pc-muted);
        line-height: 1.4;
      }

      .notice.error {
        color: var(--pc-danger);
      }

      @media (max-height: 240px) {
        .panel {
          display: block;
          overflow: auto;
        }

        .list-view {
          display: block;
        }

        .template-list {
          max-height: 160px;
        }
      }
    `;
    return style;
  }
}
