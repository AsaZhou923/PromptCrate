import { createElement, useState, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";

const host = document.createElement("div");
document.body.prepend(host);

function Editor() {
  const [input, setInput] = useState("Before REPLACE after");
  const [textarea, setTextarea] = useState("Before REPLACE after");
  return createElement("div", null,
    createElement("input", {
      id: "react-input", value: input,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setInput(event.target.value),
    }),
    createElement("textarea", {
      id: "react-textarea", value: textarea,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setTextarea(event.target.value),
    }));
}

createRoot(host).render(createElement(Editor));
