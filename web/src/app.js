// Browser entry: connects to a Xiaomi phone over WebUSB (ADB), pushes the callrec
// payload (Go daemon + Java DEX) and controls it. No local adb, no installed app.
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { ReadableStream } from "@yume-chan/stream-extra";
import { HOME, MISSING, RUNNING, DIED, daemonState, savedFlags, startDaemon, stopDaemon } from "./daemon.js";
import { nativeStatus, enableNative, revertNative, GOOGLE_DIALER, GOOGLE_CONTACTS, INSTALLED, REMOVED } from "./native.js";

const credStore = new AdbWebCredentialStore("callrec-web");
const manager = AdbDaemonWebUsbDeviceManager.BROWSER;

let adb = null; // connected Adb instance

const els = {};
for (const id of ["connect", "setup", "start", "stop", "status", "pull", "mode", "button", "auto", "log", "state", "files",
  "notice", "nativeOn", "nativeOff", "nativeState", "nativeRemove"]) {
  els[id] = document.getElementById(id);
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  els.log.textContent += `[${t}] ${msg}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setConnected(on) {
  els.state.textContent = on ? "connected" : "not connected";
  els.state.className = on ? "ok" : "off";
  for (const id of ["setup", "start", "stop", "status", "pull", "mode", "button"]) els[id].disabled = !on;
  els.connect.textContent = on ? "Disconnect" : "Connect phone";
  syncAuto();
  if (!on) { showNative(null); notice(""); }
}

// notice is the one line a non-technical user should read; the log is for details.
function notice(text) {
  els.notice.textContent = text;
  els.notice.hidden = !text;
}

// showNative reflects a nativeStatus() result (null = no phone) in the permanent-recording card.
let nativeSt = null; // last nativeStatus() result shown

function showNative(st) {
  nativeSt = st;
  els.nativeOff.disabled = !st || !st.supported;
  syncNative();
  els.nativeState.textContent = !st ? "Connect the phone to see whether it supports this."
    : st.enabled ? "On. Xiaomi's own Phone app records the calls, also after the phone restarts. " + AUTO_HINT(st) +
      (st.states[GOOGLE_DIALER] === REMOVED ? " Google Phone has been removed." : "")
    : st.supported ? "This phone supports it."
    : "Not available on this phone: its system does not include Xiaomi's Phone app (EU/EEA ROMs and older models). Use the helper below.";
}

// The helper dies with adbd: on a reboot, and when USB debugging or Developer options is switched off.
// The recorder only records by itself once this switch in the Phone app is on.
const AUTO_STEP = "open the Phone app → Settings → Call recording and turn on automatic recording";
const AUTO_HINT = (st) => st.autoRecord ? "Automatic recording is on." : "Automatic recording is OFF: " + AUTO_STEP + ".";

// Google's apps can only be removed where permanent recording works and they are still there.
// On a phone that is already switched, Turn on stays usable just to add that removal.
function syncNative() {
  const st = nativeSt;
  const google = !!st && st.supported && [GOOGLE_DIALER, GOOGLE_CONTACTS].some((p) => st.states[p] === INSTALLED);
  els.nativeRemove.disabled = !google;
  if (!google) els.nativeRemove.checked = false;
  els.nativeOn.disabled = !st || !st.supported || (st.enabled && !els.nativeRemove.checked);
}
els.nativeRemove.onchange = syncNative;

const AFTER_RESTART = "It stops when the phone restarts or USB debugging is turned off. " +
  "When that happens: plug the phone in, open this page and click Connect. Recording starts again by itself.";

// refresh reads the phone's state on connect. If the helper was killed it is
// started again with the flags of its last start, so reconnecting is all a user has to do.
async function refresh() {
  const st = await nativeStatus(shell);
  showNative(st);
  if (st.enabled) {
    notice(st.autoRecord
      ? "Permanent recording is on and every call is recorded automatically. Nothing to do here."
      : "Permanent recording is on, but calls are not recorded automatically yet. On the phone, " + AUTO_STEP + ".");
    return;
  }
  let d = await daemonState(shell);
  const resumed = d === DIED;
  if (resumed) {
    const opts = await savedFlags(shell);
    els.mode.value = opts.mode;
    els.button.checked = opts.button;
    els.auto.checked = opts.auto;
    syncAuto();
    log("recording had stopped (phone restarted or USB debugging turned off). Starting it again ...");
    log(await startDaemon(shell, opts));
    d = await daemonState(shell);
  }
  const helper = d !== RUNNING ? "" : resumed
    ? "Recording had stopped. It is running again. "
    : "Recording is active. ";
  if (st.supported) {
    notice(helper + "This phone can record permanently: turn on \"Permanent recording\" below and you never need to reconnect, even with USB debugging off.");
  } else if (helper) {
    notice(helper + AFTER_RESTART);
  } else {
    notice("Recording is off. Install the helper and press Start watching. " + AFTER_RESTART);
  }
}

// Without the in-call button nothing could start a paused recording, so auto is forced on.
function syncAuto() {
  if (!els.button.checked) els.auto.checked = true;
  els.auto.disabled = els.button.disabled || !els.button.checked;
}
els.button.onchange = syncAuto;

// shell runs one command line and returns its output. adbd's exec: service already runs
// the joined string through `sh -c`, so pass it as one element (wrapping in another
// `sh -c` would split it and run only the first word).
async function shell(cmd) {
  return await adb.subprocess.noneProtocol.spawnWaitText([cmd]);
}

async function readAll(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// pushFile writes bytes to a device path via the sync service.
async function pushFile(remote, bytes, mode = 0o644) {
  const sync = await adb.sync();
  try {
    // write() accepts a MaybeConsumable stream, so a plain Uint8Array stream is fine.
    const file = ReadableStream.from([new Uint8Array(bytes)]);
    await sync.write({ filename: remote, file, permission: mode });
  } finally {
    await sync.dispose();
  }
}

async function fetchAsset(name) {
  const r = await fetch("payload/" + name);
  if (!r.ok) throw new Error(`fetch ${name}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

els.connect.onclick = async () => {
  if (adb) { // disconnect
    try { await adb.close(); } catch {}
    adb = null;
    setConnected(false);
    log("disconnected");
    return;
  }
  if (!manager) { log("WebUSB not available. Use Chrome/Edge over HTTPS or localhost."); return; }
  try {
    // Reuse a phone this site was already allowed to use; otherwise show Chrome's picker.
    const device = (await manager.getDevices())[0] ?? await manager.requestDevice();
    if (!device) { log("no device selected"); return; }
    log(`opening ${device.name} ... accept the 'Allow USB debugging' prompt on the phone`);
    const connection = await device.connect();
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: credStore,
    });
    adb = new Adb(transport);
    const [brand, model, android, hyperos] = (await shell(
      "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.mi.os.version.name",
    )).split("\n").map((s) => s.trim());
    setConnected(true);
    log(`connected: ${brand} ${model}, Android ${android}, HyperOS ${hyperos || "-"}`);
    // HyperOS phones still report a MIUI version, so ro.mi.os.version.name is the test.
    if (brand.toLowerCase() !== "xiaomi" || !hyperos) {
      for (const id of ["setup", "start", "mode", "button", "auto"]) els[id].disabled = true;
      log("Not supported: this tool only works on Xiaomi phones running HyperOS (not MIUI).");
      return;
    }
    await refresh();
  } catch (e) {
    log("connect failed: " + e.message);
  }
};

