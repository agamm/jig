import { jig, llm } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"
import { composio } from "@jig/connections/composio.js"

const morningCalendarTelegram = jig(
  "morning-calendar-telegram",
  {
    trigger: { type: "manual" },
    tools: [workspace.calendar_list, workspace.calendar_listEvents, composio.telegram_send_message],
  },
  async (ctx) => {
    // Hardcoded Telegram channel — replace with your own handle or chat_id
    const telegramChat = "@YourTelegramHandle"
    
    // Get today's date range
    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0)
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59)
    
    const timeMin = startOfDay.toISOString()
    const timeMax = endOfDay.toISOString()
    
    await ctx.step("Get calendar events", [workspace.calendar_list, workspace.calendar_listEvents], async () => {
      // Get list of calendars
      const calendars = await workspace.calendar_list({})
      ctx.output(`Found ${Array.isArray(calendars) ? calendars.length : 0} calendars`)
      
      // Get primary calendar ID (usually first one)
      const primaryCalendar = Array.isArray(calendars) && calendars.length > 0 ? calendars[0] : null
      const calendarId = primaryCalendar && typeof primaryCalendar === 'object' && 'id' in primaryCalendar 
        ? String(primaryCalendar.id) 
        : 'primary'
      
      ctx.output(`Using calendar: ${calendarId}`)
      
      // Get today's events
      const events = await workspace.calendar_listEvents({
        calendarId,
        timeMin,
        timeMax
      })
      
      // Format events for display
      const eventList = Array.isArray(events) ? events : []
      
      if (eventList.length === 0) {
        const message = `📅 Today's Calendar (${today.toLocaleDateString()})\n\nNo events scheduled for today. Enjoy!`
        
        await ctx.step("Send Telegram message", [composio.telegram_send_message], async () => {
          await composio.telegram_send_message({
            chat_id: telegramChat,
            text: message
          })
          ctx.output(`Sent to Telegram: ${telegramChat}`)
        })
        return
      }
      
      // Format events nicely
      let message = `📅 Today's Calendar (${today.toLocaleDateString()})\n\n`
      
      eventList.forEach((event: any, index: number) => {
        const summary = event.summary || 'Untitled event'
        const startTime = event.start?.dateTime || event.start?.date
        const endTime = event.end?.dateTime || event.end?.date
        
        let timeString = ''
        if (startTime && endTime) {
          const start = new Date(startTime)
          const end = new Date(endTime)
          
          // Check if it's all-day event
          if (startTime.includes('T') && endTime.includes('T')) {
            timeString = `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          } else {
            timeString = 'All day'
          }
        } else {
          timeString = 'Time not specified'
        }
        
        message += `${index + 1}. ${summary}\n   ⏰ ${timeString}\n\n`
      })
      
      message += `Total: ${eventList.length} event${eventList.length !== 1 ? 's' : ''}`
      
      await ctx.step("Send Telegram message", [composio.telegram_send_message], async () => {
        await composio.telegram_send_message({
          chat_id: telegramChat,
          text: message
        })
        ctx.output(`Sent ${eventList.length} events to Telegram: ${telegramChat}`)
      })
    })
  }
)

export default morningCalendarTelegram