import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * Railway CLI 5.45 stopped creating a service during `railway init`, but the
 * deploy script still assumed one existed: it linked to a service that was not
 * there, then tried to attach /data to nothing and died at the volume step,
 * leaving the operator to add the service, link, mount and generate a domain by
 * hand. Observed on 5.45.4.
 */
describe("jig deploy provisioning", () => {
  const source = readFileSync("src/cli-deploy/index.ts", "utf-8")

  it("creates a service from the published image when init did not leave one", () => {
    expect(source).toMatch(/addImageService\(slug, image, variables\)/)
  })

  it("creates it before linking and before the volume", () => {
    // Scoped to runDeploy: "Attaching /data volume" also appears in the
    // separate repair command, which sits earlier in the file.
    // Anchored on the signature, not the name: runDeployArgs matches "runDeploy"
    // too, and slicing from there swept in the separate repair command.
    const deploy = source.slice(source.indexOf("export async function runDeploy(targetArg"))
    const add = deploy.indexOf('addImageService(slug, image, variables)')
    const link = deploy.indexOf("Linking cwd to service")
    const volume = deploy.indexOf("Attaching /data volume")
    expect(add).toBeGreaterThan(-1)
    expect(add).toBeLessThan(link)
    expect(add).toBeLessThan(volume)
  })

  it("does not claim init makes a service any more", () => {
    // The stale comment is what kept the bug invisible for so long.
    expect(source).not.toMatch(/Railway creates a service named\s*\n?\s*\/\/ after the project during init/)
  })

  it("shows the Railway identity and requires scope confirmation before init", () => {
    const deploy = source.slice(source.indexOf("export async function runDeploy(targetArg"))
    const identity = deploy.indexOf("getRailwayIdentity()")
    const confirmation = deploy.indexOf('confirm("Use this account and choose its workspace for the new project?", false)')
    const init = deploy.indexOf('railwayInteractive(initArgs)')
    expect(identity).toBeGreaterThan(-1)
    expect(confirmation).toBeGreaterThan(identity)
    expect(init).toBeGreaterThan(confirmation)
  })
})
