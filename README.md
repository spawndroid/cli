# spawndroid

Run Android tests on hosted devices from any CI.

Upload a build, boot a real device, run your test command against it, and keep
the result along with the JUnit report, logcat and screen recording.

## Use it in GitHub Actions

1. Create a free account at [app.spawndroid.io](https://app.spawndroid.io).
   The free tier includes 200 device-minutes a month.
2. Under **API & CI/CD → API keys**, create a key with the `upload` scope and
   save it as the repository secret `SPAWNDROID_API_KEY`.
3. Run `npx spawndroid init` locally to write `spawndroid.yaml`, then add:

```yaml
name: Android tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17
      - run: ./gradlew assembleDebug
      - uses: spawndroid/cli@v0.1.10
        id: spawndroid
        with:
          api-key: ${{ secrets.SPAWNDROID_API_KEY }}
      - if: always()
        run: echo "Run: ${{ steps.spawndroid.outputs.run-url }}"
```

The device is torn down even when the job fails, and the JUnit report,
logcat and recording stay on the run page.

## Install

Node 20 or newer. Nothing to install for a one-off run:

```bash
npx spawndroid run
```

Or install it — globally, or as a dev dependency pinned with the project:

```bash
npm install --global spawndroid
npm install --save-dev spawndroid
```

## Quick start

```bash
npx spawndroid init                                  # detect the project, write the spec + workflow
export SPAWNDROID_API_KEY=spawn_live_…               # API & CI/CD → API keys, upload scope
npx spawndroid check                                 # name the walls before the first run
npx spawndroid run                                   # upload → boot → test → report → teardown
```

`init` reads the project (Gradle, Maven, WebdriverIO, pytest), prints what it
inferred, and writes `spawndroid.yaml` plus
`.github/workflows/spawndroid.yml`. It asks only for what it cannot infer.
Every flag is overridable for non-interactive setups:

```bash
npx spawndroid init --app app/build/outputs/apk/debug/app-debug.apk \
  --command "mvn test" --report target/surefire-reports/TEST-com.example.CheckoutTest.xml
```

## The spec

```yaml
version: 1
app: app/build/outputs/apk/debug/app-debug.apk   # APK path, or an uploaded app slug
command: [mvn, test]                             # string is split; list is exact argv
profile: android-14-phone                        # optional device profile
report: target/surefire-reports                  # optional: file, folder or pattern
timeout: 600                                     # seconds to wait for the device
fixtures:                                        # optional files pushed after readiness
  - local: test/fixtures/sample.jpg
    device: /sdcard/Pictures                     # absolute directory under /sdcard
```

Unknown keys are errors — a misspelled `timeout` must not silently fall back
to the default.

`report` is optional. It can be one JUnit XML file, a folder (every `.xml`
inside it), or a pattern such as `app/build/test-results/**/TEST-*.xml`.
Without it, `run` looks where the build tools write reports —
`build/test-results/`, `build/outputs/androidTest-results/` (Gradle, any
module) and `target/surefire-reports/` (Maven) — and attaches only the files
your command wrote during this run. Several files are merged into one report.

With no JUnit report at all, `run` reads the closing summary your test runner
prints (Jest, Vitest, Mocha and WebdriverIO, pytest, unittest, Gradle, Maven,
Robot Framework) and sends the counts and any failing test names it names, so
the run page still shows what passed and what failed.

## Commands

```bash
spawndroid init     [--app <apk>] [--command <cmd>] [--report <xml>] [--profile <id>] [--force]
spawndroid check    [--config <path>]
spawndroid run      [--config <path>] [--profile <id>] [--timeout <s>] [--wait-for-runner <s>] [-- <command…>]
spawndroid upload   <app.apk> [--json]
spawndroid start    --app <slug> [--profile <id>] [--json]
spawndroid wait     <sessionId> [--timeout <s>] [--json]
spawndroid report   <sessionId> --result passed|failed
```

## What `run` does

1. Uploads the APK (or reuses the slug), creating a session with an
   `Idempotency-Key`.
2. Retries a *capacity* `429` up to 3 attempts over ~90 s; plan limits
   (`PLAN_RUNNER_LIMIT`, `PLAN_DEVICE_MINUTES_EXHAUSTED`) fail immediately.
   On `PLAN_RUNNER_LIMIT` it prints the session holding the runner, how long
   until it frees at the latest, and how to stop it. Pass
   `--wait-for-runner <seconds>` (or set `SPAWNDROID_WAIT_FOR_RUNNER`, or the
   action's `wait-for-runner` input) to keep retrying, every 30 s at most,
   until a runner frees up or the time runs out. Off by default.
3. Waits up to `timeout` for the device, then pushes fixtures.
4. Runs `command` locally on the runner with the session in its environment.
5. Attaches the JUnit report (found automatically unless `report` names it),
   tears the device down, and prints the run URL.

Exported to the command:

| Variable                 | Meaning                   |
| ------------------------ | ------------------------- |
| `SPAWNDROID_WD_URL`      | W3C WebDriver endpoint    |
| `SPAWNDROID_UDID`        | device serial             |
| `SPAWNDROID_APP_PACKAGE` | installed app package     |
| `SPAWNDROID_APP`         | app slug                  |
| `SPAWNDROID_SESSION_ID`  | session id                |

The build is installed before your command runs — never set `appium:app`.

Exit codes: `0` tests passed, `1` tests failed, `2` infrastructure or setup
failed. CI retry logic can key off that instead of re-running real failures.

## GitHub Actions

Setup is [at the top](#use-it-in-github-actions). The Action installs the CLI, runs `spawndroid run --config spawndroid.yaml`,
and exposes `session-id`, `run-url` and `result` as step outputs.

## Limits

- Appium / WebDriver suites only: sessions expose a WebDriver endpoint, not adb.
- One APK per session; the APK is installed before the command starts.
- Per-run sessions. The stable hub is documented separately at
  [docs.spawndroid.io](https://docs.spawndroid.io/docs/ci-tests).
- Hobby: 15-minute sessions, 7-day build expiry, live logcat only.

## Examples

| Example                                               | Language   | Runner              |
| ----------------------------------------------------- | ---------- | ------------------- |
| [webdriverio-android](./examples/webdriverio-android) | JavaScript | WebdriverIO + Mocha |
| [python-pytest](./examples/python-pytest)             | Python     | pytest              |
| [java-testng](./examples/java-testng)                 | Java       | TestNG + Maven      |

MIT licensed.
