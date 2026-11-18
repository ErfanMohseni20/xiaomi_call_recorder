// Xiaomi's own call recorder on HyperOS Global ROMs, switched on over ADB without root
// (the XDA "MIUI dialer on Global ROM" method). Three changes, all for user 0 only:
//   1. bring back the Xiaomi dialer (com.android.contacts + com.android.incallui),
//   2. make it the default phone app,
//   3. remove the regional overlay, whose only resource sets
//      com.android.phone:bool/config_call_recording to false.
//
// Unlike the callrecd helper this survives a reboot and needs no USB debugging: the
// recorder is a system app. Verified on a Redmi Note 13 Pro 4G (HyperOS 3, Android 16),
// including after a reboot, with Google Phone and Google Contacts still installed. They
// stay unless the caller asks for them to go (removeGoogle, what the XDA guide does).
// On the test phones (HyperOS 1, MIUI 12.5) `pm install-existing` and `pm uninstall
// --user 0` worked with MIUI's "USB debugging (Security settings)" switched off.
// It only works where the ROM still ships the Xiaomi dialer; EEA/EU builds do not.
//
// Removals use `pm uninstall -k --user 0`, so the APKs stays on the ROM. What enable
// changed is written to the phone, and revert undoes exactly that.
//
// Every function takes shell(cmd) -> Promise<string output>. The WebUSB shell gives
// no exit code, so results are checked from the output and by reading state back.
import { HOME } from "./daemon.js";

export const XIAOMI_DIALER = "com.android.contacts"; // Xiaomi "Contacts and Phone" (dialer)
export const XIAOMI_INCALL = "com.android.incallui"; // call screen, holds the recorder
export const REGION_OVERLAY = "com.android.phone.cust.overlay.miui"; // hides call recording on Global ROMs
export const GOOGLE_DIALER = "com.google.android.dialer";
export const GOOGLE_CONTACTS = "com.google.android.contacts";

export const INSTALLED = "installed";
export const REMOVED = "removed for user 0";
export const ABSENT = "not on ROM";

const PACKAGES = [XIAOMI_DIALER, XIAOMI_INCALL, REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS];
const DIALER_ROLE = "android.app.role.DIALER";
// Settings.System key behind the Phone app's "Record calls automatically" switch.
const AUTO_RECORD_KEY = "button_auto_record_call";
const BASELINE_FILE = `${HOME}/native.baseline`;

function parsePkgs(out) {
  const set = new Set();
  for (const line of out.split("\n")) {
    const l = line.trim();
    if (l.startsWith("package:")) set.add(l.slice("package:".length));
  }
  return set;
}

// classify turns two `pm list packages` outputs into a state for each package we touch.
export function classify(allOut, activeOut) {
  const all = parsePkgs(allOut), active = parsePkgs(activeOut);
  const st = {};
  for (const p of PACKAGES) st[p] = active.has(p) ? INSTALLED : all.has(p) ? REMOVED : ABSENT;
  return st;
}

async function pkgStates(shell) {
  const all = await shell("pm list packages -u"); // -u also lists packages uninstalled for the user
  const active = await shell("pm list packages --user 0");
  // A healthy phone always lists packages; nothing here means pm itself failed.
  if (!parsePkgs(active).size) throw new Error("could not list packages: " + (active.trim() || "no output"));
  return classify(all, active);
}

async function defaultDialer(shell) {
  return (await shell(`cmd role get-role-holders --user 0 ${DIALER_ROLE}`)).trim();
}

// nativeStatus reports whether this ROM can use the Xiaomi recorder, whether it is on,
// and whether the Phone app is set to record every call by itself.
export async function nativeStatus(shell) {
  const states = await pkgStates(shell);
  const dialer = await defaultDialer(shell);
  const supported = states[XIAOMI_DIALER] !== ABSENT && states[XIAOMI_INCALL] !== ABSENT;
  const enabled = states[XIAOMI_DIALER] === INSTALLED && states[XIAOMI_INCALL] === INSTALLED &&
    states[REGION_OVERLAY] !== INSTALLED && dialer === XIAOMI_DIALER;
  const autoRecord = (await shell(`settings get system ${AUTO_RECORD_KEY}`)).trim() === "1";
  return { states, dialer, supported, enabled, autoRecord };
}

async function apply(shell, log, action, pkg, state) {
  if (state === ABSENT) { log(`skip ${pkg} (not on this ROM)`); return; }
  if ((action === "remove" && state === REMOVED) || (action === "restore" && state === INSTALLED)) {
    log(`skip ${pkg} (already ${state})`);
    return;
  }
  const out = await shell(action === "remove"
    ? `pm uninstall -k --user 0 ${pkg}`
    : `pm install-existing --user 0 ${pkg}`);
  if (!out.includes("Success") && !out.includes("installed for user")) {
    throw new Error(`${action} ${pkg} failed: ${out.trim() || "no output"}`);
  }
  log(`${action} ${pkg}: ok`);
}

// setDialer makes pkg the default phone app and returns the dialer actually in place.
async function setDialer(shell, pkg) {
  await shell(`cmd role add-role-holder --user 0 ${DIALER_ROLE} ${pkg}`);
  if ((await defaultDialer(shell)) !== pkg) await shell(`cmd telecom set-default-dialer ${pkg}`);
  return defaultDialer(shell);
}

