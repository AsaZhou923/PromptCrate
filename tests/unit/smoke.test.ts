import { describe, expect, it } from "vitest";
import { MESSAGE_TYPE } from "../../src/shared/message-contract";

// Phase 0 smoke 测试：验证 vitest 配置可用、import 路径正确。
// 这里不测业务逻辑（Phase 9 才有真正的单测），只锁住消息契约常量，
// 防止后续 Phase 改坏 service worker / content script 之间的通信键。
describe("message contract", () => {
  it("exposes the menu open command", () => {
    expect(MESSAGE_TYPE.OPEN_PROMPT_MENU).toBe("OPEN_PROMPT_MENU");
  });

  it("exposes the insert command", () => {
    expect(MESSAGE_TYPE.INSERT_RENDERED_TEMPLATE).toBe("INSERT_RENDERED_TEMPLATE");
  });

  it("exposes the templates updated broadcast", () => {
    expect(MESSAGE_TYPE.TEMPLATES_UPDATED).toBe("TEMPLATES_UPDATED");
  });
});
