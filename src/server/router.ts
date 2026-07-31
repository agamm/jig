import { isValidJigId } from "../domain/jig-id.js"

export interface MatchedRoute {
  handler: string
  params: Record<string, string>
}

/**
 * Path -> handler table.
 *
 * Segment markers:
 *   `:name`  capture one segment, URI-decoded
 *   `#name`  same, but the value must be a valid jig id or the route does not
 *            match (a bad id 404s at the router instead of reaching a handler)
 *   `+name`  same, but the value must be an integer
 *   `*name`  capture the rest of the path, URI-decoded
 *
 * Order matters: the first match wins, so literal paths must precede the
 * patterns that would otherwise swallow them (e.g. /api/connections/custom
 * before /api/connections/:name).
 */
const ROUTES: [pattern: string, handler: string][] = [
  ["/api/health", "health"],
  ["/api/unlock", "unlock"],
  ["/api/setup-password", "setupPassword"],
  ["/api/change-password", "changePassword"],
  ["/api/onboarding/complete", "completeOnboarding"],
  ["/api/oauth/callback", "oauthCallback"],
  ["/api/events", "liveUpdates"],

  ["/api/models", "models"],
  ["/api/models/catalog", "modelsCatalog"],
  ["/api/models/credits", "openrouterCredits"],
  ["/api/models/upgrades", "modelUpgrades"],
  ["/api/models/upgrades/apply", "applyModelUpgrade"],
  ["/api/models/upgrades/dismiss", "dismissModelUpgrade"],
  ["/api/classify-failure", "classifyFailure"],

  ["/api/jigs", "listJigs"],
  ["/api/examples", "listExamples"],
  ["/api/examples/:id/add", "addExample"],

  ["/api/connections", "connections"],
  ["/api/connections/custom", "createCustomConnection"],
  ["/api/connections/:name/connect", "connectConnection"],
  ["/api/connections/:name/disconnect", "disconnectConnection"],
  ["/api/connections/:name", "getConnection"],

  ["/api/jigs/#id", "getJig"],
  ["/api/jigs/#id/run", "runJig"],
  ["/api/jigs/#id/code", "writeJigCode"],
  ["/api/jigs/#id/model", "updateJigModel"],
  ["/api/jigs/#id/timeouts", "updateJigTimeouts"],
  ["/api/jigs/#id/step-model", "updateJigStepModel"],
  ["/api/jigs/#id/steps", "getSteps"],
  ["/api/jigs/#id/trigger", "updateTrigger"],
  ["/api/jigs/#id/pending", "pending"],
  ["/api/jigs/#id/pending/approve", "approvePending"],
  ["/api/jigs/#id/restore", "restoreToPending"],
  ["/api/jigs/#id/versions-v2", "listVersionsV2"],

  ["/api/agent", "startAgent"],
  ["/api/agent/:sessionId", "agentStatus"],
  ["/api/agent/:sessionId/stream", "agentStream"],
  ["/api/agent/:sessionId/message", "agentMessage"],
  ["/api/agent/:sessionId/approve", "agentApprove"],
  ["/api/agent/:sessionId/close", "agentClose"],

  ["/api/runs/active", "activeRun"],
  ["/api/runs/cancel", "cancelRun"],
  ["/api/runs/+id", "getRun"],

  ["/api/schedules", "listSchedules"],
  ["/api/schedules/#jigId", "updateSchedule"],

  ["/api/authorized-senders", "authorizedSenders"],
  ["/api/authorized-senders/:channel/*senderId", "deleteAuthorizedSender"],

  ["/api/settings/agentmail", "agentMailSettings"],
  ["/api/settings/agentmail/setup", "agentMailSetup"],
  ["/api/settings/agentmail/test", "agentMailTest"],
  ["/api/settings/system", "systemSettings"],
  ["/api/settings/reset-local", "resetLocalState"],
  ["/api/email/inbound", "emailInbound"],
  ["/api/permissions", "toolPermissions"],
  ["/api/logs", "serverLogs"],

  ["/api/webhooks/#jigId", "webhook"],
]

const COMPILED = ROUTES.map(([pattern, handler]) => ({
  handler,
  segments: pattern.split("/"),
  // A rest param consumes every remaining segment, so those patterns match any
  // length at or beyond their own; everything else must match exactly.
  hasRest: pattern.includes("/*"),
}))

export function matchRoute(pathname: string): MatchedRoute | null {
  const actual = pathname.split("/")

  for (const route of COMPILED) {
    if (route.hasRest ? actual.length < route.segments.length : actual.length !== route.segments.length) {
      continue
    }

    const params: Record<string, string> = {}
    let matched = true

    for (let i = 0; i < route.segments.length; i++) {
      const expected = route.segments[i]
      const marker = expected[0]

      if (marker === "*") {
        const rest = actual.slice(i).join("/")
        if (!rest) { matched = false; break }
        params[expected.slice(1)] = decodeURIComponent(rest)
        break
      }
      if (marker === ":" || marker === "#" || marker === "+") {
        // An empty segment (`/api/agent//stream`) is not a match — it would
        // otherwise hand handlers a blank id.
        if (!actual[i]) { matched = false; break }
        const value = decodeURIComponent(actual[i])
        if (marker === "#" && !isValidJigId(value)) { matched = false; break }
        if (marker === "+" && !/^-?\d+$/.test(value)) { matched = false; break }
        params[expected.slice(1)] = value
        continue
      }
      if (expected !== actual[i]) { matched = false; break }
    }

    if (matched) return { handler: route.handler, params }
  }

  return null
}
