import { isValidJigId } from "../domain/jig-id.js"

export function matchRoute(pathname: string): { handler: string; params: Record<string, string> } | null {
  if (pathname === "/api/health") return { handler: "health", params: {} }
  if (pathname === "/api/unlock") return { handler: "unlock", params: {} }
  if (pathname === "/api/setup-password") return { handler: "setupPassword", params: {} }
  if (pathname === "/api/change-password") return { handler: "changePassword", params: {} }
  if (pathname === "/api/onboarding/complete") return { handler: "completeOnboarding", params: {} }
  if (pathname === "/api/oauth/callback") return { handler: "oauthCallback", params: {} }
  if (pathname === "/api/events") return { handler: "liveUpdates", params: {} }
  if (pathname === "/api/models") return { handler: "models", params: {} }
  if (pathname === "/api/models/catalog") return { handler: "modelsCatalog", params: {} }
  if (pathname === "/api/models/credits") return { handler: "openrouterCredits", params: {} }
  if (pathname === "/api/classify-failure") return { handler: "classifyFailure", params: {} }
  if (pathname === "/api/models/upgrades") return { handler: "modelUpgrades", params: {} }
  if (pathname === "/api/models/upgrades/apply") return { handler: "applyModelUpgrade", params: {} }
  if (pathname === "/api/models/upgrades/dismiss") return { handler: "dismissModelUpgrade", params: {} }
  if (pathname === "/api/jigs") return { handler: "listJigs", params: {} }
  if (pathname === "/api/examples") return { handler: "listExamples", params: {} }

  const addExampleMatch = pathname.match(/^\/api\/examples\/([^/]+)\/add$/)
  if (addExampleMatch) return { handler: "addExample", params: { id: decodeURIComponent(addExampleMatch[1]) } }

  if (pathname === "/api/connections") return { handler: "connections", params: {} }
  if (pathname === "/api/connections/custom") return { handler: "createCustomConnection", params: {} }

  const connectMatch = pathname.match(/^\/api\/connections\/([^/]+)\/connect$/)
  if (connectMatch) return { handler: "connectConnection", params: { name: decodeURIComponent(connectMatch[1]) } }

  const disconnectMatch = pathname.match(/^\/api\/connections\/([^/]+)\/disconnect$/)
  if (disconnectMatch) return { handler: "disconnectConnection", params: { name: decodeURIComponent(disconnectMatch[1]) } }

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

  const writeCodeMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/code$/)
  if (writeCodeMatch) {
    if (!isValidJigId(decodeURIComponent(writeCodeMatch[1]))) return null
    return { handler: "writeJigCode", params: { id: decodeURIComponent(writeCodeMatch[1]) } }
  }

  const modelMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/model$/)
  if (modelMatch) {
    if (!isValidJigId(decodeURIComponent(modelMatch[1]))) return null
    return { handler: "updateJigModel", params: { id: decodeURIComponent(modelMatch[1]) } }
  }

  const timeoutsMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/timeouts$/)
  if (timeoutsMatch) {
    if (!isValidJigId(decodeURIComponent(timeoutsMatch[1]))) return null
    return { handler: "updateJigTimeouts", params: { id: decodeURIComponent(timeoutsMatch[1]) } }
  }

  const stepModelMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/step-model$/)
  if (stepModelMatch) {
    if (!isValidJigId(decodeURIComponent(stepModelMatch[1]))) return null
    return { handler: "updateJigStepModel", params: { id: decodeURIComponent(stepModelMatch[1]) } }
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

  const agentStreamMatch = pathname.match(/^\/api\/agent\/([^/]+)\/stream$/)
  if (agentStreamMatch) return { handler: "agentStream", params: { sessionId: agentStreamMatch[1] } }

  const agentStatusMatch = pathname.match(/^\/api\/agent\/([^/]+)$/)
  if (agentStatusMatch) return { handler: "agentStatus", params: { sessionId: agentStatusMatch[1] } }

  const agentMsgMatch = pathname.match(/^\/api\/agent\/([^/]+)\/message$/)
  if (agentMsgMatch) return { handler: "agentMessage", params: { sessionId: agentMsgMatch[1] } }

  const agentApproveMatch = pathname.match(/^\/api\/agent\/([^/]+)\/approve$/)
  if (agentApproveMatch) return { handler: "agentApprove", params: { sessionId: agentApproveMatch[1] } }

  const agentCloseMatch = pathname.match(/^\/api\/agent\/([^/]+)\/close$/)
  if (agentCloseMatch) return { handler: "agentClose", params: { sessionId: agentCloseMatch[1] } }

  // v12: code-as-versions endpoints
  const pendingMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/pending$/)
  if (pendingMatch) {
    if (!isValidJigId(decodeURIComponent(pendingMatch[1]))) return null
    return { handler: "pending", params: { id: decodeURIComponent(pendingMatch[1]) } }
  }
  const approvePendingMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/pending\/approve$/)
  if (approvePendingMatch) {
    if (!isValidJigId(decodeURIComponent(approvePendingMatch[1]))) return null
    return { handler: "approvePending", params: { id: decodeURIComponent(approvePendingMatch[1]) } }
  }
  const restoreToPendingMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/restore$/)
  if (restoreToPendingMatch) {
    if (!isValidJigId(decodeURIComponent(restoreToPendingMatch[1]))) return null
    return { handler: "restoreToPending", params: { id: decodeURIComponent(restoreToPendingMatch[1]) } }
  }
  const listVersionsV2Match = pathname.match(/^\/api\/jigs\/([^/]+)\/versions-v2$/)
  if (listVersionsV2Match) {
    if (!isValidJigId(decodeURIComponent(listVersionsV2Match[1]))) return null
    return { handler: "listVersionsV2", params: { id: decodeURIComponent(listVersionsV2Match[1]) } }
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
  if (pathname === "/api/settings/resend") return { handler: "resendSettings", params: {} }
  if (pathname === "/api/settings/resend/test") return { handler: "resendTest", params: {} }
  if (pathname === "/api/settings/system") return { handler: "systemSettings", params: {} }
  if (pathname === "/api/settings/reset-local") return { handler: "resetLocalState", params: {} }
  if (pathname === "/api/permissions") return { handler: "toolPermissions", params: {} }
  if (pathname === "/api/logs") return { handler: "serverLogs", params: {} }

  const webhookMatch = pathname.match(/^\/api\/webhooks\/([^/]+)$/)
  if (webhookMatch) {
    if (!isValidJigId(decodeURIComponent(webhookMatch[1]))) return null
    return { handler: "webhook", params: { jigId: decodeURIComponent(webhookMatch[1]) } }
  }

  return null
}
