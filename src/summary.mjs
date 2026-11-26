/**
 * The test command's own verdict, read from its output.
 *
 * Without a JUnit report the console only knows the exit code. Most runners
 * end with a one-line count, though, and many name the tests that failed, so
 * the CLI reads those from the tail of the output and sends them with the
 * result. Only the final summary counts: when several appear (retries, a
 * multi-module build), the last one in the output wins.
 *
 * Pure: no I/O, so every format is tested from a captured sample.
 */

/** How much of the command's output is kept for reading the summary. */
export const OUTPUT_TAIL_BYTES = 256 * 1024;

/** Names kept per run; the console caps them again. */
const MAX_NAMES = 50;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text) {
  return text.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");
}

/** "2 failed, 10 passed, 1 skipped" (or "|"-separated) → counts by word. */
function countsByWord(list) {
  const counts = {};
  for (const part of list.split(/[,|]/)) {
    const match = /(\d+)\s+([a-z]+)/i.exec(part.trim());
    if (match) counts[match[2].toLowerCase()] = Number(match[1]);
  }
  return counts;
}

/** The last match of a global pattern, with its position. */
function lastMatch(text, pattern) {
  let last = null;
  for (const match of text.matchAll(pattern)) last = match;
  return last;
}

function names(text, pattern, pick = (m) => m[1]) {
  const out = [];
  for (const match of text.matchAll(pattern)) {
    const name = pick(match)?.trim();
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

const fromWords = (counts, failedKeys, passedKeys = ["passed"]) => {
  const sum = (keys) => keys.reduce((total, key) => total + (counts[key] ?? 0), 0);
  return {
    passed: sum(passedKeys),
    failed: sum(failedKeys),
    skipped: sum(["skipped", "pending", "todo", "deselected"].filter((k) => k in counts)),
  };
};

/**
 * Each parser finds its runner's final summary line; `at` is where it sits in
 * the output, so the latest summary across runners wins.
 */
const PARSERS = [
  {
    runner: "jest",
    parse(text) {
      const m = lastMatch(text, /^Tests:\s+(.+?),\s+\d+ total\s*$/gm);
      if (!m) return null;
      return {
        at: m.index,
        ...fromWords(countsByWord(m[1]), ["failed"]),
        failing: names(text, /^\s*● (.+?)\s*$/gm).filter((n) => !/^Console$/.test(n)),
      };
    },
  },
  {
    runner: "vitest",
    parse(text) {
      const m = lastMatch(text, /^\s*Tests\s+(\d+ [a-z]+(?:\s*\|\s*\d+ [a-z]+)*)\s*\(\d+\)\s*$/gm);
      if (!m) return null;
      return {
        at: m.index,
        ...fromWords(countsByWord(m[1]), ["failed"]),
        failing: names(text, /^\s*(?:FAIL|×)\s+(.+?)(?:\s+\d+ms)?\s*$/gm),
      };
    },
  },
  {
    runner: "pytest",
    parse(text) {
      const m = lastMatch(
        text,
        /^=+ ((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s(?: \([^)]*\))? =+\s*$/gm,
      );
      if (!m) return null;
      return {
        at: m.index,
        ...fromWords(countsByWord(m[1]), ["failed", "error", "errors"]),
        failing: names(text, /^(?:FAILED|ERROR) (\S+)/gm),
      };
    },
  },
  {
    runner: "mocha",
    parse(text) {
      const passing = lastMatch(text, /^\s*(\d+) passing\b/gm);
      if (!passing) return null;
      const failing = lastMatch(text, /^\s*(\d+) failing\s*$/gm);
      const pending = lastMatch(text, /^\s*(\d+) pending\s*$/gm);
      const listed = failing ? text.slice(failing.index) : "";
      return {
        at: Math.max(passing.index, failing?.index ?? 0),
        passed: Number(passing[1]),
        failed: failing ? Number(failing[1]) : 0,
        skipped: pending ? Number(pending[1]) : 0,
        failing: names(listed, /^\s*\d+\) (.+?):?\s*$/gm),
      };
    },
  },
  {
    runner: "gradle",
    parse(text) {
      const m = lastMatch(text, /(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?/g);
      if (!m) return null;
      const total = Number(m[1]);
      const failed = Number(m[2]);
      const skipped = Number(m[3] ?? 0);
      return {
        at: m.index,
        passed: Math.max(0, total - failed - skipped),
        failed,
        skipped,
        failing: names(text, /^(\S.*? > .+?) FAILED\s*$/gm),
      };
    },
  },
  {
    runner: "maven",
    parse(text) {
      const m = lastMatch(
        text,
        /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm,
      );
      if (!m) return null;
      const [total, failures, errors, skipped] = m.slice(1, 5).map(Number);
      return {
        at: m.index,
        passed: Math.max(0, total - failures - errors - skipped),
        failed: failures + errors,
        skipped,
        failing: names(text, /^\[ERROR\]\s+(\S+\.\S+?)(?::\d+)?\s+(?:»|-|\S+Error|expected)/gm),
      };
    },
  },
  {
    runner: "unittest",
    parse(text) {
      const ran = lastMatch(text, /^Ran (\d+) tests? in [\d.]+s\s*$/gm);
      if (!ran) return null;
      const verdict = /^(OK|FAILED)(?: \((.+)\))?\s*$/m.exec(text.slice(ran.index));
      if (!verdict) return null;
      const counts = verdict[2] ? Object.fromEntries(
        verdict[2].split(",").map((part) => {
          const [key, value] = part.trim().split("=");
          return [key, Number(value)];
        }),
      ) : {};
      const failed = (counts.failures ?? 0) + (counts.errors ?? 0);
      const skipped = counts.skipped ?? 0;
      return {
        at: ran.index,
        passed: Math.max(0, Number(ran[1]) - failed - skipped),
        failed,
        skipped,
        failing: names(
          text,
          /^(?:FAIL|ERROR): (\S+) \(([^)]+)\)/gm,
          (match) => `${match[2]}.${match[1]}`,
        ),
      };
    },
  },
  {
    runner: "robot",
    parse(text) {
      const m = lastMatch(
        text,
        /^(\d+) tests?, (\d+) passed, (\d+) failed(?:, (\d+) skipped)?\s*$/gm,
      );
      if (!m) return null;
      return {
        at: m.index,
        passed: Number(m[2]),
        failed: Number(m[3]),
        skipped: Number(m[4] ?? 0),
        failing: names(text, /^(.+?)\s+\| FAIL \|\s*$/gm),
      };
    },
  },
  {
    runner: "webdriverio",
    parse(text) {
      const m = lastMatch(text, /^Spec Files:\s+(.+?),\s+\d+ total/gm);
      if (!m) return null;
      return {
        at: m.index,
        ...fromWords(countsByWord(m[1]), ["failed"]),
        failing: [],
      };
    },
  },
];

/**
 * `{ runner, passed, failed, skipped, failing }` from the output, or null
 * when no known summary line is in it.
 */
export function parseTestSummary(output) {
  if (!output) return null;
  const text = stripAnsi(output);
  let best = null;
  for (const parser of PARSERS) {
    let found;
    try {
      found = parser.parse(text);
    } catch {
      found = null;
    }
    if (!found) continue;
    if (found.passed + found.failed + found.skipped === 0) continue;
    if (!best || found.at > best.at) best = { runner: parser.runner, ...found };
  }
  if (!best) return null;
  const { at: _at, ...summary } = best;
  return { ...summary, failing: summary.failing.slice(0, Math.max(0, summary.failed)) };
}

/** Keeps the last `limit` bytes of everything written to it. */
export function outputTail(limit = OUTPUT_TAIL_BYTES) {
  const chunks = [];
  let size = 0;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      size += buffer.length;
      while (size > limit) {
        const excess = size - limit;
        if (chunks[0].length <= excess) {
          size -= chunks.shift().length;
        } else {
          chunks[0] = chunks[0].subarray(excess);
          size = limit;
        }
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
