/**
 * HTTP client for the Spawndroid console API.
 *
 * Thin on purpose: every method maps to one documented endpoint, and the only
 * parsing it does is of problem+json error bodies so callers can branch on the
 * machine-readable `code` instead of the message.
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { randomUUID } from "node:crypto"

/**
 * The id a user can quote for a failed request: the console's problem body
 * carries it, the console also sets `x-request-id`, and a platform error page
 * (no JSON body) still has the edge's `x-vercel-id`.
 */
function requestIdOf(body, headers) {
  const fromBody = body?.requestId ?? body?.["spawndroid:requestId"]
  if (typeof fromBody === "string" && fromBody) return fromBody
  return headers?.get?.("x-request-id") || headers?.get?.("x-vercel-id") || null
}

export class ApiError extends Error {
  constructor(status, body, path, headers = null) {
    const raw = body && (body.detail || body.error || body.title)
    // `detail` is usually a string but can be an object from a proxy or a
    // validation layer; never let an error message read "[object Object]".
    const detail =
      typeof raw === "string"
        ? raw
        : raw
          ? JSON.stringify(raw)
          : `HTTP ${status}`
    const requestId = requestIdOf(body, headers)
    // A 5xx is ours to fix; the id is what support needs to find it.
    super(
      `${status} ${detail}${status >= 500 && requestId ? ` (request id ${requestId})` : ""}`
    )
    this.name = "ApiError"
    this.requestId = requestId
    this.status = status
    this.code = body?.code ?? null
    this.legacyCode = body?.legacyCode ?? null
    this.body = body ?? null
    this.path = path
  }
}

