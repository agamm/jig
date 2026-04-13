import { describe, expect, it } from "bun:test"
import { runConnectFlow, type ConnectEvent } from "../shared/connect-flow.js"
import type { ConnectConnectionResponse, Connection } from "../shared/api.js"

describe("runConnectFlow", () => {
  it("lists servers through the backend adapter", async () => {
    const events: ConnectEvent[] = []
    const connections: Connection[] = [
      { name: "workspace", connected: false, toolCount: 0, description: "Google Workspace" },
      { name: "github", connected: true, toolCount: 44, description: "GitHub" },
    ]

    await runConnectFlow(undefined, {
      ask: async () => "",
      emit: (event) => events.push(event),
    }, {
      listConnections: async () => connections,
      connect: async () => {
        throw new Error("connect should not be called when listing servers")
      },
    })

    expect(events).toEqual([
      {
        type: "server-list",
        servers: [
          { name: "workspace", connected: false, toolCount: 0, description: "Google Workspace" },
          { name: "github", connected: true, toolCount: 44, description: "GitHub" },
        ],
      },
    ])
  })

  it("connects successfully without prompting when credentials are not needed", async () => {
    const events: ConnectEvent[] = []
    const calls: Array<{ name: string; credentials?: Record<string, string> }> = []
    const result: ConnectConnectionResponse = {
      ok: true,
      server: "workspace",
      toolCount: 3,
      tools: ["gmail_list", "calendar_list", "drive_search"],
    }

    await runConnectFlow("workspace", {
      ask: async () => {
        throw new Error("ask should not be called")
      },
      emit: (event) => events.push(event),
    }, {
      listConnections: async () => [],
      connect: async (name, credentials) => {
        calls.push({ name, credentials })
        return result
      },
    })

    expect(calls).toEqual([{ name: "workspace", credentials: undefined }])
    expect(events).toEqual([
      { type: "connecting", server: "workspace" },
      { type: "tools-discovered", server: "workspace", count: 3, tools: ["gmail_list", "calendar_list", "drive_search"] },
      { type: "server-ready", server: "workspace" },
    ])
  })

  it("prompts for missing credentials and retries through the same backend adapter", async () => {
    const events: ConnectEvent[] = []
    const prompts: string[] = []
    const calls: Array<{ name: string; credentials?: Record<string, string> }> = []
    let attempt = 0

    await runConnectFlow("github", {
      ask: async (question) => {
        prompts.push(question)
        return "secret-token"
      },
      emit: (event) => events.push(event),
    }, {
      listConnections: async () => [],
      connect: async (name, credentials) => {
        calls.push({ name, credentials })
        attempt += 1
        if (attempt === 1) {
          return {
            ok: false,
            server: "github",
            missingCredentials: ["GITHUB_TOKEN"],
            setup: "Create a personal access token first.",
          }
        }
        return {
          ok: true,
          server: "github",
          toolCount: 2,
          tools: ["repo_list", "pr_list"],
        }
      },
    })

    expect(prompts).toEqual(["Enter GITHUB_TOKEN:"])
    expect(calls).toEqual([
      { name: "github", credentials: undefined },
      { name: "github", credentials: { GITHUB_TOKEN: "secret-token" } },
    ])
    expect(events).toEqual([
      { type: "connecting", server: "github" },
      { type: "setup-instructions", message: "Create a personal access token first." },
      { type: "tools-discovered", server: "github", count: 2, tools: ["repo_list", "pr_list"] },
      { type: "server-ready", server: "github" },
    ])
  })
})
