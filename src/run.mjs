/**
 * The run lifecycle: upload → create → wait → fixtures → command → report.
 *
 * Every failure path funnels through one teardown so a device is never left
 * billing because the command threw. Exit codes are part of the contract:
 *   0 tests passed, 1 tests failed, 2 infrastructure or setup failed.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import { DEVICE_FILE_MAX_BYTES } from "./config.mjs";
import { collectReports, mergeJUnit } from "./reports.mjs";
import { lastErrorLine, outputTail, parseTestSummary } from "./summary.mjs";

export const EXIT_PASSED = 0;
export const EXIT_TESTS_FAILED = 1;
export const EXIT_INFRA = 2;

export class InfraError extends Error {
  constructor(
    message,
    {
      code = null,
      phase = null,
      hint = null,
      status = null,
      requestId = null,
      attemptPhase = null,
    } = {},
  ) {
    super(message);
    this.name = "InfraError";
    this.code = code;
    this.phase = phase;
    this.hint = hint;
    /** HTTP status of the API call that failed, when one did. */
    this.status = status;
    /** The console's id for that request, to quote to support. */
    this.requestId = requestId;
    /** upload | register | start: where a run without a session stopped. */
    this.attemptPhase = attemptPhase;
  }
}

/** The plan's parallel-runner limit: every runner is busy in this workspace. */
const RUNNER_LIMIT_CODES = new Set(["PLAN_RUNNER_LIMIT", "concurrency"]);

/** How often `--wait-for-runner` asks again, whatever Retry-After says. */
const RUNNER_POLL_MIN_MS = 5_000;
const RUNNER_POLL_MAX_MS = 30_000;

function isRunnerLimit(error) {
  return (
    error?.status === 429 &&
    (RUNNER_LIMIT_CODES.has(error.code) || RUNNER_LIMIT_CODES.has(error.legacyCode))
  );
}