export function createApi({
  baseUrl,
  apiKey,
  // `spawndroid-cli/<version>`. The console records it per run so it can tell
  // which clients attach test reports; Node's default agent is just "node".
  userAgent = "spawndroid-cli",
  fetchImpl = globalThis.fetch,
  // One retry after a 5xx: a cold function or a host restart usually
  // answers the second time, and every call here is safe to repeat (session
  // creates carry an Idempotency-Key, uploads re-register the same object).
  serverErrorRetryMs = 2_000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  const root = baseUrl.replace(/\/$/, "")
  const agent = `${userAgent} node/${process.versions.node}`

  async function once5xx(call) {
    try {
      return await call()
    } catch (error) {
      if (!(error instanceof ApiError) || error.status < 500) throw error
      await sleep(serverErrorRetryMs)
      return call()
    }
  }

  function request(path, init = {}) {
    return once5xx(() => requestOnce(path, init))
  }

  async function requestOnce(path, init = {}) {
    const headers = {
      Accept: "application/json",
      "User-Agent": agent,
      ...(init.headers ?? {}),
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    let response
    try {
      response = await fetchImpl(`${root}${path}`, { ...init, headers })
    } catch (error) {
      // status 0 marks a transport failure, which callers treat as transient.
      throw new ApiError(
        0,
        { detail: `network error: ${error?.cause?.code ?? error?.message ?? "fetch failed"}` },
        path
      )
    }
    if (response.status === 204) return null
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, body, path, response.headers)
    return body
  }

  function putFile(url, bytes, contentType) {
    return once5xx(() => putFileOnce(url, bytes, contentType))
  }

  async function putFileOnce(url, bytes, contentType) {
    let response
    try {
      response = await fetchImpl(url, {
        method: "PUT",
        headers: { "Content-Type": contentType ?? "application/octet-stream" },
        body: bytes,
      })
    } catch (error) {
      throw new ApiError(
        0,
        { detail: `network error: ${error?.cause?.code ?? error?.message ?? "fetch failed"}` },
        "presigned PUT"
      )
    }
    if (!response.ok) {
      throw new ApiError(response.status, null, "presigned PUT", response.headers)
    }
  }

  /**
   * The app plus the release this upload stored (`build`). The app's own
   * versionCode is its current build, the highest one, which need not be the
   * upload: per-ABI APKs carry the ABI in their versionCode.
   */
  function withBuild(body) {
    return body?.app ? { ...body.app, build: body.build ?? null } : body?.app
  }

  async function uploadApkSteps(file, github) {
    const bytes = await readFile(file)
    const filename = basename(file)
    // The bytes go straight to object storage: the console sits behind a
    // serverless function whose request body is capped well below a real
    // APK, so multipart only survives as a local-dev fallback.
    let presigned
    try {
      presigned = await request("/api/apps/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, size: bytes.length }),
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        const form = new FormData()
        form.append("file", new Blob([bytes]), filename)
        const body = await request("/api/apps", { method: "POST", body: form })
        return withBuild(body)
      }
      throw error
    }
    await putFile(
      presigned.url,
      bytes,
      presigned.contentType ?? "application/octet-stream"
    )
    const body = await request("/api/apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: presigned.key,
        filename,
        ...(github ? { github } : {}),
      }),
    })
    return withBuild(body)
  }

  return {
    baseUrl: root,

    /**
     * What the key can do. `/whoami` is the real answer; on deployments that
     * predate it, fall back to the session probe (404 means the key is valid).
     */
    async probe() {
      try {
        const body = await request("/api/v1/whoami")
        return {
          ok: true,
          scope: typeof body?.scope === "string" ? body.scope : null,
          plan: typeof body?.plan === "string" ? body.plan : null,
          planLabel: typeof body?.planLabel === "string" ? body.planLabel : null,
          slots: typeof body?.slots === "number" ? body.slots : null,
          maxSessionMinutes:
            typeof body?.maxSessionMinutes === "number" ? body.maxSessionMinutes : null,
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        if (error.status === 401 || error.status === 403) return { ok: false, error }
        if (error.status !== 404) throw error
        try {
          await request(`/api/v1/sessions/probe-${randomUUID()}`)
          return { ok: true, scope: null, plan: null, planLabel: null, slots: null, maxSessionMinutes: null }
        } catch (fallbackError) {
          if (fallbackError instanceof ApiError) {
            // A 404 on an unknown session means the key authenticates but the
            // session does not exist — exactly the probe's success case.
            if (fallbackError.status === 404) {
              return { ok: true, scope: null, plan: null, planLabel: null, slots: null, maxSessionMinutes: null }
            }
            if (fallbackError.status === 401 || fallbackError.status === 403) {
              return { ok: false, error: fallbackError }
            }
          }
          throw fallbackError
        }
      }
    },

    /**
     * The workspace the key belongs to, or null when the console predates
     * `whoami.workspace` or the read fails. Informational only: a run never
     * fails on it.
     */
    async workspace() {
      try {
        const body = await request("/api/v1/whoami")
        const ws = body?.workspace
        return typeof ws?.name === "string" && typeof ws?.slug === "string"
          ? { name: ws.name, slug: ws.slug }
          : null
      } catch {
        return null
      }
    },

    /** `github` (optional): the pull request the build comes from. */
    async uploadApk(file, github = null) {
      try {
        return await uploadApkSteps(file, github)
      } catch (error) {
        // Which step stopped, for the failed-attempt report: anything before
        // the bytes are stored is the upload, the rest is the registration.
        if (error instanceof ApiError && !error.attemptPhase) {
          error.attemptPhase = error.path === "/api/apps" ? "register" : "upload"
        }
        throw error
      }
    },

    /**
     * Tell the console a run failed before it had a session, so the Runs
     * page can show it. Identifiers only; best effort, never throws.
     */
    async reportAttempt(attempt) {
      try {
        await requestOnce("/api/v1/runs/attempts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attempt),
        })
        return true
      } catch {
        return false
      }
    },

    async createSession(fields, idempotencyKey) {
      return request("/api/v1/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(fields),
      })
    },

    async getSession(id) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}`)
    },

    /** `extra`: optional fields for the run, such as the output `summary`. */
    async endSession(id, result, extra = {}) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result, ...extra }),
      })
    },

    async presignFile(id, { filename, path, size }) {
      return request(
        `/api/v1/sessions/${encodeURIComponent(id)}/files/presign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename, path, size }),
        }
      )
    },

    putFile,

    async commitFile(id, fields) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      })
    },

    async postReport(id, xml) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      })
    },
  }
}
