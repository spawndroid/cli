import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApi } from "../src/api.mjs";
import {
  ciCoords,
  executeRun,
  jobSummary,
  pullRequestUpload,
  runnerLimitMessage,
} from "../src/run.mjs";

/**
 * A fake console: enough of the v1 shape that executeRun's real HTTP client
 * talks to it unmodified.
 */
async function startConsole({
  createFailures = 0,
  createCode = "free_pool_full",
  createStatus = 429,
  createBody = {},
  readyFailures = 0,
  readyPackage = "com.example",
  workspace = null,
} = {}) {
  const state = {
    creates: [],
    ends: [],
    reports: [],
    presigns: [],
    puts: [],
    commits: [],
    gets: 0,
    readyAfter: 1,
    events: [],
    createFailures,
    createCode,
    createStatus,
    readyFailures,
    readyPackage,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const json = () => {
      try {
        return JSON.parse(raw.toString("utf8"));
      } catch {
        return null;
      }
    };
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.method === "GET" && url.pathname === "/api/v1/whoami") {
      if (!workspace) return send(404, { error: "not found" });
      return send(200, { tenantId: "org_1", scope: "upload", workspace });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
      state.events.push("create");
      state.creates.push({
        body: json(),
        key: request.headers["idempotency-key"],
      });
      if (state.creates.length <= state.createFailures) {
        return send(state.createStatus, {
          code: state.createCode,
          detail: "not now",
          ...createBody,
        });
      }
      return send(201, {
        sessionId: "sess_1",
        state: "creating",
        webdriverUrl: "http://127.0.0.1:9/wd/hub",
        device: { serial: "emulator-5554" },
        app: { package: "com.example" },
      });
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/sessions/sess_1"
    ) {
      state.gets += 1;
      if (state.gets <= state.readyFailures) {
        return send(504, {
          code: "UPSTREAM_TIMEOUT",
          detail: "The device host timed out.",
        });
      }
      if (state.gets >= state.readyAfter) {
        return send(200, {
          sessionId: "sess_1",
          state: "ready",
          webdriverUrl: "http://127.0.0.1:9/wd/hub",
          device: { serial: "emulator-5554" },
          package: state.readyPackage,
        });
      }
      return send(200, { sessionId: "sess_1", state: "booting" });
    }
    if (
      request.method === "DELETE" &&
      url.pathname === "/api/v1/sessions/sess_1"
    ) {
      state.events.push("end");
      state.ends.push(json());
      return send(200, { ok: true });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess_1/files/presign"
    ) {
      state.presigns.push(json());
      return send(200, {
        key: "tenant/session/fixture.bin",
        url: `${state.root}/upload/fixture.bin`,
        contentType: "application/octet-stream",
      });
    }
    if (request.method === "PUT" && url.pathname === "/upload/fixture.bin") {
      state.puts.push(raw.length);
      return send(200, {});
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess_1/files"
    ) {
      state.commits.push(json());
      return send(200, { ok: true });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess_1/report"
    ) {
      state.events.push("report");
      state.reports.push(raw.toString("utf8"));
      return send(201, { ok: true, report: {} });
    }
    return send(404, { code: "NOT_FOUND" });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  state.root = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((done) => server.close(done));
  return state;
}

function baseSpec(overrides = {}) {
  return {
    version: 1,
    app: "checkout",
    profile: null,
    command: [process.execPath, "-e", "process.exit(0)"],
    fixtures: [],
    report: null,
    timeout: 5,
    ...overrides,
  };
}

const quiet = () => {};
const fast = { pollMs: 5, retryDelayMs: 5 };

test("the readiness view's package reaches the command's environment", async () => {
  const consoleState = await startConsole();
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-env-"));
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec({
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('env.txt', process.env.SPAWNDROID_APP_PACKAGE ?? '')",
        ],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(readFileSync(join(dir, "env.txt"), "utf8"), "com.example");
  } finally {
    await consoleState.close();
  }
});

