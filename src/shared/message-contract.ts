export const MESSAGE_TYPE = {
  OPEN_PROMPT_MENU: "OPEN_PROMPT_MENU",
  REOPEN_MENU: "REOPEN_MENU",
  INSERT_RENDERED_TEMPLATE: "INSERT_RENDERED_TEMPLATE",
  TEMPLATES_UPDATED: "TEMPLATES_UPDATED",
} as const;

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

export type RuntimeMessage = {
  type: MessageType;
};

export function isRuntimeMessage(message: unknown): message is RuntimeMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    Object.values(MESSAGE_TYPE).includes(
      (message as { type?: unknown }).type as MessageType,
    )
  );
}
