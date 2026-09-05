import { describe, expect, it } from "bun:test"
import { imageRef, releaseImageTag, resolveDeployImage } from "../src/cli-deploy/image.js"

describe("deploy image choice", () => {
  it("pins the checkout's release when its image is published", async () => {
    const asked: string[] = []
    const result = await resolveDeployImage("0.1.136", async (tag) => { asked.push(tag); return tag === "v0.1.136" })
    expect(result).toEqual({ image: "ghcr.io/agamm/jig:v0.1.136", pinned: true })
    expect(asked).toEqual(["v0.1.136"])
  })

  it("falls back to latest when the checkout is ahead of the published tags", async () => {
    // A fresh clone of main often carries a version whose tag is not pushed yet.
    const result = await resolveDeployImage("0.1.137", async () => false)
    expect(result).toEqual({ image: "ghcr.io/agamm/jig:latest", pinned: false })
  })

  it("accepts versions with or without the v prefix", () => {
    expect(releaseImageTag("0.1.2")).toBe("v0.1.2")
    expect(releaseImageTag("v0.1.2")).toBe("v0.1.2")
    expect(imageRef("latest")).toBe("ghcr.io/agamm/jig:latest")
  })
})
