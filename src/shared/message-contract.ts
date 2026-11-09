export const MESSAGE_TYPE = {
  OPEN_PROMPT_MENU: "OPEN_PROMPT_MENU",
  // Compatibility alias for internal retries and the extension test harness.
  REOPEN_MENU: "REOPEN_MENU",
  READ_TEMPLATES: "READ_TEMPLATES",
  READ_LIBRARY_METADATA: "READ_LIBRARY_METADATA",
  MUTATE_TEMPLATES: "MUTATE_TEMPLATES",
  TEMPLATES_UPDATED: "TEMPLATES_UPDATED",
  READ_VARIABLE_MEMORY: "READ_VARIABLE_MEMORY",
  SET_VARIABLE_MEMORY: "SET_VARIABLE_MEMORY",
  CLEAR_VARIABLE_MEMORY: "CLEAR_VARIABLE_MEMORY",
  REMEMBER_VARIABLE_VALUES: "REMEMBER_VARIABLE_VALUES",
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
