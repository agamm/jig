/**
 * JIG_DATA_KEY on an existing service. Instances deployed before the variable
 * existed, or created from a template that lacked it, lock on every restart.
 * The deploying machine holds the Railway ids and can add the variable through
 * the API; any other machine can only say what to click.
 */
import { getServiceVariableNames, upsertServiceVariable } from "../cli-deploy/railway-cli.js"
import { DATA_KEY_ENV, mintDataKey } from "../crypto/password.js"
import type { RemoteManifest } from "./manifest.js"

export type DataKeyVariableResult = "present" | "added" | "no-railway-ids" | "failed"

/**
 * Add the variable when the service lacks it. Skips the deploy the change would
 * trigger, so the running instance is untouched: the next restart boots with
 * the key, asks for the password once (which wraps it), and never asks again.
 * Best-effort, since neither an update nor a setup must depend on it.
 */
export async function ensureDataKeyVariable(remote: RemoteManifest): Promise<DataKeyVariableResult> {
  const r = remote.railway
  if (!r?.project_id || !r.service_id || !r.environment_id) return "no-railway-ids"
  const ids = { projectId: r.project_id, environmentId: r.environment_id, serviceId: r.service_id }
  let names: string[]
  try {
    names = await getServiceVariableNames(ids)
  } catch (e: any) {
    console.warn(`  Could not read the service variables (${e?.message ?? e}); skipping the ${DATA_KEY_ENV} check.`)
    return "failed"
  }
  if (names.includes(DATA_KEY_ENV)) return "present"
  console.log(`  Adding ${DATA_KEY_ENV} so the instance unlocks itself after restarts...`)
  try {
    await upsertServiceVariable({ ...ids, name: DATA_KEY_ENV, value: mintDataKey() })
    return "added"
  } catch (e: any) {
    console.warn(`  Could not set ${DATA_KEY_ENV} (${e?.message ?? e}); the instance will keep locking on restart.`)
    return "failed"
  }
}

/** What to tell the user when this machine cannot add the variable itself. */
export function manualDataKeySteps(): string[] {
  return [
    `This instance locks on every restart: its service has no ${DATA_KEY_ENV} variable.`,
    `In Railway open the service, then Variables, and add ${DATA_KEY_ENV} with 64 random hex characters`,
    `(any generated value works; never reuse one). The next restart asks for the password once,`,
    `after that the instance unlocks itself.`,
  ]
}
