import { isValidJigId } from "../domain/jig-id.js"

export function matchRoute(pathname: string): { handler: string; params: Record<string, string> } | null {
  if (pathname === "/api/events") return { handler: "liveUpdates", params: {} }
  if (pathname === "/api/models") return { handler: "getModels", params: {} }
  if (pathname === "/api/jigs") return { handler: "listJigs", params: {} }
  if (pathname === "/api/examples") return { handler: "listExamples", params: {} }

  const addExampleMatch = pathname.match(/^\/api\/examples\/([^/]+)\/add$/)
  if (addExampleMatch) return { handler: "addExample", params: { id: decodeURIComponent(addExampleMatch[1]) } }

  if (pathname === "/api/connections") return { handler: "connections", params: {} }

  const connectMatch = pathname.match(/^\/api\/connections\/([^/]+)\/connect$/)
  if (connectMatch) return { handler: "connectConnection", params: { name: decodeURIComponent(connectMatch[1]) } }

  const connMatch = pathname.match(/^\/api\/connections\/([^/]+)$/)
  if (connMatch) return { handler: "getConnection", params: { name: decodeURIComponent(connMatch[1]) } }

  const jigMatch = pathname.match(/^\/api\/jigs\/([^/]+)$/)
  if (jigMatch) {
    if (!isValidJigId(decodeURIComponent(jigMatch[1]))) return null
    return { handler: "getJig", params: { id: decodeURIComponent(jigMatch[1]) } }
  }

  const runMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/run$/)
  if (runMatch) {
    if (!isValidJigId(decodeURIComponent(runMatch[1]))) return null
    return { handler: "runJig", params: { id: decodeURIComponent(runMatch[1]) } }
  }

  const runDetailMatch = pathname.match(/^\/api\/runs\/(-?\d+)$/)
  if (runDetailMatch) return { handler: "getRun", params: { id: runDetailMatch[1] } }

  const stepsMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/steps$/)
  if (stepsMatch) {
    if (!isValidJigId(decodeURIComponent(stepsMatch[1]))) return null
    return { handler: "getSteps", params: { id: decodeURIComponent(stepsMatch[1]) } }
  }

  const triggerMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/trigger$/)
  if (triggerMatch) {
    if (!isValidJigId(decodeURIComponent(triggerMatch[1]))) return null
    return { handler: "updateTrigger", params: { id: decodeURIComponent(triggerMatch[1]) } }
  }

  if (pathname === "/api/agent") return { handler: "startAgent", params: {} }

  const agentStatusMatch = pathname.match(/^\/api\/agent\/([^/]+)$/)
  if (agentStatusMatch) return { handler: "agentStatus", params: { sessionId: agentStatusMatch[1] } }

  const agentMsgMatch = pathname.match(/^\/api\/agent\/([^/]+)\/message$/)
  if (agentMsgMatch) return { handler: "agentMessage", params: { sessionId: agentMsgMatch[1] } }

  const agentApproveMatch = pathname.match(/^\/api\/agent\/([^/]+)\/approve$/)
  if (agentApproveMatch) return { handler: "agentApprove", params: { sessionId: agentApproveMatch[1] } }

  const agentCloseMatch = pathname.match(/^\/api\/agent\/([^/]+)\/close$/)
  if (agentCloseMatch) return { handler: "agentClose", params: { sessionId: agentCloseMatch[1] } }

  const versionsMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/versions$/)
  if (versionsMatch) {
    if (!isValidJigId(decodeURIComponent(versionsMatch[1]))) return null
    return { handler: "getVersions", params: { id: decodeURIComponent(versionsMatch[1]) } }
  }

  const versionCodeMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/versions\/([^/]+)$/)
  if (versionCodeMatch) {
    if (!isValidJigId(decodeURIComponent(versionCodeMatch[1]))) return null
    return { handler: "getVersionCode", params: { id: decodeURIComponent(versionCodeMatch[1]), sha: versionCodeMatch[2] } }
  }

  const restoreVersionMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/versions\/([^/]+)\/restore$/)
  if (restoreVersionMatch) {
    if (!isValidJigId(decodeURIComponent(restoreVersionMatch[1]))) return null
    return { handler: "restoreVersion", params: { id: decodeURIComponent(restoreVersionMatch[1]), sha: restoreVersionMatch[2] } }
  }

  if (pathname === "/api/runs/active") return { handler: "activeRun", params: {} }
  if (pathname === "/api/runs/cancel") return { handler: "cancelRun", params: {} }

  // Scheduler routes
  if (pathname === "/api/schedules") return { handler: "listSchedules", params: {} }

  const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleMatch) {
    if (!isValidJigId(decodeURIComponent(scheduleMatch[1]))) return null
    return { handler: "updateSchedule", params: { jigId: decodeURIComponent(scheduleMatch[1]) } }
  }

  if (pathname === "/api/authorized-senders") return { handler: "authorizedSenders", params: {} }

  const senderMatch = pathname.match(/^\/api\/authorized-senders\/([^/]+)\/(.+)$/)
  if (senderMatch) return { handler: "deleteAuthorizedSender", params: { channel: decodeURIComponent(senderMatch[1]), senderId: decodeURIComponent(senderMatch[2]) } }

  if (pathname === "/api/settings/notifications") return { handler: "notificationSettings", params: {} }
  if (pathname === "/api/settings/notifications/test") return { handler: "notificationSettingsTest", params: {} }
  if (pathname === "/api/settings/reset-local") return { handler: "resetLocalState", params: {} }
  if (pathname === "/api/permissions") return { handler: "toolPermissions", params: {} }

  const webhookMatch = pathname.match(/^\/api\/webhooks\/([^/]+)$/)
  if (webhookMatch) {
    if (!isValidJigId(decodeURIComponent(webhookMatch[1]))) return null
    return { handler: "webhook", params: { jigId: decodeURIComponent(webhookMatch[1]) } }
  }

  return null
}
