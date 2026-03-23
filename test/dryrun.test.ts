import { describe, it, expect } from "vitest"
import { isReadTool } from "../src/sdk/dryrun.js"

describe("isReadTool", () => {
  it("identifies common read tools", () => {
    // get/list/search — most common across all servers
    expect(isReadTool("gmail_get")).toBe(true)
    expect(isReadTool("gmail_search")).toBe(true)
    expect(isReadTool("list_meetings")).toBe(true)
    expect(isReadTool("get_meetings")).toBe(true)
    expect(isReadTool("calendar_listEvents")).toBe(true)
    expect(isReadTool("search_repositories")).toBe(true)
    expect(isReadTool("query_granola_meetings")).toBe(true)

    // less common read verbs
    expect(isReadTool("retrieve_balance")).toBe(true)
    expect(isReadTool("fetch_stripe_resources")).toBe(true)
    expect(isReadTool("lookupJiraAccountId")).toBe(true)
    expect(isReadTool("describe_table")).toBe(true)
    expect(isReadTool("check_status")).toBe(true)
    expect(isReadTool("count_items")).toBe(true)

    // safe despite "active" sounding
    expect(isReadTool("validate_query")).toBe(true)
    expect(isReadTool("verify_token")).toBe(true)
    expect(isReadTool("preview_invoice")).toBe(true)
    expect(isReadTool("estimate_cost")).toBe(true)

    // no-verb edge case
    expect(isReadTool("whoami")).toBe(true)
  })

  it("treats mutations as non-read (default dangerous)", () => {
    expect(isReadTool("gmail_createDraft")).toBe(false)
    expect(isReadTool("gmail_send")).toBe(false)
    expect(isReadTool("drive_deleteFile")).toBe(false)
    expect(isReadTool("sheets_updateCell")).toBe(false)
    expect(isReadTool("create_issue")).toBe(false)
    expect(isReadTool("push_files")).toBe(false)
    expect(isReadTool("merge_pull_request")).toBe(false)
    expect(isReadTool("fork_repository")).toBe(false)
    expect(isReadTool("cancel_subscription")).toBe(false)
    expect(isReadTool("finalize_invoice")).toBe(false)
    expect(isReadTool("submit_pending_pull_request_review")).toBe(false)
    expect(isReadTool("assign_copilot_to_issue")).toBe(false)
    expect(isReadTool("move_file")).toBe(false)
    expect(isReadTool("transition_issue")).toBe(false)
    expect(isReadTool("dismiss_notification")).toBe(false)
    expect(isReadTool("add_reaction")).toBe(false)
    expect(isReadTool("mark_all_notifications_read")).toBe(false)
  })

  it("treats unknown verbs as mutations (safe default)", () => {
    expect(isReadTool("do_something")).toBe(false)
    expect(isReadTool("run_workflow")).toBe(false)
    expect(isReadTool("execute_action")).toBe(false)
    expect(isReadTool("archive_channel")).toBe(false)
    expect(isReadTool("pin_message")).toBe(false)
    expect(isReadTool("duplicate_page")).toBe(false)
  })
})