// The baseline is what enable is about to change: the phone app in charge, the packages
// it brings back and the overlay it removes. It is one line in a file on the phone.
export function formatBaseline({ dialer, restored, removed }) {
  return `dialer=${dialer} restored=${restored.join(",")} removed=${removed.join(",")}`;
}

// parseBaseline returns null for anything formatBaseline would not write. The line comes
// from a file and its parts end up in shell commands, so only known packages get through.
export function parseBaseline(text) {
  const m = /^dialer=([A-Za-z0-9._]*) restored=([A-Za-z0-9._,]*) removed=([A-Za-z0-9._,]*)$/.exec(text.trim());
  if (!m) return null;
  const only = (s, allowed) => s.split(",").filter((p) => allowed.includes(p));
  return {
    dialer: m[1],
    restored: only(m[2], [XIAOMI_DIALER, XIAOMI_INCALL]),
    removed: only(m[3], [REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS]),
  };
}

// enableNative switches the phone to the Xiaomi dialer and its recorder. The dialer is
// brought back and confirmed before anything else changes. With removeGoogle, Google Phone
// and Google Contacts are removed too, but only once the Xiaomi dialer is the phone app.
// It can be run again on a phone that is already switched, to add that removal.
// Returns the status afterwards.
export async function enableNative(shell, log = () => {}, { removeGoogle = false } = {}) {
  let st = await pkgStates(shell);
  for (const p of [XIAOMI_DIALER, XIAOMI_INCALL]) {
    if (st[p] === ABSENT) throw new Error(`${p} is not on this ROM (EEA/EU build). Nothing was changed.`);
  }
  const dialer = await defaultDialer(shell);
  const removing = [REGION_OVERLAY, ...(removeGoogle ? [GOOGLE_DIALER, GOOGLE_CONTACTS] : [])]
    .filter((p) => st[p] === INSTALLED);
  // An existing baseline is the real starting point of an earlier run: keep its phone app
  // and restored packages, and only add what this run removes on top.
  const prev = parseBaseline(await shell(`cat ${BASELINE_FILE} 2>/dev/null`));
  const baseline = formatBaseline(prev
    ? { ...prev, removed: [...new Set([...prev.removed, ...removing])] }
    : {
      dialer: /^[A-Za-z0-9._]+$/.test(dialer) ? dialer : "",
      restored: [XIAOMI_DIALER, XIAOMI_INCALL].filter((p) => st[p] === REMOVED),
      removed: removing,
    });
  await shell(`mkdir -p ${HOME}; echo '${baseline}' > ${BASELINE_FILE}`);

  await apply(shell, log, "restore", XIAOMI_DIALER, st[XIAOMI_DIALER]);
  await apply(shell, log, "restore", XIAOMI_INCALL, st[XIAOMI_INCALL]);
  st = await pkgStates(shell);
  if (st[XIAOMI_DIALER] !== INSTALLED || st[XIAOMI_INCALL] !== INSTALLED) {
    throw new Error("the Xiaomi dialer did not come back. The phone app was not changed.");
  }
  const phoneApp = await setDialer(shell, XIAOMI_DIALER);
  await apply(shell, log, "remove", REGION_OVERLAY, st[REGION_OVERLAY]);
  if (removeGoogle) {
    if (phoneApp === XIAOMI_DIALER) {
      for (const p of [GOOGLE_DIALER, GOOGLE_CONTACTS]) await apply(shell, log, "remove", p, st[p]);
    } else {
      log("Google Phone was left in place: the Xiaomi dialer is not the phone app yet");
    }
  }
  return nativeStatus(shell);
}

// revertNative undoes enableNative: the overlay (and Google's apps, if they were removed)
// come back, the earlier phone app takes over again, and the packages enable brought
// back are removed again. On a phone that
// was switched by hand (no baseline file; the XDA commands also remove Google's apps) it
// restores the overlay and Google's apps and leaves the Xiaomi dialer installed.
export async function revertNative(shell, log = () => {}) {
  const base = parseBaseline(await shell(`cat ${BASELINE_FILE} 2>/dev/null`));
  let st = await pkgStates(shell);
  for (const p of base ? base.removed : [REGION_OVERLAY, GOOGLE_DIALER, GOOGLE_CONTACTS]) {
    await apply(shell, log, "restore", p, st[p]);
  }
  st = await pkgStates(shell);
  const back = base?.dialer || (st[GOOGLE_DIALER] === INSTALLED ? GOOGLE_DIALER : "");
  const dialer = back ? await setDialer(shell, back) : await defaultDialer(shell);
  if (base && (!back || dialer === back)) {
    // The Xiaomi dialer goes only once another phone app is confirmed in charge.
    if (dialer && dialer !== XIAOMI_DIALER) {
      for (const p of [XIAOMI_INCALL, XIAOMI_DIALER]) {
        if (base.restored.includes(p)) await apply(shell, log, "remove", p, st[p]);
      }
    }
    await shell(`rm -f ${BASELINE_FILE}`);
  }
  return nativeStatus(shell);
}
