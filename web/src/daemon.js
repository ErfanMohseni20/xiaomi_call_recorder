// State of the callrecd helper on the phone, and how to bring it back after it was killed.
//
// callrecd runs as the ADB shell user, a child of adbd. A reboot kills it, and so does
// anything that stops adbd (USB debugging or Developer options switched off); Android
// gives the shell user no way to start anything by itself. What we can do is notice it
// on the next connect: a clean Stop removes the pid file, a kill leaves it behind.
// The flags of the last start are kept on the phone so any computer can resume it.

export const HOME = "/data/local/tmp/callrec";
const ARGS_FILE = `${HOME}/callrecd.args`;
const DEFAULTS = { mode: "call", auto: true, button: true };

export const MISSING = "missing"; // payload not installed
export const RUNNING = "running";
export const STOPPED = "stopped"; // never started, or stopped on purpose
export const DIED = "died";       // was running, then a reboot or an adbd stop killed it

export async function daemonState(shell) {
  const out = (await shell(
    `if [ ! -x ${HOME}/callrecd ] || [ ! -f ${HOME}/callrec.dex ]; then echo ${MISSING}; ` +
    `elif ${HOME}/callrecd status | grep -q '^running'; then echo ${RUNNING}; ` +
    `elif [ -f ${HOME}/callrecd.pid ]; then echo ${DIED}; else echo ${STOPPED}; fi`,
  )).trim();
  if (![MISSING, RUNNING, STOPPED, DIED].includes(out)) throw new Error("unexpected helper state: " + out);
  return out;
}

export function formatFlags({ mode, auto, button }) {
  return `-mode ${mode} -auto=${auto} -button=${button}`;
}

// parseFlags reads a saved flags line. Anything that is not exactly what formatFlags
// writes gives the defaults: the line comes from a file and ends up in a shell command.
export function parseFlags(text) {
  const m = /^-mode (call|split) -auto=(true|false) -button=(true|false)$/.exec(text.trim());
  if (!m) return { ...DEFAULTS };
  return { mode: m[1], auto: m[2] === "true", button: m[3] === "true" };
}

export async function savedFlags(shell) {
  return parseFlags(await shell(`cat ${ARGS_FILE} 2>/dev/null`));
}

// startDaemon starts the helper and remembers its flags for the next resume.
export async function startDaemon(shell, opts) {
  const flags = formatFlags(opts);
  await shell(`echo '${flags}' > ${ARGS_FILE}`);
  return (await shell(`${HOME}/callrecd ${flags} start`)).trim();
}

// stopDaemon stops the helper and clears a stale pid file, so the next connect does
// not take it for a reboot and start it again.
export async function stopDaemon(shell) {
  const out = (await shell(`${HOME}/callrecd stop`)).trim();
  await shell(`rm -f ${HOME}/callrecd.pid`);
  return out;
}