/** `42s`, `12m`, `7h 36m`. */
function formatSeconds(total) {
  const seconds = Math.max(0, Math.round(total));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${Math.floor(minutes / 60)}h`;
}

const ORIGIN_LABEL = {
  ci: "CI",
  api: "the API",
  dashboard: "the dashboard",
  share_link: "a share link",
};

/**
 * What a runner-limit 429 means for this run, as lines a person can act on:
 * which session holds the runner, how long until it frees, and the two ways
 * out. Servers older than the `holders` field still get the options.
 */
export function runnerLimitMessage(body, { baseUrl, now = Date.now() } = {}) {
  const holders = Array.isArray(body?.holders) ? body.holders : [];
  const lines = [
    typeof body?.active === "number" && typeof body?.limit === "number"
      ? `runner limit reached: ${body.active} of ${body.limit} runners busy`
      : "runner limit reached: every runner in this workspace is busy",
  ];
  for (const holder of holders) {
    const build =
      holder.build?.versionCode != null
        ? `${holder.build.app} build ${holder.build.versionCode}`
        : (holder.build?.app ?? "unknown build");
    const freesIn = formatSeconds((Date.parse(holder.stopsBy) - now) / 1000);
    const idle = holder.idleTimeoutSeconds
      ? `, sooner if idle for ${formatSeconds(holder.idleTimeoutSeconds)}`
      : "";
    lines.push(
      `  held by ${holder.sessionId}: ${build}, started from ${ORIGIN_LABEL[holder.startedFrom] ?? holder.startedFrom}, running ${formatSeconds(holder.runningSeconds)}, frees in ${freesIn} at the latest${idle}`,
    );
  }
  const first = holders[0]?.sessionId;
  lines.push(
    "  option 1, wait: rerun when it ends, or pass --wait-for-runner <seconds> (SPAWNDROID_WAIT_FOR_RUNNER) to retry automatically",
    first
      ? `  option 2, stop it: npx spawndroid report ${first} --result failed, or Stop on ${baseUrl}/dashboard/runs/${first}`
      : `  option 2, stop a running session on ${baseUrl}/dashboard/runs`,
  );
  return lines;
}

/** 429s that are plan limits, not transient capacity: retrying cannot help. */
const PLAN_CODES = new Set([
  "PLAN_RUNNER_LIMIT",
  "PLAN_DEVICE_MINUTES_EXHAUSTED",
  "concurrency",
  "device-minutes",
]);

/**
 * A gateway or host hiccup, not a verdict. A device takes minutes to boot, so
 * one 502/503/504 while the control plane catches up must not fail the run.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** Transport failures (status 0) count as transient too. */
function isTransient(error) {
  return error?.status === 0 || TRANSIENT_STATUSES.has(error?.status);
}

export function remediationFor(code) {
  if (!code) return null;
  if (code.startsWith("INSTALL_") || code.startsWith("AAB_")) {
    return "the build failed to install — check minSdk, that it targets arm64, and that the APK is debuggable";
  }
  switch (code) {
    case "DEVICE_BOOT_TIMEOUT":
      return "the device did not boot in time — retry; if it repeats, the host is unhealthy";
    case "IMAGE_MISSING":
      return "the device image is missing on the host — retry later";
    case "BUILD_EXPIRED":
      return "the build expired (Hobby builds expire 7 days after upload) — upload it again";
    case "PLAN_DEVICE_MINUTES_EXHAUSTED":
    case "device-minutes":
      return "monthly device minutes are exhausted — upgrade or wait for the reset";
    case "PLAN_RUNNER_LIMIT":
    case "concurrency":
      return "the plan's runner limit is reached — wait for a running session to end";
    case "free_pool_full":
    case "ci_pool_full":
    case "paid_pool_empty":
    case "paid_pool_full":
    case "paid_pool_max":
    case "paid_pool_unavailable":
      return "no device capacity right now — retry shortly";
    case "DEVICE_NOT_READY":
      return "the device was not ready — fixtures are pushed only after readiness";
    default:
      return null;
  }
}

function toInfra(error) {
  if (error instanceof InfraError) return error;
  return new InfraError(error?.message ?? String(error), {
    code: error?.code ?? error?.legacyCode ?? null,
    status: typeof error?.status === "number" ? error.status : null,
    requestId: error?.requestId ?? null,
    attemptPhase: error?.attemptPhase ?? null,
  });
}

/**
 * A run that stopped before it had a session leaves no run in the console.
 * Report it (identifiers only) so the Runs page can show it; best effort.
 */
async function reportFailedAttempt({ api, infra, spec, env }) {
  if (!infra.attemptPhase || !api.reportAttempt) return;
  await api.reportAttempt({
    phase: infra.attemptPhase,
    status: infra.status,
    code: infra.code,
    requestId: infra.requestId,
    build: basename(spec.app),
    ...ciCoords(env),
  });
}

/**
 * The commit a pull request tests. On `pull_request` events GITHUB_SHA is
 * GitHub's temporary merge commit, which matches no commit on the branch, so
 * checks and comparisons would attach to nothing.
 */
function pullRequestEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    return event.pull_request ?? null;
  } catch {
    return null;
  }
}

function pullRequestHead(env) {
  return pullRequestEvent(env)?.head?.sha ?? null;
}

/**
 * The pull request an uploaded build comes from. The console keeps such a
 * build as that PR's own build (for its runs and preview link) instead of a
 * new release of the app.
 */
export function pullRequestUpload(env) {
  const pull = pullRequestEvent(env);
  if (!pull?.number || !pull.head?.sha || !env.GITHUB_REPOSITORY) return null;
  return {
    repository: env.GITHUB_REPOSITORY,
    pullNumber: pull.number,
    headSha: pull.head.sha,
  };
}

/** Commit, branch and repo link, when the runner is GitHub Actions. */
export function ciCoords(env) {
  const coords = {};
  const commit = pullRequestHead(env) ?? env.GITHUB_SHA;
  if (commit) coords.commit = commit;
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (branch) coords.branch = branch;
  if (env.GITHUB_REPOSITORY) {
    const server = env.GITHUB_SERVER_URL || "https://github.com";
    coords.repoUrl = `${server}/${env.GITHUB_REPOSITORY}`;
  }
  return coords;
}

export function sessionEnv(view, appSlug, sessionId, createView) {
  // The create response nests the package under `app`; the readiness read
  // returns it at the top level — but for CI sessions the host never records
  // it, so `package` there is null. Fall back to what the create call returned.
  const pkg =
    view.app?.package ?? view.package ?? createView?.app?.package ?? null;
  // spawn() would render a null value as the string "null", which is exactly
  // how Appium ends up resolving a launchable activity for the package "null".
  return Object.fromEntries(
    Object.entries({
      SPAWNDROID_WD_URL: view.webdriverUrl,
      SPAWNDROID_UDID: view.device?.serial,
      SPAWNDROID_APP_PACKAGE: pkg,
      SPAWNDROID_APP: appSlug,
      SPAWNDROID_SESSION_ID: sessionId,
    }).filter(([, value]) => value != null),
  );
}

/**
 * Markdown for the GitHub job summary: the verdict, where the run landed and
 * a link to it, so a green job can never point at an empty dashboard
 * unnoticed. Null when no session started.
 */
export function jobSummary({ result, runUrl, workspace }) {
  if (!runUrl) return null;
  const verdict = result === "passed" ? "✅ Passed" : "❌ Failed";
  const lines = ["### Spawndroid", "", `**${verdict}** · [Open the run](${runUrl})`];
  if (workspace) lines.push("", `Workspace: **${workspace.name}** (\`${workspace.slug}\`)`);
  return `${lines.join("\n")}\n`;
}

