
export function lastAssistantTextMessageContent(result) {
  const messages = Array.isArray(result?.output) ? result.output : [];

  const lastAssistantTextMessageIndex = messages.findLastIndex(
    (message) => message?.role === "assistant"
  );

  if (lastAssistantTextMessageIndex < 0) {
    return "";
  }

  const message = messages[lastAssistantTextMessageIndex];

  if (!message?.content) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .join("");
  }

  return "";
}
