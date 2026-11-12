// Browser entry: connects to a Xiaomi phone over WebUSB (ADB), pushes the callrec
// payload (Go daemon + Java DEX) and controls it. No local adb, no installed app.
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { ReadableStream } from "@yume-chan/stream-extra";

const HOME = "/data/local/tmp/callrec";
const credStore = new AdbWebCredentialStore("callrec-web");
const manager = AdbDaemonWebUsbDeviceManager.BROWSER;

let adb = null; // connected Adb instance

const els = {};
for (const id of ["connect", "setup", "start", "stop", "status", "pull", "mode", "button", "auto", "log", "state", "files"]) {
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
    }
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
  const mode = els.mode.value;
  const flags = `-auto=${els.auto.checked} -button=${els.button.checked}`;
  log(await shell(`${HOME}/callrecd -mode ${mode} ${flags} start`));
  log("watching for calls. You can unplug the phone; it keeps recording until reboot or Stop.");
};

els.stop.onclick = async () => {
  log(await shell(`${HOME}/callrecd stop`));
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
