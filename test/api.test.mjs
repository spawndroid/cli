import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createApi } from "../src/api.mjs"

async function consoleWith(routes) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost")
    const status = routes[url.pathname]
    if (status === undefined) {
      response.writeHead(404, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ code: "SESSION_NOT_FOUND", detail: "Session not found." }))
      return
    }
    response.writeHead(status[0], { "Content-Type": "application/json" })
    response.end(JSON.stringify(status[1] ?? {}))
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

test("uploadApk goes through presign, PUT and register", async () => {
  const seen = { presign: null, put: 0, register: null }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const json = () => JSON.parse(raw.toString("utf8"))
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.method === "POST" && url.pathname === "/api/apps/presign") {
      seen.presign = json()
      return send(200, {
        key: "tenant/app.apk",
        url: `http://127.0.0.1:${server.address().port}/upload`,
        contentType: "application/vnd.android.package-archive",
      })
    }
    if (request.method === "PUT" && url.pathname === "/upload") {
      seen.put = raw.length
      return send(200, {})
    }
    if (request.method === "POST" && url.pathname === "/api/apps") {
      seen.register = json()
      return send(201, { app: { slug: "checkout" } })
    }
    return send(404, { code: "NOT_FOUND" })
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-upload-"))
  writeFileSync(join(dir, "app-debug.apk"), Buffer.alloc(2048, 1))
  try {
    const api = createApi({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "test",
    })
    const app = await api.uploadApk(join(dir, "app-debug.apk"))
    assert.equal(app.slug, "checkout")
    assert.deepEqual(seen.presign, { filename: "app-debug.apk", size: 2048 })
    assert.equal(seen.put, 2048)
    assert.deepEqual(seen.register, { key: "tenant/app.apk", filename: "app-debug.apk" })

    const github = { repository: "acme/shop", pullNumber: 42, headSha: "b".repeat(40) }
    await api.uploadApk(join(dir, "app-debug.apk"), github)
    assert.deepEqual(seen.register, {
      key: "tenant/app.apk",
      filename: "app-debug.apk",
      github,
    })
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test("whoami answers with the scope and plan", async () => {
  const consoleState = await consoleWith({
    "/api/v1/whoami": [200, { scope: "upload", plan: "free", planLabel: "Hobby" }],
  })
  try {
    const api = createApi({ baseUrl: consoleState.baseUrl, apiKey: "test" })
    const probe = await api.probe()
    assert.equal(probe.ok, true)
    assert.equal(probe.scope, "upload")
    assert.equal(probe.planLabel, "Hobby")
  } finally {
    await consoleState.close()
  }
})

test("a deployment without whoami falls back to the session probe", async () => {
  // `/whoami` missing (404) and the unknown session also 404: a valid key.
  const consoleState = await consoleWith({})
  try {
    const api = createApi({ baseUrl: consoleState.baseUrl, apiKey: "test" })
    const probe = await api.probe()
    assert.equal(probe.ok, true)
    assert.equal(probe.scope, null)
  } finally {
    await consoleState.close()
  }
})

test("a rejected key fails both probes", async () => {
  const consoleState = await consoleWith({})
  try {
    const api = createApi({
      baseUrl: consoleState.baseUrl,
      apiKey: "bad",
      fetchImpl: async (url, init) => {
        void init
        return new Response(
          JSON.stringify({ detail: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
      },
    })
    const probe = await api.probe()
    assert.equal(probe.ok, false)
  } finally {
    await consoleState.close()
  }
})

test("every console request names the CLI and its version", async () => {
  const seen = []
  const api = createApi({
    baseUrl: "https://console.test",
    apiKey: "sd_test",
    userAgent: "spawndroid-cli/9.9.9",
    fetchImpl: async (url, init) => {
      seen.push(init.headers["User-Agent"])
      return new Response(JSON.stringify({ scope: "upload" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  await api.probe().catch(() => undefined)
  assert.ok(seen.length > 0)
  for (const agent of seen) {
    assert.match(agent, /^spawndroid-cli\/9\.9\.9 node\/\d+/)
  }
})

async function scripted(handler) {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    handler(request, response, Buffer.concat(chunks).toString("utf8"))
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

const noSleep = async () => {}

test("a 5xx is retried once and the second answer wins", async () => {
  let calls = 0
  const server = await scripted((_request, response) => {
    calls += 1
    response.writeHead(calls === 1 ? 500 : 200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(calls === 1 ? { code: "INTERNAL" } : { tenantId: "org_1" }))
  })
  try {
    const api = createApi({ baseUrl: server.baseUrl, apiKey: "k", sleep: noSleep })
    assert.equal((await api.probe()).ok, true)
    assert.equal(calls, 2)
  } finally {
    await server.close()
  }
})

test("a 5xx that repeats names the request id to quote", async () => {
  let calls = 0
  const server = await scripted((_request, response) => {
    calls += 1
    response.writeHead(500, { "Content-Type": "application/problem+json" })
    response.end(
      JSON.stringify({
        code: "INTERNAL",
        detail: "An unexpected error stopped this request.",
        requestId: "req_828daf7756ba4e3480a1",
      })
    )
  })
  try {
    const api = createApi({ baseUrl: server.baseUrl, apiKey: "k", sleep: noSleep })
    const error = await api.createSession({}, "idem").catch((e) => e)
    assert.equal(calls, 2, "one retry, not more")
    assert.equal(error.requestId, "req_828daf7756ba4e3480a1")
    assert.match(error.message, /\(request id req_828daf7756ba4e3480a1\)$/)
  } finally {
    await server.close()
  }
})

test("a platform error page without JSON still yields the edge's id", async () => {
  const server = await scripted((_request, response) => {
    response.writeHead(502, { "Content-Type": "text/html", "x-vercel-id": "fra1::abc-123" })
    response.end("<html>Bad gateway</html>")
  })
  try {
    const api = createApi({ baseUrl: server.baseUrl, apiKey: "k", sleep: noSleep })
    const error = await api.getSession("sess_1").catch((e) => e)
    assert.equal(error.requestId, "fra1::abc-123")
  } finally {
    await server.close()
  }
})

test("a 4xx is not retried and carries no request id in its message", async () => {
  let calls = 0
  const server = await scripted((_request, response) => {
    calls += 1
    response.writeHead(400, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ code: "INVALID_REQUEST", detail: "bad", requestId: "req_1" }))
  })
  try {
    const api = createApi({ baseUrl: server.baseUrl, apiKey: "k", sleep: noSleep })
    const error = await api.getSession("sess_1").catch((e) => e)
    assert.equal(calls, 1)
    assert.equal(error.message, "400 bad")
    assert.equal(error.requestId, "req_1")
  } finally {
    await server.close()
  }
})

test("an upload failure names its step: upload before the bytes land, register after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-phase-"))
  writeFileSync(join(dir, "app.apk"), Buffer.alloc(16, 1))
  for (const [failing, phase] of [
    ["/api/apps/presign", "upload"],
    ["/api/apps", "register"],
  ]) {
    const server = await scripted((request, response, _body) => {
      const url = new URL(request.url, "http://localhost")
      const send = (status, body) => {
        response.writeHead(status, { "Content-Type": "application/json" })
        response.end(JSON.stringify(body))
      }
      if (url.pathname === failing) return send(500, { code: "INTERNAL", detail: "boom" })
      if (url.pathname === "/api/apps/presign") {
        return send(200, { key: "k", url: `http://127.0.0.1:${server.port}/put` })
      }
      return send(200, {})
    })
    server.port = new URL(server.baseUrl).port
    try {
      const api = createApi({ baseUrl: server.baseUrl, apiKey: "k", sleep: noSleep })
      const error = await api.uploadApk(join(dir, "app.apk")).catch((e) => e)
      assert.equal(error.attemptPhase, phase, failing)
    } finally {
      await server.close()
    }
  }
})

test("reportAttempt posts identifiers once and never throws", async () => {
  const seen = []
  const server = await scripted((request, response, body) => {
    seen.push({ path: request.url, body: JSON.parse(body) })
    response.writeHead(500, { "Content-Type": "application/json" })
    response.end("{}")
  })
  try {
    const api = createApi({ baseUrl: server.baseUrl, apiKey: "k", sleep: noSleep })
    assert.equal(await api.reportAttempt({ phase: "register", status: 500 }), false)
    assert.deepEqual(seen, [
      { path: "/api/v1/runs/attempts", body: { phase: "register", status: 500 } },
    ])
  } finally {
    await server.close()
  }
})