test("falls back to the create response when readiness omits the package", async () => {
  const consoleState = await startConsole({ readyPackage: null });
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-env-"));
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec({
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('env.txt', process.env.SPAWNDROID_APP_PACKAGE ?? '')",
        ],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(readFileSync(join(dir, "env.txt"), "utf8"), "com.example");
  } finally {
    await consoleState.close();
  }
});

/** The real environment (PATH and friends) minus GitHub's run coordinates. */
function withoutGithubEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_")),
  );
}

test("green command: passes the run, tears down and attaches JUnit", async () => {
  const consoleState = await startConsole();
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-run-"));
  writeFileSync(join(dir, "junit.xml"), "<testsuite/>");
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec({ report: "junit.xml" }),
      specDir: dir,
      api,
      log: quiet,
      // On a GitHub runner the start body would also carry the runner's own
      // commit, branch and repo; this test asserts the body without them.
      env: withoutGithubEnv(),
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result, "passed");
    assert.deepEqual(consoleState.ends, [
      { result: "passed", command: { stage: "command", exitCode: 0, signal: null, lastErrorLine: null } },
    ]);
    assert.equal(consoleState.reports.length, 1);
    // The report lands while the session is open, then the device is released.
    assert.deepEqual(consoleState.events, ["create", "report", "end"]);
    assert.deepEqual(consoleState.creates[0].body, { artifactId: "checkout" });
    assert.match(consoleState.creates[0].key, /^spawndroid-/);
  } finally {
    await consoleState.close();
  }
});

test("without a report setting, the Gradle reports the command wrote are attached", async () => {
  const consoleState = await startConsole()
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-gradle-"))
  // Two test classes, as Gradle writes them: one file each.
  const write = [
    "const fs = require('node:fs')",
    "fs.mkdirSync('build/test-results/test', { recursive: true })",
    "fs.writeFileSync('build/test-results/test/TEST-A.xml', '<?xml version=\"1.0\"?><testsuite name=\"A\"><testcase name=\"a\"/></testsuite>')",
    "fs.writeFileSync('build/test-results/test/TEST-B.xml', '<?xml version=\"1.0\"?><testsuite name=\"B\"><testcase name=\"b\"><failure message=\"x\"/></testcase></testsuite>')",
    "process.exit(1)",
  ].join(";")
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 })
    const outcome = await executeRun({
      spec: baseSpec({ command: [process.execPath, "-e", write] }),
      specDir: dir,
      api,
      log: quiet,
      env: withoutGithubEnv(),
      ...fast,
    })
    assert.equal(outcome.exitCode, 1)
    assert.equal(consoleState.reports.length, 1)
    const xml = consoleState.reports[0]
    assert.equal((xml.match(/<testcase\b/g) ?? []).length, 2)
    assert.equal((xml.match(/<\?xml/g) ?? []).length, 1)
    // Attached before the device is released.
    assert.deepEqual(consoleState.events, ["create", "report", "end"])
  } finally {
    await consoleState.close()
  }
})

test("failing command: exit 1 and a failed verdict", async () => {
  const consoleState = await startConsole();
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec({ command: [process.execPath, "-e", "process.exit(3)"] }),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(consoleState.ends, [
      {
        result: "failed",
        command: { stage: "command", exitCode: 3, signal: null, lastErrorLine: null },
      },
    ]);
  } finally {
    await consoleState.close();
  }
});

test("a transient start failure is retried with the same key", async () => {
  const consoleState = await startConsole({
    createFailures: 1,
    createStatus: 504,
    createCode: "UPSTREAM_TIMEOUT",
  });
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(consoleState.creates.length, 2);
    assert.equal(consoleState.creates[0].key, consoleState.creates[1].key);
  } finally {
    await consoleState.close();
  }
});

