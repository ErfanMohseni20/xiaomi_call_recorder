import test from "node:test";
import assert from "node:assert/strict";
import { formatFlags, parseFlags, daemonState, startDaemon, RUNNING, DIED } from "../src/daemon.js";

test("flags round-trip", () => {
  for (const o of [{ mode: "call", auto: true, button: true }, { mode: "split", auto: false, button: true }]) {
    assert.deepEqual(parseFlags(formatFlags(o) + "\n"), o);
  }
});

test("a missing or tampered flags file gives the defaults", () => {
  const def = { mode: "call", auto: true, button: true };
  for (const bad of ["", "-mode call -auto=true -button=true; reboot", "-mode $(id) -auto=true -button=true", "garbage"]) {
    assert.deepEqual(parseFlags(bad), def, JSON.stringify(bad));
  }
});

test("daemonState passes the phone's answer through and rejects anything else", async () => {
  assert.equal(await daemonState(async () => "died\n"), DIED);
  assert.equal(await daemonState(async () => "running\r\n"), RUNNING);
  await assert.rejects(daemonState(async () => "sh: not found"), /unexpected helper state/);
});

test("startDaemon saves the flags it starts with", async () => {
  const cmds = [];
  await startDaemon(async (c) => { cmds.push(c); return "started, pid 1"; }, { mode: "split", auto: false, button: true });
  assert.match(cmds[0], /^echo '-mode split -auto=false -button=true' > .*callrecd\.args$/);
  assert.match(cmds[1], /callrecd -mode split -auto=false -button=true start$/);
});
