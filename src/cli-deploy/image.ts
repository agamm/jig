/**
 * Which container image a deploy runs.
 *
 * CI publishes ghcr.io/agamm/jig on every push to main (`latest`) and on every
 * release tag (`vX.Y.Z`). A deploy pins the checkout's own release when that
 * image exists and falls back to `latest` when the checkout is ahead of the
 * tags, so a fresh clone of main still deploys. Pinned images are what make
 * `jig update <handle>` and its rollback deterministic.
 */
export const IMAGE_REPO = "ghcr.io/agamm/jig"

export function imageRef(tag: string): string {
  return `${IMAGE_REPO}:${tag}`
}

export function releaseImageTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`
}

/** Anonymous manifest lookup; the image is public. Network trouble reads as "not there". */
export async function ghcrTagExists(tag: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const [owner, name] = IMAGE_REPO.replace(/^ghcr\.io\//, "").split("/")
    const tokenRes = await fetchImpl(`https://ghcr.io/token?scope=repository:${owner}/${name}:pull`, { signal: AbortSignal.timeout(10_000) })
    if (!tokenRes.ok) return false
    const { token } = (await tokenRes.json()) as { token?: string }
    if (!token) return false
    const res = await fetchImpl(`https://ghcr.io/v2/${owner}/${name}/manifests/${tag}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
      },
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function resolveDeployImage(
  version: string,
  exists: (tag: string) => Promise<boolean> = ghcrTagExists,
): Promise<{ image: string; pinned: boolean }> {
  const tag = releaseImageTag(version)
  if (await exists(tag)) return { image: imageRef(tag), pinned: true }
  return { image: imageRef("latest"), pinned: false }
}
