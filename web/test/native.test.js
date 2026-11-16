import test from "node:test";
import assert from "node:assert/strict";
import {
  classify, nativeStatus, enableNative, revertNative, formatBaseline, parseBaseline,
  XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS,
  INSTALLED, REMOVED, ABSENT,
} from "../src/native.js";

const ROLE = "android.app.role.DIALER";
const BASELINE = "/data/local/tmp/callrec/native.baseline";

// fakePhone answers the lines native.js sends, like a phone would.
// all = packages on the ROM, active = installed for user 0.
function fakePhone({ all, active, dialer, fail = [], roleCmdWorks = true, autoRecord = null, files = {} }) {
  const s = { all: new Set(all), active: new Set(active), dialer, cmds: [], files: { ...files } };
  const list = (set) => [...set].map((p) => `package:${p}\n`).join("");
  const shell = async (cmd) => {
    s.cmds.push(cmd);
    if (fail.includes(cmd)) return "Failure [INSTALL_FAILED]";
    let m;
    if (cmd === "pm list packages -u") return list(s.all);
    if (cmd === "pm list packages --user 0") return list(s.active);
    if ((m = /^pm install-existing --user 0 (\S+)$/.exec(cmd))) {
      if (!s.all.has(m[1])) return `android.content.pm.PackageManager$NameNotFoundException: Package ${m[1]} doesn't exist`;
      s.active.add(m[1]);
      return `Package ${m[1]} installed for user: 0`;
    }
    if ((m = /^pm uninstall -k --user 0 (\S+)$/.exec(cmd))) {
      if (!s.active.has(m[1])) return "Failure [not installed for 0]";
      s.active.delete(m[1]);
      return "Success";
    }
    if (cmd === `cmd role get-role-holders --user 0 ${ROLE}`) return s.dialer + "\n";
    if ((m = /^cmd role add-role-holder --user 0 android\.app\.role\.DIALER (\S+)$/.exec(cmd))) {
      if (roleCmdWorks && s.active.has(m[1])) s.dialer = m[1];
      return "";
    }
    if ((m = /^cmd telecom set-default-dialer (\S+)$/.exec(cmd))) {
      if (s.active.has(m[1])) s.dialer = m[1];
      return "";
    }
    if (cmd === "settings get system button_auto_record_call") return autoRecord + "\n";
    if ((m = /^mkdir -p \S+; \[ -f (\S+) \] \|\| echo '([^']*)' > \1$/.exec(cmd))) {
      if (!(m[1] in s.files)) s.files[m[1]] = m[2] + "\n";
      return "";
    }
    if ((m = /^cat (\S+) 2>\/dev\/null$/.exec(cmd))) return s.files[m[1]] ?? "";
    if ((m = /^rm -f (\S+)$/.exec(cmd))) { delete s.files[m[1]]; return ""; }
    throw new Error("unexpected command: " + cmd);
  };
  return { s, shell };
}

// A Global ROM out of the box: Xiaomi dialer on the ROM but removed, Google's active.
// Same package states as the Redmi Note 13 Pro 4G (emerald_global, OS3.0.307.0.WNFMIXM).
const globalRom = (extra = {}) => fakePhone({
  all: [XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS, "com.android.settings"],
  active: [REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS, "com.android.settings"],
  dialer: GOOGLE_DIALER,
  ...extra,
});

// An EEA ROM: the Xiaomi dialer is not there at all (seen on vili_eea, OS1.0.26.0.UKDEUXM).
const eeaRom = () => fakePhone({
  all: [REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS, "com.android.settings"],
  active: [REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS, "com.android.settings"],
  dialer: GOOGLE_DIALER,
});

const changes = (cmds) => cmds.filter((c) => /^pm (install-existing|uninstall)|add-role-holder|set-default-dialer/.test(c));
const sorted = (set) => [...set].sort();

test("classify", () => {
  const all = "package:com.android.contacts\npackage:com.android.incallui\r\npackage:com.android.phone.cust.overlay.miui\npackage:com.google.android.dialer\n";
  const active = "package:com.android.contacts\npackage:com.google.android.dialer\n";
  assert.deepEqual(classify(all, active), {
    [XIAOMI_DIALER]: INSTALLED,
    [XIAOMI_INCALL]: REMOVED,
    [REGION_OVERLAY]: REMOVED,
    [GOOGLE_DIALER]: INSTALLED,
    [GOOGLE_CONTACTS]: ABSENT,
  });
});

test("EEA ROM is unsupported and enable changes nothing", async () => {
  const { s, shell } = eeaRom();
  const st = await nativeStatus(shell);
  assert.equal(st.supported, false);
  assert.equal(st.enabled, false);
  await assert.rejects(enableNative(shell), /not on this ROM/);
  assert.deepEqual(changes(s.cmds), []);
  assert.deepEqual(s.files, {});
});