test("a transient readiness failure is retried until the deadline", async () => {
  const consoleState = await startConsole({ readyFailures: 2 });
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result, "passed");
  } finally {
    await consoleState.close();
  }
});

test("plan limits are not retried", async () => {
  const consoleState = await startConsole({
    createFailures: 1,
    createCode: "PLAN_RUNNER_LIMIT",
  });
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 2);
    assert.equal(consoleState.creates.length, 1);
  } finally {
    await consoleState.close();
  }
});

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

const RUNNER_LIMIT = {
  createCode: "PLAN_RUNNER_LIMIT",
  createBody: {
    legacyCode: "concurrency",
    limit: 1,
    active: 1,
    retryAfterMs: 120_000,
    holders: [
      {
        sessionId: "sess_holder",
        startedFrom: "ci",
        build: { app: "Trail", appSlug: "trail", versionCode: 42 },
        startedAt: "2026-11-26T11:48:00.000Z",
        runningSeconds: 720,
        stopsBy: "2026-11-26T19:48:00.000Z",
        stopsByReason: "host_ceiling",
        idleTimeoutSeconds: 900,
      },
    ],
  },
};

test("a runner-limit message names the holder, when it frees and both options", () => {
  const lines = runnerLimitMessage(RUNNER_LIMIT.createBody, {
    baseUrl: "https://app.example",
    now: NOW,
  });
  assert.deepEqual(lines, [
    "runner limit reached: 1 of 1 runners busy",
    "  held by sess_holder: Trail build 42, started from CI, running 12m, frees in 7h 48m at the latest, sooner if idle for 15m",
    "  option 1, wait: rerun when it ends, or pass --wait-for-runner <seconds> (SPAWNDROID_WAIT_FOR_RUNNER) to retry automatically",
    "  option 2, stop it: npx spawndroid report sess_holder --result failed, or Stop on https://app.example/dashboard/runs/sess_holder",
  ]);
});

test("a runner-limit message from an older server still offers the options", () => {
  const lines = runnerLimitMessage(
    { code: "PLAN_RUNNER_LIMIT" },
    { baseUrl: "https://app.example", now: NOW },
  );
  assert.equal(lines[0], "runner limit reached: every runner in this workspace is busy");
  assert.equal(lines.at(-1), "  option 2, stop a running session on https://app.example/dashboard/runs");
});

test("a runner limit fails at once by default and says who holds the runner", async () => {
  const consoleState = await startConsole({ createFailures: 1, ...RUNNER_LIMIT });
  const logs = [];
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: (line) => logs.push(line),
      now: () => NOW,
      ...fast,
    });
    assert.equal(outcome.exitCode, 2);
    assert.equal(consoleState.creates.length, 1);
    assert.ok(logs.some((line) => line.includes("held by sess_holder: Trail build 42")));
    assert.ok(logs.some((line) => line.includes("npx spawndroid report sess_holder --result failed")));
  } finally {
    await consoleState.close();
  }
});

test("--wait-for-runner retries a runner limit with a fresh key until it frees", async () => {
  const consoleState = await startConsole({ createFailures: 2, ...RUNNER_LIMIT });
  const sleeps = [];
  let clock = NOW;
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
      waitForRunnerSeconds: 600,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(consoleState.creates.length, 3);
    // A refused key is settled as failed on the server, so each retry needs a new one.
    assert.equal(new Set(consoleState.creates.map((create) => create.key)).size, 3);
    // Retry-After is two minutes, but a holder can end early: poll at most every 30s.
    assert.deepEqual(sleeps.slice(0, 2), [30_000, 30_000]);
  } finally {
    await consoleState.close();
  }
});

