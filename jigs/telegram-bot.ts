/**
 * Telegram Bot — webhook-triggered jig that reads email/calendar and replies via Composio.
 *
 * Setup:
 * 1. Add Composio to servers/default.json with headers: { "x-api-key": "..." }
 * 2. Run: jig connect composio
 * 3. Create Telegram bot via BotFather
 * 4. Set webhook: POST https://api.telegram.org/bot{TOKEN}/setWebhook
 *    { "url": "https://YOUR_JIG_URL/api/webhooks/telegram-bot?token=WEBHOOK_TOKEN" }
 *
 * Webhook body from Telegram:
 * { "update_id": 123, "message": { "text": "hello", "chat": { "id": 456 } } }
 */
import { jig, agent } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"
// import { composio } from "@jig/connections/composio.js"

const readTools = [
  workspace.gmail_search,
  workspace.gmail_get,
  workspace.calendar_listEvents,
]

export default jig(
  "telegram-bot",
  {
    trigger: { type: "webhook" },
    tools: [...readTools],
    // tools: [...readTools, composio.execute_one_action],
  },
  async (ctx) => {
    // Telegram webhook payload is nested JSON
    const msg = ctx.params.message as any
    const text = msg?.text ?? JSON.stringify(ctx.params)
    const chatId = String(msg?.chat?.id ?? ctx.params.chat_id ?? "")

    ctx.output(`Telegram message: "${text}" from chat ${chatId}`)

    const reply = await ctx.step("Think and reply", readTools, async () => {
      return agent(
        `User sent this via Telegram: "${text}"

Help them. Search emails and calendar if relevant. Reply concisely.`,
        readTools
      )
    })

    ctx.output(reply)

    // Uncomment after running: jig connect composio
    // await ctx.step("Send to Telegram", [composio.execute_one_action], async () => {
    //   await composio.execute_one_action({
    //     platform: "telegram",
    //     actionId: "TELEGRAM_SEND_MESSAGE",
    //     input: { chat_id: chatId, text: reply },
    //   })
    // })
  }
)