test("Global ROM: enable makes the Xiaomi dialer the phone app and keeps Google's apps", async () => {
  const { s, shell } = globalRom();
  assert.deepEqual(await nativeStatus(shell).then((x) => [x.supported, x.enabled]), [true, false]);

  const st = await enableNative(shell);
  assert.equal(st.enabled, true);
  assert.equal(s.dialer, XIAOMI_DIALER);
  assert.deepEqual(sorted(s.active), sorted([XIAOMI_DIALER, XIAOMI_INCALL, GOOGLE_DIALER, GOOGLE_CONTACTS, "com.android.settings"]));
  // Exactly the three steps that were run by hand on the real phone, in that order.
  assert.deepEqual(changes(s.cmds), [
    `pm install-existing --user 0 ${XIAOMI_DIALER}`,
    `pm install-existing --user 0 ${XIAOMI_INCALL}`,
    `cmd role add-role-holder --user 0 ${ROLE} ${XIAOMI_DIALER}`,
    `pm uninstall -k --user 0 ${REGION_OVERLAY}`,
  ]);
  assert.equal(s.files[BASELINE], `dialer=${GOOGLE_DIALER} restored=${XIAOMI_DIALER},${XIAOMI_INCALL} removed=${REGION_OVERLAY}\n`);
});

test("revert after enable puts the phone back exactly as it was", async () => {
  const { s, shell } = globalRom();
  const before = sorted(s.active);
  await enableNative(shell);
  const st = await revertNative(shell);
  assert.equal(st.enabled, false);
  assert.equal(st.supported, true);
  assert.equal(s.dialer, GOOGLE_DIALER);
  assert.deepEqual(sorted(s.active), before);
  assert.deepEqual(s.files, {});
});

test("enable twice is a no-op and keeps the first baseline", async () => {
  const { s, shell } = globalRom();
  await enableNative(shell);
  const baseline = s.files[BASELINE];
  s.cmds.length = 0;
  assert.equal((await enableNative(shell)).enabled, true);
  assert.deepEqual(changes(s.cmds).filter((c) => c.startsWith("pm ")), []);
  assert.equal(s.files[BASELINE], baseline);
});

test("a failed restore changes neither the phone app nor the overlay", async () => {
  const { s, shell } = globalRom({ fail: [`pm install-existing --user 0 ${XIAOMI_INCALL}`] });
  await assert.rejects(enableNative(shell), /restore com\.android\.incallui failed/);
  assert.equal(s.dialer, GOOGLE_DIALER);
  assert.ok(s.active.has(REGION_OVERLAY) && s.active.has(GOOGLE_DIALER));
  // Undo then removes the half that did come back.
  await revertNative(shell);
  assert.deepEqual(sorted(s.active), sorted([REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS, "com.android.settings"]));
});

test("falls back to telecom when the role command does nothing", async () => {
  const { s, shell } = globalRom({ roleCmdWorks: false });
  assert.equal((await enableNative(shell)).enabled, true);
  assert.equal(s.dialer, XIAOMI_DIALER);
});

test("revert keeps a Xiaomi dialer that was there before enable", async () => {
  // A ROM that ships the Xiaomi dialer as the phone app; only the overlay is in the way.
  const { s, shell } = fakePhone({
    all: [XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY],
    active: [XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY],
    dialer: XIAOMI_DIALER,
  });
  assert.equal((await enableNative(shell)).enabled, true);
  await revertNative(shell);
  assert.deepEqual(sorted(s.active), sorted([XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY]));
  assert.equal(s.dialer, XIAOMI_DIALER);
});

test("revert without a baseline (phone switched with the XDA commands) restores Google's apps", async () => {
  const { s, shell } = fakePhone({
    all: [XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS],
    active: [XIAOMI_DIALER, XIAOMI_INCALL],
    dialer: XIAOMI_DIALER,
  });
  const st = await revertNative(shell);
  assert.equal(st.enabled, false);
  assert.equal(s.dialer, GOOGLE_DIALER);
  // Nothing says the Xiaomi dialer was ours to remove, so it stays.
  assert.deepEqual(sorted(s.active), sorted([XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS]));
});

test("revert never removes the Xiaomi dialer while it is still the phone app", async () => {
  // The earlier phone app is gone, so the role cannot move back.
  const { s, shell } = globalRom();
  await enableNative(shell);
  s.active.delete(GOOGLE_DIALER);
  await revertNative(shell);
  assert.equal(s.dialer, XIAOMI_DIALER);
  assert.ok(s.active.has(XIAOMI_DIALER) && s.active.has(XIAOMI_INCALL));
  assert.ok(BASELINE in s.files); // kept for a later retry
});

test("baseline round-trip, and a tampered file is ignored", () => {
  const b = { dialer: GOOGLE_DIALER, restored: [XIAOMI_DIALER, XIAOMI_INCALL], removed: [REGION_OVERLAY] };
  assert.deepEqual(parseBaseline(formatBaseline(b) + "\n"), b);
  assert.equal(parseBaseline(""), null);
  assert.equal(parseBaseline("dialer=x; reboot restored= removed="), null);
  // Unknown package names are dropped, so revert can only touch our own packages.
  assert.deepEqual(parseBaseline("dialer=a.b restored=com.android.settings,com.android.incallui removed=android"),
    { dialer: "a.b", restored: [XIAOMI_INCALL], removed: [] });
});

test("status reports the automatic recording switch", async () => {
  assert.equal((await nativeStatus(globalRom({ autoRecord: 1 }).shell)).autoRecord, true);
  assert.equal((await nativeStatus(globalRom({ autoRecord: 0 }).shell)).autoRecord, false);
  assert.equal((await nativeStatus(globalRom().shell)).autoRecord, false); // "null": never set
});

test("an empty package list is an error, not an unsupported phone", async () => {
  await assert.rejects(nativeStatus(async () => "error: closed\n"), /could not list packages/);
});
