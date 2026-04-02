import { isValidJigId } from "../domain/jig-id.js"

export function matchRoute(pathname: string): { handler: string; params: Record<string, string> } | null {
  if (pathname === "/api/models") return { handler: "getModels", params: {} }
  if (pathname === "/api/jigs") return { handler: "listJigs", params: {} }
  if (pathname === "/api/connections") return { handler: "connections", params: {} }

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

  const webhookMatch = pathname.match(/^\/api\/webhooks\/([^/]+)$/)
  if (webhookMatch) {
    if (!isValidJigId(decodeURIComponent(webhookMatch[1]))) return null
    return { handler: "webhook", params: { jigId: decodeURIComponent(webhookMatch[1]) } }
  }

  return null
}
