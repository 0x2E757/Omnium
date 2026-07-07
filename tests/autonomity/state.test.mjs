import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readState,
  writeState,
  stateFile,
  readStopBlocked,
  writeStopBlocked,
  clearStopBlocked,
} from "../../plugins/autonomity/hooks/state.mjs";

// Each test uses a distinct session id so the tmpdir-backed state files never
// collide across tests or runs.

test("an unknown session defaults to off", () => {
  assert.equal(readState("autonomity-test-unknown-" + process.pid), "off");
});

test("writeState('on') round-trips to readState", () => {
  const id = "autonomity-test-on-" + process.pid;
  assert.equal(writeState(id, "on"), "on");
  assert.equal(readState(id), "on");
});

test("writeState('off') round-trips and reverses a prior on", () => {
  const id = "autonomity-test-off-" + process.pid;
  writeState(id, "on");
  assert.equal(writeState(id, "off"), "off");
  assert.equal(readState(id), "off");
});

test("an unrecognized value is coerced to off", () => {
  const id = "autonomity-test-garbage-" + process.pid;
  assert.equal(writeState(id, "YES"), "off");
  assert.equal(readState(id), "off");
});

test("distinct sessions get distinct state files", () => {
  assert.notEqual(stateFile("a"), stateFile("b"));
});

test("an empty/falsey session id is tolerated (no throw)", () => {
  assert.equal(readState(""), "off");
  assert.equal(readState(undefined), "off");
});

test("the stop-blocked marker defaults to false, sets, and clears", () => {
  const id = "autonomity-test-stopblock-" + process.pid;
  assert.equal(readStopBlocked(id), false);
  writeStopBlocked(id);
  assert.equal(readStopBlocked(id), true);
  clearStopBlocked(id);
  assert.equal(readStopBlocked(id), false);
});

test("clearing an absent stop-blocked marker is a no-op (no throw)", () => {
  clearStopBlocked("autonomity-test-stopblock-absent-" + process.pid);
});

test("stop-blocked markers are isolated per session", () => {
  const a = "autonomity-test-stopblock-a-" + process.pid;
  const b = "autonomity-test-stopblock-b-" + process.pid;
  writeStopBlocked(a);
  try {
    assert.equal(readStopBlocked(b), false);
  } finally {
    clearStopBlocked(a);
  }
});