test("--wait-for-runner gives up when the budget runs out", async () => {
  const consoleState = await startConsole({ createFailures: 100, ...RUNNER_LIMIT });
  let clock = NOW;
  const logs = [];
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: (line) => logs.push(line),
      ...fast,
      waitForRunnerSeconds: 45,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    assert.equal(outcome.exitCode, 2);
    // 30s, then the 15s that is left, then one last refusal.
    assert.equal(consoleState.creates.length, 3);
    assert.ok(logs.some((line) => line.includes("no runner freed up within 45s")));
  } finally {
    await consoleState.close();
  }
});

test("capacity 429 is retried with the same idempotency key", async () => {
  const consoleState = await startConsole({ createFailures: 1 });
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(consoleState.creates.length, 2);
    assert.equal(consoleState.creates[0].key, consoleState.creates[1].key);
  } finally {
    await consoleState.close();
  }
});

test("fixtures are presigned, uploaded and committed", async () => {
  const consoleState = await startConsole();
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-fixtures-"));
  writeFileSync(join(dir, "fixture.bin"), Buffer.from("hello"));
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec({
        fixtures: [{ local: "fixture.bin", device: "/sdcard/Download" }],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(consoleState.presigns, [
      { filename: "fixture.bin", path: "/sdcard/Download", size: 5 },
    ]);
    assert.deepEqual(consoleState.puts, [5]);
    assert.deepEqual(consoleState.commits, [
      {
        key: "tenant/session/fixture.bin",
        path: "/sdcard/Download",
        filename: "fixture.bin",
      },
    ]);
  } finally {
    await consoleState.close();
  }
});

test("a device that never becomes ready is an infrastructure failure", async () => {
  const consoleState = await startConsole();
  consoleState.readyAfter = 1_000;
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec({ timeout: 0 }),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 2);
    assert.deepEqual(consoleState.ends, [
      {
        result: "failed",
        command: {
          stage: "device",
          exitCode: null,
          signal: null,
          lastErrorLine: "timed out after 0s waiting for the device",
        },
      },
    ]);
  } finally {
    await consoleState.close();
  }
});

test("ciCoords reports the pull request head, not GitHub's merge commit", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sd-")), "event.json");
  writeFileSync(
    path,
    JSON.stringify({ pull_request: { head: { sha: "b".repeat(40) } } }),
  );
  const env = {
    GITHUB_SHA: "m".repeat(40),
    GITHUB_EVENT_PATH: path,
    GITHUB_REPOSITORY: "acme/shop",
  };
  assert.equal(ciCoords(env).commit, "b".repeat(40));
  assert.equal(ciCoords({ GITHUB_SHA: "c".repeat(40) }).commit, "c".repeat(40));
});

test("pullRequestUpload names the PR a build comes from, only on pull_request runs", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sd-")), "event.json");
  writeFileSync(
    path,
    JSON.stringify({ pull_request: { number: 42, head: { sha: "b".repeat(40) } } }),
  );
  assert.deepEqual(
    pullRequestUpload({ GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: "acme/shop" }),
    { repository: "acme/shop", pullNumber: 42, headSha: "b".repeat(40) },
  );
  assert.equal(pullRequestUpload({ GITHUB_REPOSITORY: "acme/shop" }), null);
});

test("names the workspace the run lands in before it starts", async () => {
  const consoleState = await startConsole({
    workspace: { name: "Acme", slug: "acme" },
  });
  const lines = [];
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: (line) => lines.push(line),
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.workspace, { name: "Acme", slug: "acme" });
    const named = lines.findIndex((line) => line.startsWith("workspace Acme"));
    const session = lines.findIndex((line) => line.startsWith("session "));
    assert.ok(named >= 0, lines.join("\n"));
    assert.ok(named < session, "the workspace is named before the session");
  } finally {
    await consoleState.close();
  }
});

test("a console without whoami still runs, without naming a workspace", async () => {
  const consoleState = await startConsole();
  const lines = [];
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: (line) => lines.push(line),
      ...fast,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.workspace, null);
    assert.ok(!lines.some((line) => line.startsWith("workspace ")));
  } finally {
    await consoleState.close();
  }
});