export async function executeRun({
  spec,
  specDir,
  api,
  env = process.env,
  log = (...args) => console.error(...args),
  pollMs = 5000,
  retryDelayMs = 45_000,
  maxAttempts = 3,
  /** Wait this long for a busy runner to free up; 0 fails at once. */
  waitForRunnerSeconds = 0,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = () => Date.now(),
  spawnImpl = spawn,
}) {
  let sessionId = null;
  let workspace = null;
  let ended = false;
  // Which step a failure after the session exists stopped at, for the run
  // page's explanation: waiting for the device, pushing fixtures, or the
  // test command itself.
  let stage = "device";
  const childRef = { current: null };
  const runUrl = (id) => (id ? `${api.baseUrl}/dashboard/runs/${id}` : null);

  const teardown = async (result, extra = {}) => {
    if (!sessionId || ended) return;
    ended = true;
    try {
      await api.endSession(sessionId, result, extra);
    } catch (error) {
      log(`warning: could not close session ${sessionId}: ${error.message}`);
    }
  };

  const forward = (signal) => {
    if (childRef.current) childRef.current.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    // Name the destination first: a key made in another workspace uploads
    // and runs there, and a green job with an empty dashboard is otherwise
    // the only sign.
    workspace = (await api.workspace?.()) ?? null;
    if (workspace) {
      log(`workspace ${workspace.name} (${workspace.slug}) — ${api.baseUrl}/dashboard/runs`);
    }
    const app = await resolveApp({ spec, specDir, api, log, env });
    const fields = {
      artifactId: app.artifactId,
      ...(spec.profile ? { profileId: spec.profile } : {}),
      ...ciCoords(env),
    };

    const started = await createWithCapacityRetry({
      api,
      fields,
      maxAttempts,
      retryDelayMs,
      waitForRunnerSeconds,
      sleep,
      now,
      log,
    }).catch((error) => {
      const infra = toInfra(error);
      infra.attemptPhase ??= "start";
      throw infra;
    });
    sessionId = started?.sessionId ?? null;
    if (!sessionId) throw new InfraError("the API did not return a session id");
    log(`session ${sessionId}`);
    if (started?.webdriverUrl) log(`device pending — ${started.webdriverUrl}`);

    const view = await waitForReady({
      api,
      sessionId,
      timeoutSeconds: spec.timeout,
      pollMs,
      sleep,
      log,
    });

    stage = "fixtures";
    await pushFixtures({
      api,
      sessionId,
      fixtures: spec.fixtures,
      specDir,
      log,
    });

    // Reports written from here on belong to this run; older ones are stale.
    stage = "command";
    const commandStartedAt = Date.now()
    const { code, signal, spawnError, spawnMessage, output } = await runCommand({
      view,
      createView: started,
      appSlug: app.slug,
      sessionId,
      argv: spec.command,
      env,
      cwd: specDir,
      spawnImpl,
      log,
      childRef,
    });

    if (spawnError || signal) {
      const why = spawnError
        ? "the test command could not start"
        : `the test command was interrupted (${signal})`;
      await teardown("failed", {
        command: {
          stage: "command",
          exitCode: null,
          signal: signal ?? null,
          lastErrorLine: spawnError ? spawnMessage : lastErrorLine(output),
        },
      });
      log(`error: ${why}`);
      return {
        exitCode: EXIT_INFRA,
        sessionId,
        result: "failed",
        runUrl: runUrl(sessionId),
        workspace,
      };
    }

    const result = code === 0 ? "passed" : "failed";
    // Attach before teardown: the report route accepts a POST after the run
    // ends, but a report that lands while the session is still open cannot
    // race a teardown, and a failure here is a warning, never a lost verdict.
    const attached = await attachReport({
      api,
      sessionId,
      report: spec.report,
      specDir,
      since: commandStartedAt,
      log,
    });
    // No JUnit report: the runner's own closing count still says how many
    // checks passed and which failed, so the run page is not just a verdict.
    const summary = attached ? null : parseTestSummary(output);
    if (summary) {
      log(
        `summary from ${summary.runner} output: ${summary.passed} passed, ${summary.failed} failed`,
      );
    }
    await teardown(result, {
      ...(summary ? { summary } : {}),
      command: {
        stage: "command",
        exitCode: code,
        signal: null,
        lastErrorLine: code === 0 ? null : lastErrorLine(output),
      },
    });
    return {
      exitCode: code === 0 ? EXIT_PASSED : EXIT_TESTS_FAILED,
      sessionId,
      result,
      runUrl: runUrl(sessionId),
        workspace,
    };
  } catch (error) {
    const infra = toInfra(error);
    const hint = infra.hint ?? remediationFor(infra.code);
    log(`error: ${infra.message}`);
    if (infra.code) {
      log(`code: ${infra.code}${infra.phase ? ` (phase ${infra.phase})` : ""}`);
    }
    if (hint) log(`hint: ${hint}`);
    if (infra.requestId) log(`request id: ${infra.requestId}`);
    if (!sessionId) await reportFailedAttempt({ api, infra, spec, env });
    await teardown("failed", {
      command: {
        stage,
        exitCode: null,
        signal: null,
        lastErrorLine: infra.message.slice(0, 300),
      },
    });
    return {
      exitCode: EXIT_INFRA,
      sessionId,
      result: "failed",
      runUrl: runUrl(sessionId),
        workspace,
    };
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

async function resolveApp({ spec, specDir, api, log, env }) {
  const candidate = resolve(specDir, spec.app);
  let isFile = false;
  try {
    isFile = (await stat(candidate)).isFile();
  } catch {
    isFile = false;
  }
  const looksLikePath = /\.apk$/i.test(spec.app) || spec.app.includes("/");
  if (isFile) {
    const uploaded = await api.uploadApk(candidate, pullRequestUpload(env));
    if (!uploaded?.slug) {
      throw new InfraError("the upload response did not include an app slug");
    }
    log(
      `uploaded ${uploaded.slug}${uploaded.version ? ` v${uploaded.version}` : ""}`,
    );
    return { artifactId: uploaded.slug, slug: uploaded.slug };
  }
  if (looksLikePath) {
    throw new InfraError(`APK not found: ${candidate}`, {
      hint: "build the app before running tests",
    });
  }
  return { artifactId: spec.app, slug: spec.app };
}

async function createWithCapacityRetry({
  api,
  fields,
  maxAttempts,
  retryDelayMs,
  waitForRunnerSeconds,
  sleep,
  now,
  log,
}) {
  // A capacity retry reuses the key (nothing was created); a runner-limit
  // refusal settles the key as failed, so waiting for a runner needs a new one.
  let idempotencyKey = `spawndroid-${randomUUID()}`;
  const runnerDeadline = now() + waitForRunnerSeconds * 1000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.createSession(fields, idempotencyKey);
    } catch (error) {
      if (isRunnerLimit(error)) {
        for (const line of runnerLimitMessage(error.body, { baseUrl: api.baseUrl, now: now() })) {
          log(line);
        }
        const left = runnerDeadline - now();
        if (left <= 0) {
          throw new InfraError(
            waitForRunnerSeconds > 0
              ? `no runner freed up within ${waitForRunnerSeconds}s: ${error.message}`
              : error.message,
            {
              code: error.code ?? error.legacyCode ?? null,
              status: error.status,
              requestId: error.requestId ?? null,
              hint: "wait for the session above to end, or stop it",
            },
          );
        }
        const delay = Math.min(
          left,
          Math.max(
            RUNNER_POLL_MIN_MS,
            Math.min(Number(error.body?.retryAfterMs) || RUNNER_POLL_MAX_MS, RUNNER_POLL_MAX_MS),
          ),
        );
        log(`waiting for a runner: retrying in ${formatSeconds(delay / 1000)} (${formatSeconds(left / 1000)} left)`);
        await sleep(delay);
        idempotencyKey = `spawndroid-${randomUUID()}`;
        attempt -= 1;
        continue;
      }
      const planLimit =
        error?.status === 429 &&
        (PLAN_CODES.has(error.code) || PLAN_CODES.has(error.legacyCode));
      const retryable =
        !planLimit && (error?.status === 429 || isTransient(error));
      if (!retryable) throw toInfra(error);
      if (attempt >= maxAttempts) {
        throw new InfraError(
          `${maxAttempts} attempts failed: ${error.message}`,
          {
            code: error.code ?? error.legacyCode ?? null,
            status: typeof error.status === "number" ? error.status : null,
            requestId: error.requestId ?? null,
          },
        );
      }
      log(
        `start did not go through (${error.code ?? error.status}); attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(
          retryDelayMs / 1000,
        )}s`,
      );
      await sleep(retryDelayMs);
    }
  }
}