els.setup.onclick = async () => {
  try {
    log("pushing payload ...");
    await shell(`mkdir -p ${HOME}`);
    await pushFile(`${HOME}/callrec.dex`, await fetchAsset("callrec.dex"));
    const abi = (await shell("getprop ro.product.cpu.abi")).trim();
    const bin = abi.startsWith("arm64") ? "callrecd-arm64" : "callrecd-arm";
    await pushFile(`${HOME}/callrecd`, await fetchAsset(bin), 0o755);
    await shell(`chmod 755 ${HOME}/callrecd`);
    log(`payload installed (${bin}). Ready.`);
  } catch (e) {
    log("setup failed: " + e.message);
  }
};

els.start.onclick = async () => {
  log(await startDaemon(shell, { mode: els.mode.value, auto: els.auto.checked, button: els.button.checked }));
  log("watching for calls. You can unplug the phone; it keeps recording until reboot or Stop.");
};

els.stop.onclick = async () => {
  log(await stopDaemon(shell));
};

els.nativeOn.onclick = async () => {
  const removeGoogle = els.nativeRemove.checked;
  if (!confirm("This makes Xiaomi's own Phone app the phone app of this phone; it has a built-in call recorder. " +
    (removeGoogle ? "Google Phone and Google Contacts are removed from the phone. " : "Google Phone stays installed. ") +
    "Contacts and call history stay. You can undo it here later.\n\nContinue?")) return;
  els.nativeOn.disabled = els.nativeOff.disabled = els.nativeRemove.disabled = true;
  try {
    const st = await enableNative(shell, log, { removeGoogle });
    // One recorder is enough; this also keeps the next connect from resuming the helper.
    if ((await daemonState(shell)) !== MISSING) log("helper: " + await stopDaemon(shell));
    showNative(st);
    const next = st.autoRecord ? "Every call is recorded automatically."
      : "One step left on the phone: " + AUTO_STEP + ". If that setting is missing, restart the phone.";
    notice(st.enabled ? "Permanent recording is set up. " + next
      : "Almost done. On the phone choose Xiaomi's Phone app in Settings → Apps → Default apps → Phone app. " + next);
    log(st.enabled ? "permanent recording set up" : "set up, but the default phone app could not be changed from here");
  } catch (e) {
    log("permanent recording failed: " + e.message);
    showNative(await nativeStatus(shell).catch(() => null));
  }
};

