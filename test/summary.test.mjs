import assert from "node:assert/strict";
import { test } from "node:test";

import { outputTail, parseTestSummary, stripAnsi } from "../src/summary.mjs";

test("jest: counts and the failing test names", () => {
  const out = `
  ● Login › signs in with a valid account

    expect(received).toBe(expected)

Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 1 skipped, 10 passed, 12 total
Snapshots:   0 total
`;
  assert.deepEqual(parseTestSummary(out), {
    runner: "jest",
    passed: 10,
    failed: 1,
    skipped: 1,
    failing: ["Login › signs in with a valid account"],
  });
});

test("vitest: the pipe-separated line", () => {
  const out = ` FAIL  test/login.test.ts > signs in
 Test Files  1 failed | 3 passed (4)
      Tests  2 failed | 20 passed (22)
`;
  const summary = parseTestSummary(out);
  assert.equal(summary.runner, "vitest");
  assert.equal(summary.passed, 20);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.failing, ["test/login.test.ts > signs in"]);
});

test("pytest (Appium Python client): errors count as failures", () => {
  const out = `
FAILED tests/test_login.py::test_login - AssertionError: no such element
ERROR tests/test_cart.py::test_add - WebDriverException
==== 1 failed, 8 passed, 1 skipped, 1 error in 42.10s ====
`;
  assert.deepEqual(parseTestSummary(out), {
    runner: "pytest",
    passed: 8,
    failed: 2,
    skipped: 1,
    failing: ["tests/test_login.py::test_login", "tests/test_cart.py::test_add"],
  });
});

test("mocha (WebdriverIO, Appium JS): passing, failing, and the numbered list", () => {
  const out = `
  9 passing (1m)
  1 pending
  2 failing

  1) Checkout applies a coupon:
     AssertionError: expected 10 to equal 0
  2) Checkout pays:
     Error: element not found
`;
  assert.deepEqual(parseTestSummary(out), {
    runner: "mocha",
    passed: 9,
    failed: 2,
    skipped: 1,
    failing: ["Checkout applies a coupon", "Checkout pays"],
  });
});

test("gradle connected tests", () => {
  const out = `
LoginTest > signsIn FAILED
    java.lang.AssertionError at LoginTest.kt:42
12 tests completed, 1 failed, 2 skipped
`;
  assert.deepEqual(parseTestSummary(out), {
    runner: "gradle",
    passed: 9,
    failed: 1,
    skipped: 2,
    failing: ["LoginTest > signsIn"],
  });
});

test("maven surefire's final line", () => {
  const out = `[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0
[ERROR] Tests run: 14, Failures: 1, Errors: 1, Skipped: 2
`;
  const summary = parseTestSummary(out);
  assert.equal(summary.runner, "maven");
  assert.deepEqual([summary.passed, summary.failed, summary.skipped], [10, 2, 2]);
});

test("python unittest", () => {
  const out = `FAIL: test_login (tests.test_app.LoginTest)
----------------------------------------------------------------------
Ran 5 tests in 31.2s

FAILED (failures=1, errors=1)
`;
  assert.deepEqual(parseTestSummary(out), {
    runner: "unittest",
    passed: 3,
    failed: 2,
    skipped: 0,
    failing: ["tests.test_app.LoginTest.test_login"],
  });
});

test("robot framework", () => {
  const out = `Login With Valid Account                                | FAIL |
3 tests, 2 passed, 1 failed
`;
  const summary = parseTestSummary(out);
  assert.equal(summary.runner, "robot");
  assert.deepEqual(summary.failing, ["Login With Valid Account"]);
});

test("colors are stripped and the latest summary wins", () => {
  const out = "\u001b[32m  3 passing (2s)\u001b[39m\n" +
    "Tests:       2 failed, 5 passed, 7 total\n";
  const summary = parseTestSummary(out);
  assert.equal(summary.runner, "jest");
  assert.equal(summary.failed, 2);
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
});

test("output without a known summary, or counting nothing, is no summary", () => {
  assert.equal(parseTestSummary(""), null);
  assert.equal(parseTestSummary("BUILD SUCCESSFUL in 3s\n"), null);
  assert.equal(parseTestSummary("0 tests completed, 0 failed\n"), null);
});

test("the tail keeps only the newest bytes", () => {
  const tail = outputTail(10);
  tail.push("0123456789");
  tail.push(Buffer.from("abc"));
  assert.equal(tail.text(), "3456789abc");
  tail.push("x".repeat(25));
  assert.equal(tail.text(), "x".repeat(10));
});

test("the last error line skips counts and build-tool wrappers", async () => {
  const { lastErrorLine } = await import("../src/summary.mjs");
  const out = `
  1) Login signs in:
     NoSuchElementError: element ("~login") still not existing after 10000ms
      at async Context.<anonymous> (test/login.e2e.js:12:5)

  9 passing (1m)
  1 failing

npm ERR! Test failed.  See above for more details.
Error: Process completed with exit code 1.
`;
  assert.equal(
    lastErrorLine(out),
    'NoSuchElementError: element ("~login") still not existing after 10000ms',
  );
});

test("gradle and pytest wrappers are not the cause", async () => {
  const { lastErrorLine } = await import("../src/summary.mjs");
  assert.equal(
    lastErrorLine(`E   AssertionError: assert 'Home' == 'Login'
FAILED tests/test_login.py::test_login
==== 1 failed in 3.10s ====
`),
    "E AssertionError: assert 'Home' == 'Login'",
  );
  assert.equal(
    lastErrorLine(`java.lang.AssertionError: expected:<1> but was:<2>
FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:connectedDebugAndroidTest'.
BUILD FAILED in 2m 3s
`),
    "java.lang.AssertionError: expected:<1> but was:<2>",
  );
  assert.equal(lastErrorLine("all good\nBUILD SUCCESSFUL\n"), null);
  assert.equal(lastErrorLine(""), null);
});
