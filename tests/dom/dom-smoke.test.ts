import { describe, expect, it } from "vitest";

// Phase 0 DOM smoke 测试：验证 jsdom 环境可用，
// 为 Phase 3 / Phase 9 的 textarea / input / contenteditable 插入测试铺路。
// 这里只验证 document API，不测插入逻辑本身。
describe("jsdom environment", () => {
  it("creates and reads a textarea element", () => {
    const textarea = document.createElement("textarea");
    textarea.id = "test-textarea";
    textarea.value = "hello";
    document.body.appendChild(textarea);

    const found = document.getElementById("test-textarea") as HTMLTextAreaElement;
    expect(found).not.toBeNull();
    expect(found.value).toBe("hello");
  });

  it("creates a contenteditable element", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.textContent = "editable content";
    document.body.appendChild(editable);

    // jsdom 不完整模拟 isContentEditable IDL 属性，改用属性值断言。
    expect(editable.getAttribute("contenteditable")).toBe("true");
    expect(editable.textContent).toBe("editable content");
  });
});