async function waitForReady({
  api,
  sessionId,
  timeoutSeconds,
  pollMs,
  sleep,
  log,
}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let warned = false;
  for (;;) {
    if (Date.now() > deadline) {
      throw new InfraError(
        `timed out after ${timeoutSeconds}s waiting for the device`,
        {
          hint: "run `spawndroid check`; if the host is slow, raise the spec's timeout",
        },
      );
    }
    let view;
    try {
      view = await api.getSession(sessionId);
    } catch (error) {
      if (isTransient(error)) {
        if (!warned) {
          log(
            `the host is not answering yet (${error.status || "network"}); still waiting`,
          );
          warned = true;
        }
        await sleep(pollMs);
        continue;
      }
      throw toInfra(error);
    }
    if (view?.state === "ready") return view;
    if (view?.state === "failed") {
      throw new InfraError(
        `session failed: ${view.errorCode ?? view.error ?? "unknown"}`,
        {
          code: view.errorCode ?? null,
          phase: view.errorPhase ?? null,
        },
      );
    }
    if (view?.endedAt)
      throw new InfraError("session ended before it became ready");
    await sleep(pollMs);
  }
}

async function pushFixtures({ api, sessionId, fixtures, specDir, log }) {
  for (const fixture of fixtures) {
    const local = resolve(specDir, fixture.local);
    let info;
    try {
      info = await stat(local);
    } catch {
      throw new InfraError(`fixture not found: ${fixture.local}`);
    }
    if (!info.isFile())
      throw new InfraError(`fixture is not a file: ${fixture.local}`);
    if (info.size > DEVICE_FILE_MAX_BYTES) {
      throw new InfraError(
        `fixture ${fixture.local} is larger than the 32 MB limit`,
      );
    }
    const filename = basename(local);
    const presigned = await api.presignFile(sessionId, {
      filename,
      path: fixture.device,
      size: info.size,
    });
    const bytes = await readFile(local);
    await api.putFile(presigned.url, bytes, presigned.contentType);
    await api.commitFile(sessionId, {
      key: presigned.key,
      path: fixture.device,
      filename,
    });
    log(`pushed ${fixture.local} → ${fixture.device}/${filename}`);
  }
}