test("the job summary names the result, the workspace and the run link", () => {
  const md = jobSummary({
    result: "passed",
    runUrl: "https://app.spawndroid.io/dashboard/runs/sess_1",
    workspace: { name: "Acme", slug: "acme" },
  });
  assert.match(md, /Passed/);
  assert.match(md, /Acme/);
  assert.match(md, /\(https:\/\/app\.spawndroid\.io\/dashboard\/runs\/sess_1\)/);
});

test("no summary without a run, and no workspace line when unknown", () => {
  assert.equal(jobSummary({ result: "failed", runUrl: null, workspace: null }), null);
  const md = jobSummary({ result: "failed", runUrl: "https://x/dashboard/runs/s", workspace: null });
  assert.match(md, /Failed/);
  assert.doesNotMatch(md, /Workspace/);
});

test("without a JUnit report, the runner's closing count goes with the result", async () => {
  const consoleState = await startConsole();
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-summary-"));
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" });
    const outcome = await executeRun({
      spec: baseSpec({
        command: [
          process.execPath,
          "-e",
          "console.log('FAILED tests/test_login.py::test_login - AssertionError'); console.log('==== 1 failed, 4 passed in 3.10s ===='); process.exit(1)",
        ],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    });
    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(consoleState.ends.at(-1), {
      result: "failed",
      summary: {
        runner: "pytest",
        passed: 4,
        failed: 1,
        skipped: 0,
        failing: ["tests/test_login.py::test_login"],
      },
      command: {
        stage: "command",
        exitCode: 1,
        signal: null,
        lastErrorLine: "FAILED tests/test_login.py::test_login - AssertionError",
      },
    });
  } finally {
    await consoleState.close();
  }
});

test("a command with no recognisable summary ends with the result alone", async () => {
  const consoleState = await startConsole();
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-summary-"));
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" });
    await executeRun({
      spec: baseSpec({
        command: [process.execPath, "-e", "console.log('all good')"],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    });
    assert.deepEqual(consoleState.ends.at(-1), {
      result: "passed",
      command: { stage: "command", exitCode: 0, signal: null, lastErrorLine: null },
    });
  } finally {
    await consoleState.close();
  }
});

test("a failing command sends its exit code and the last error it printed", async () => {
  const consoleState = await startConsole();
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    await executeRun({
      spec: baseSpec({
        command: [
          process.execPath,
          "-e",
          "console.error('NoSuchElementError: element (~login) not found'); console.error('npm ERR! Test failed.'); process.exit(2)",
        ],
      }),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    assert.deepEqual(consoleState.ends.at(-1).command, {
      stage: "command",
      exitCode: 2,
      signal: null,
      lastErrorLine: "NoSuchElementError: element (~login) not found",
    });
  } finally {
    await consoleState.close();
  }
});

test("a command that cannot start says so", async () => {
  const consoleState = await startConsole();
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test", serverErrorRetryMs: 0 });
    await executeRun({
      spec: baseSpec({ command: ["/nonexistent/spawndroid-test-binary"] }),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    });
    const { command } = consoleState.ends.at(-1);
    assert.equal(command.stage, "command");
    assert.equal(command.exitCode, null);
    assert.match(command.lastErrorLine, /could not start the test command/);
  } finally {
    await consoleState.close();
  }
});

/** An API whose calls are scripted per test; records attempts and ends. */
function stubApi(overrides = {}) {
  const calls = { attempts: [], ends: [] };
  return {
    calls,
    api: {
      baseUrl: "http://console.test",
      workspace: async () => null,
      reportAttempt: async (attempt) => {
        calls.attempts.push(attempt);
        return true;
      },
      endSession: async (id, result) => {
        calls.ends.push({ id, result });
      },
      ...overrides,
    },
  };
}

function apiError(status, extra) {
  return Object.assign(new Error(`${status} boom`), { status, ...extra });
}

test("an upload that fails before a session is reported, with its request id logged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-attempt-"));
  writeFileSync(join(dir, "wire.apk"), Buffer.alloc(8, 1));
  const lines = [];
  const { api, calls } = stubApi({
    uploadApk: async () => {
      throw apiError(500, {
        code: "INTERNAL",
        requestId: "req_828daf7756ba4e3480a1",
        attemptPhase: "register",
      });
    },
  });
  const outcome = await executeRun({
    spec: baseSpec({ app: "wire.apk" }),
    specDir: dir,
    api,
    env: { GITHUB_SHA: "2554a04b1f0e", GITHUB_REF_NAME: "main" },
    log: (line) => lines.push(line),
    ...fast,
  });
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.sessionId, null);
  assert.ok(lines.includes("request id: req_828daf7756ba4e3480a1"));
  assert.deepEqual(calls.attempts, [
    {
      phase: "register",
      status: 500,
      code: "INTERNAL",
      requestId: "req_828daf7756ba4e3480a1",
      build: "wire.apk",
      commit: "2554a04b1f0e",
      branch: "main",
    },
  ]);
});