els.nativeOff.onclick = async () => {
  els.nativeOn.disabled = els.nativeOff.disabled = els.nativeRemove.disabled = true;
  try {
    const st = await revertNative(shell, log);
    showNative(st);
    notice(st.enabled ? "Could not switch back to the earlier phone app. Choose it on the phone in Settings → Apps → Default apps → Phone app, then press Undo again."
      : "Permanent recording is off and the phone app is as it was before.");
    log(st.enabled ? "undo incomplete" : "reverted");
  } catch (e) {
    log("undo failed: " + e.message);
    showNative(await nativeStatus(shell).catch(() => null));
  }
};

els.status.onclick = async () => {
  log(await shell(`${HOME}/callrecd status`));
  const tail = await shell(`tail -n 8 ${HOME}/callrecd.log 2>/dev/null`);
  if (tail.trim()) log("log:\n" + tail.trim());
};

els.pull.onclick = async () => {
  try {
    const list = (await shell(`ls -1 /sdcard/CallRecordings/*.wav 2>/dev/null`)).trim();
    if (!list) { log("no recordings yet"); return; }
    els.files.innerHTML = "";
    for (const path of list.split("\n")) {
      const sync = await adb.sync();
      const bytes = await readAll(sync.read(path));
      await sync.dispose();
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      const name = path.split("/").pop();
      const row = document.createElement("div");
      row.className = "file";
      const a = document.createElement("audio");
      a.controls = true; a.src = url;
      const dl = document.createElement("a");
      dl.href = url; dl.download = name; dl.textContent = "⬇ " + name;
      row.append(dl, a);
      els.files.append(row);
    }
    log(`loaded ${list.split("\n").length} recording(s)`);
  } catch (e) {
    log("pull failed: " + e.message);
  }
};

setConnected(false);
if (!manager) log("This browser has no WebUSB. Use desktop Chrome or Edge.");