function runCommand({
  view,
  createView,
  appSlug,
  sessionId,
  argv,
  env,
  cwd,
  spawnImpl,
  log,
  childRef,
}) {
  return new Promise((done) => {
    // stdout and stderr are piped through, not inherited, so the end of the
    // output can be read for the runner's summary. Everything is still
    // written to the job log as it arrives.
    const tail = outputTail();
    const child = spawnImpl(argv[0], argv.slice(1), {
      stdio: ["inherit", "pipe", "pipe"],
      // The suite runs from the directory the spec lives in, so `./gradlew`
      // and relative report paths resolve even when `--config` points elsewhere.
      cwd,
      env: { ...env, ...sessionEnv(view, appSlug, sessionId, createView) },
    });
    childRef.current = child;
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      tail.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      tail.push(chunk);
    });
    child.on("error", (error) => {
      log(`could not start the test command: ${error.message}`);
      childRef.current = null;
      done({
        code: null,
        signal: null,
        spawnError: true,
        spawnMessage: `could not start the test command: ${error.message}`.slice(0, 300),
        output: tail.text(),
      });
    });
    // `close`, not `exit`: the pipes may still hold the last lines (the
    // summary) when the process exits.
    child.on("close", (code, signal) => {
      childRef.current = null;
      done({ code, signal, spawnError: false, output: tail.text() });
    });
  });
}

/** The console's limit for one report. */
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * Attach the run's JUnit XML: the file, folder or pattern in `report`, or,
 * when unset, whatever the build tools wrote during the command. Several
 * files are merged into one report. Never fails the run.
 */
async function attachReport({ api, sessionId, report, specDir, since, log }) {
  const files = await collectReports({ dir: specDir, report, since });
  if (files.length === 0) {
    if (report) log(`warning: no JUnit report at ${report} — attach skipped`);
    return false;
  }
  const documents = [];
  for (const file of files) {
    const xml = await readFile(file, "utf8").catch(() => null);
    if (xml?.trim()) documents.push(xml);
  }
  if (documents.length === 0) return false;
  const xml = mergeJUnit(documents);
  const label =
    documents.length === 1
      ? relative(specDir, files[0])
      : `${documents.length} JUnit files`;
  if (Buffer.byteLength(xml, "utf8") > MAX_REPORT_BYTES) {
    log(`warning: ${label} exceed the 8 MB report limit — attach skipped`);
    return false;
  }
  try {
    await api.postReport(sessionId, xml);
    log(`attached ${label}`);
    return true;
  } catch (error) {
    log(`warning: could not attach ${label}: ${error.message}`);
    return false;
  }
}