test("a start that cannot get a session is reported as the start phase", async () => {
  const { api, calls } = stubApi({
    createSession: async () => {
      throw apiError(503, { code: "UPSTREAM_UNAVAILABLE", requestId: "req_2" });
    },
  });
  const outcome = await executeRun({
    spec: baseSpec(),
    specDir: tmpdir(),
    api,
    env: {},
    log: quiet,
    ...fast,
    maxAttempts: 2,
  });
  assert.equal(outcome.exitCode, 2);
  assert.equal(calls.attempts.length, 1);
  assert.equal(calls.attempts[0].phase, "start");
  assert.equal(calls.attempts[0].requestId, "req_2");
});

test("a failure after the session exists is not reported as an attempt", async () => {
  const { api, calls } = stubApi({
    createSession: async () => ({ sessionId: "sess_9" }),
    getSession: async () => ({ state: "failed", errorCode: "DEVICE_BOOT_TIMEOUT" }),
  });
  const outcome = await executeRun({
    spec: baseSpec(),
    specDir: tmpdir(),
    api,
    env: {},
    log: quiet,
    ...fast,
  });
  assert.equal(outcome.exitCode, 2);
  assert.equal(calls.attempts.length, 0);
  assert.deepEqual(calls.ends, [{ id: "sess_9", result: "failed" }]);
});

test("an install failure names its cause and never reaches the test command", async () => {
  const lines = [];
  let spawned = false;
  const { api } = stubApi({
    createSession: async () => ({ sessionId: "sess_abi" }),
    getSession: async () => ({
      state: "failed",
      errorCode: "INSTALL_NO_MATCHING_ABI",
      errorPhase: "install",
      errorTitle: "Install failed: no arm64 libraries",
      error:
        "Spawndroid devices are arm64; this APK contains only other architectures.",
    }),
  });
  const outcome = await executeRun({
    spec: baseSpec(),
    specDir: tmpdir(),
    api,
    env: {},
    log: (line) => lines.push(line),
    ...fast,
    spawnImpl: () => {
      spawned = true;
      throw new Error("the test command must not run");
    },
  });
  assert.equal(outcome.exitCode, 2);
  assert.equal(spawned, false);
  const text = lines.join("\n");
  assert.match(text, /Install failed: no arm64 libraries/);
  assert.match(text, /only other architectures/);
  assert.match(text, /INSTALL_NO_MATCHING_ABI/);
});

test("the install hint checks minSdk and arm64, not debuggable", async () => {
  const { remediationFor } = await import("../src/run.mjs");
  const hint = remediationFor("INSTALL_FAILED_OTHER");
  assert.match(hint, /minSdk/);
  assert.match(hint, /arm64/);
  assert.doesNotMatch(hint, /debuggable/);
});
