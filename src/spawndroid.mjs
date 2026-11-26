#!/usr/bin/env node
/**
 * spawndroid — run Android tests on hosted devices.
 *
 * One artifact owns the journey: `init` writes the spec and workflow, `check`
 * names the walls, `run` executes the lifecycle. The step-by-step commands
 * (upload/start/wait/report) stay for pipelines that drive the API themselves.
 */

import { appendFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

import { createApi } from "./api.mjs"
import { collectChecks, planNotes } from "./check.mjs"
import {
  DEFAULT_TIMEOUT_SECONDS,
  SPEC_FILE,
  SpecError,
  loadSpec,
} from "./config.mjs"
import { runInit } from "./init.mjs"
import { EXIT_INFRA, EXIT_PASSED, executeRun, jobSummary, sessionEnv } from "./run.mjs"

const API_KEY = process.env.SPAWNDROID_API_KEY?.trim()
const API_URL = (
  process.env.SPAWNDROID_URL?.trim() || "https://app.spawndroid.io"
).replace(/\/$/, "")

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version

const HELP = `spawndroid — run Android tests on hosted devices

Usage:
  spawndroid init [--app <apk>] [--command <cmd>] [--report <xml>] [--profile <id>]
  spawndroid check [--config <path>]
  spawndroid run [--config <path>] [--profile <id>] [--timeout <seconds>]
                 [--wait-for-runner <seconds>] [-- <command…>]
  spawndroid upload <app.apk> [--json]
  spawndroid start --app <slug> [--profile <id>] [--json]
  spawndroid wait <sessionId> [--timeout <seconds>] [--json]
  spawndroid report <sessionId> --result passed|failed
  spawndroid --version

Environment:
  SPAWNDROID_API_KEY   workspace API key with upload scope (required)
  SPAWNDROID_URL       console origin (default https://app.spawndroid.io)
  SPAWNDROID_CONFIG    spec path (default spawndroid.yaml)
  SPAWNDROID_WAIT_FOR_RUNNER
                       seconds \`run\` waits for a busy runner to free up (default 0, off)

Exit codes:
  0 tests passed   1 tests failed   2 infrastructure or setup failed

Examples:
  npx spawndroid init
  npx spawndroid check
  npx spawndroid run
  npx spawndroid run app-debug.apk -- npx wdio run wdio.conf.js
`

function fail(message, code = EXIT_INFRA) {
  console.error(`spawndroid: ${message}`)
  return code
}

function api() {
  if (!API_KEY) {
    throw new SpecError([
      "SPAWNDROID_API_KEY is not set — create a key in API & CI/CD → API keys (upload scope)",
    ])
  }
  return createApi({
    baseUrl: API_URL,
    apiKey: API_KEY,
    userAgent: `spawndroid-cli/${VERSION}`,
  })
}

function specPathOf(values) {
  return resolve(values.config ?? process.env.SPAWNDROID_CONFIG ?? SPEC_FILE)
}

async function writeGitHubOutputs({ sessionId, result, runUrl }) {
  const file = process.env.GITHUB_OUTPUT
  if (!file || !sessionId) return
  const lines = [`session-id=${sessionId}`, `result=${result}`]
  if (runUrl) lines.push(`run-url=${runUrl}`)
  await appendFile(file, `${lines.join("\n")}\n`)
}

async function writeJobSummary(outcome) {
  const file = process.env.GITHUB_STEP_SUMMARY
  const summary = jobSummary(outcome)
  if (file && summary) await appendFile(file, summary)
}

function parseSafe(argv, options) {
  try {
    return {
      ok: true,
      value: parseArgs({ args: argv, allowPositionals: true, options }),
    }
  } catch (error) {
    return { ok: false, error }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const [command] = argv

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP)
    return EXIT_PASSED
  }
  if (command === "--version" || command === "-v") {
    console.log(`spawndroid ${VERSION}`)
    return EXIT_PASSED
  }

  if (command === "init") {
    const parsed = parseSafe(argv.slice(1), {
      config: { type: "string" },
      app: { type: "string" },
      command: { type: "string" },
      report: { type: "string" },
      profile: { type: "string" },
      timeout: { type: "string" },
      force: { type: "boolean", default: false },
      "no-workflow": { type: "boolean", default: false },
    })
    if (!parsed.ok) return fail(parsed.error.message)
    const { values } = parsed.value
    const configPath = specPathOf(values)
    return runInit({
      dir: dirname(configPath),
      configPath,
      flags: {
        app: values.app,
        command: values.command,
        report: values.report,
        profile: values.profile,
        timeout: values.timeout,
        force: values.force,
        workflow: !values["no-workflow"],
      },
      version: VERSION,
    })
  }

  if (command === "check") {
    const parsed = parseSafe(argv.slice(1), { config: { type: "string" } })
    if (!parsed.ok) return fail(parsed.error.message)
    const specPath = specPathOf(parsed.value.values)
    const spec = loadSpec(specPath)
    if (!API_KEY) {
      console.error(
        "spawndroid: SPAWNDROID_API_KEY is not set — create a key in API & CI/CD → API keys (upload scope)"
      )
      return EXIT_INFRA
    }
    const { problems, warnings } = await collectChecks({
      spec,
      specDir: dirname(specPath),
      api: api(),
    })
    for (const warning of warnings) console.error(`warning: ${warning}`)
    if (problems.length) {
      for (const problem of problems) console.error(`problem: ${problem}`)
      return EXIT_INFRA
    }
    for (const line of planNotes()) console.error(line)
    console.log("ok")
    return EXIT_PASSED
  }

  if (command === "run") {
    const rest = argv.slice(1)
    const separator = rest.indexOf("--")
    const head = separator >= 0 ? rest.slice(0, separator) : rest
    const commandArgs = separator >= 0 ? rest.slice(separator + 1) : []
    const parsed = parseSafe(head, {
      config: { type: "string" },
      profile: { type: "string" },
      timeout: { type: "string" },
      "wait-for-runner": { type: "string" },
    })
    if (!parsed.ok) return fail(parsed.error.message)
    const { values, positionals } = parsed.value
    const waitForRunner =
      values["wait-for-runner"] ?? process.env.SPAWNDROID_WAIT_FOR_RUNNER?.trim() ?? ""
    const waitForRunnerSeconds = waitForRunner === "" ? 0 : Number(waitForRunner)
    if (!Number.isInteger(waitForRunnerSeconds) || waitForRunnerSeconds < 0) {
      return fail("--wait-for-runner must be whole seconds, 0 or more")
    }

    let spec
    let specDir
    if (positionals.length > 0) {
      const timeout = values.timeout ? Number(values.timeout) : DEFAULT_TIMEOUT_SECONDS
      spec = {
        version: 1,
        app: positionals[0],
        profile: values.profile ?? null,
        command: commandArgs,
        fixtures: [],
        report: null,
        timeout,
      }
      specDir = process.cwd()
      if (commandArgs.length === 0) {
        return fail("run <app.apk> requires a command after --")
      }
    } else {
      const specPath = specPathOf(values)
      spec = loadSpec(specPath)
      specDir = dirname(specPath)
      if (values.profile) spec.profile = values.profile
      if (values.timeout) spec.timeout = Number(values.timeout)
      if (commandArgs.length > 0) spec.command = commandArgs
    }

    const outcome = await executeRun({ spec, specDir, api: api(), waitForRunnerSeconds })
    await writeGitHubOutputs(outcome)
    await writeJobSummary(outcome)
    if (outcome.runUrl) console.error(`run: ${outcome.runUrl}`)
    return outcome.exitCode
  }

  if (command === "upload") {
    const parsed = parseSafe(argv.slice(1), {
      json: { type: "boolean", default: false },
    })
    if (!parsed.ok) return fail(parsed.error.message)
    const { values, positionals } = parsed.value
    if (!positionals[0]) return fail("upload requires an APK path")
    const app = await api().uploadApk(positionals[0])
    console.log(values.json ? JSON.stringify(app, null, 2) : app?.slug)
    return EXIT_PASSED
  }

  if (command === "start") {
    const parsed = parseSafe(argv.slice(1), {
      app: { type: "string" },
      profile: { type: "string" },
      json: { type: "boolean", default: false },
    })
    if (!parsed.ok) return fail(parsed.error.message)
    const { values } = parsed.value
    if (!values.app) return fail("start requires --app <slug>")
    const view = await api().createSession(
      {
        artifactId: values.app,
        ...(values.profile ? { profileId: values.profile } : {}),
      },
      `spawndroid-${randomUUID()}`
    )
    console.log(values.json ? JSON.stringify(view, null, 2) : view?.sessionId)
    return EXIT_PASSED
  }

  if (command === "wait") {
    const parsed = parseSafe(argv.slice(1), {
      timeout: { type: "string", default: "600" },
      json: { type: "boolean", default: false },
    })
    if (!parsed.ok) return fail(parsed.error.message)
    const { values, positionals } = parsed.value
    if (!positionals[0]) return fail("wait requires a session id")
    const sessionId = positionals[0]
    const client = api()
    const deadline = Date.now() + Number(values.timeout) * 1000
    for (;;) {
      const view = await client.getSession(sessionId)
      if (view?.state === "ready") {
        if (values.json) {
          console.log(JSON.stringify(view, null, 2))
        } else {
          // sessionEnv drops null/undefined values, so a readiness read that
          // omits the package cannot print "SPAWNDROID_APP_PACKAGE=undefined".
          const env = sessionEnv(view, view?.appSlug, sessionId)
          for (const [key, value] of Object.entries(env)) {
            console.log(`${key}=${value}`)
          }
        }
        return EXIT_PASSED
      }
      if (view?.state === "failed") {
        return fail(`session failed: ${view.errorCode ?? view.error ?? "unknown"}`)
      }
      if (Date.now() > deadline) {
        return fail(`timed out after ${values.timeout}s waiting for ${sessionId}`)
      }
      await new Promise((done) => setTimeout(done, 5000))
    }
  }

  if (command === "report") {
    const parsed = parseSafe(argv.slice(1), { result: { type: "string" } })
    if (!parsed.ok) return fail(parsed.error.message)
    const { values, positionals } = parsed.value
    if (!positionals[0]) return fail("report requires a session id")
    if (values.result !== "passed" && values.result !== "failed") {
      return fail("report requires --result passed|failed")
    }
    await api().endSession(positionals[0], values.result)
    console.log(`reported ${values.result} for ${positionals[0]}`)
    return EXIT_PASSED
  }

  return fail(`unknown command: ${command}\n\n${HELP}`)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    if (error instanceof SpecError) {
      for (const problem of error.problems) console.error(`spawndroid: ${problem}`)
    } else {
      console.error(`spawndroid: ${error?.message ?? error}`)
    }
    process.exitCode = EXIT_INFRA
  })
