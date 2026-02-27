export async function sendTelegramMessage(params: {
  botToken: string;
  chatId: string;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableWebPagePreview?: boolean;
  replyMarkup?: Record<string, unknown>;
}): Promise<void> {
  const url = `https://api.telegram.org/bot${params.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: params.chatId,
      text: params.text,
      parse_mode: params.parseMode ?? "Markdown",
      disable_web_page_preview: params.disableWebPagePreview ?? true,
      ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram HTTP ${res.status}: ${body}`);
  }
}
