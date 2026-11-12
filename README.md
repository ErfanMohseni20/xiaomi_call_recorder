# callrec — record Xiaomi calls from the browser over WebUSB

Our own call recorder, no installed Android app and no Shizuku. A web page talks ADB
to the phone over WebUSB, drops a tiny payload on it, and the payload records every
call on the phone itself. The approach (open the privileged `VOICE_CALL` /
`VOICE_UPLINK` / `VOICE_DOWNLINK` audio sources as the ADB shell user) is taken from
[ShizuCallRecorder](https://github.com/kitsumed/ShizuCallRecorder) and
[scrcpy](https://github.com/Genymobile/scrcpy).

## Pieces

| Path | What it is |
|------|-----------|
| `helper/` | Java helper (`callrec.dex`) run by `app_process` as uid 2000. Opens the call audio sources, streams PCM to stdout, and shows the floating in-call REC button. |
| `cmd/callrecd/` | Go daemon for the phone (`GOOS=android`). Watches the call state, runs the helper during each call, writes WAV to `/sdcard/CallRecordings`. Survives USB unplug; stops on reboot. |
| `web/` | Browser app (Tango ADB over WebUSB + esbuild bundle). Connects, installs the payload, starts/stops the daemon, downloads recordings. |
| `web/payload/` | Built artifacts the page serves: `callrec.dex`, `callrecd-arm64`, `callrecd-arm`. |

## Build

```bash
helper/build-dex.sh                      # -> web/payload/callrec.dex  (uses the cimg/android docker image)
CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o web/payload/callrecd-arm64 ./cmd/callrecd
CGO_ENABLED=0 GOOS=linux  GOARCH=arm GOARM=7 go build -tags timetzdata -trimpath -ldflags='-s -w' -o web/payload/callrecd-arm ./cmd/callrecd
cd web && npm install && ./build.sh --minify   # -> web/app.bundle.js
go test ./...
```

## Use

1. Serve `web/` over HTTPS (or `localhost`) — WebUSB needs a secure context and desktop Chrome/Edge.
2. On the phone: Developer options → **USB debugging** and **USB debugging (Security settings)** on.
3. **Stop the local `adb` server first** (`adb kill-server`). WebUSB needs exclusive access to the phone; it cannot share with a running adb daemon.
4. Open the page → Connect → accept the prompt on the phone → *Install helper* → *Start watching*.
5. The phone now records every call by itself. Unplug if you like. *Load recordings* to play/download.

## Modes

- **Mixed (mono)** — `VOICE_CALL`, both sides mixed into one channel. Most compatible.
- **Stereo** — `VOICE_UPLINK` (you) on left, `VOICE_DOWNLINK` (them) on right. Not every OEM feeds these.

## In-call REC button

Samsung's dialer has a record button on the call screen. These ROMs ship Google Phone, whose
call screen we cannot change, so the helper draws its own floating button for the length of
each call (an overlay window; the shell UID holds `SYSTEM_ALERT_WINDOW`,
`INTERNAL_SYSTEM_WINDOW` and `SYSTEM_APPLICATION_OVERLAY`).

- **Red with a timer** = recording; tap to pause. **Grey with a red dot** = paused; tap to record.
- Paused stretches are left out, so a call still gives one WAV. A call with nothing recorded leaves no file.
- Drag it anywhere; the spot is saved in `/data/local/tmp/callrec/button.pos`.
- Daemon flags: `-button=false` hides it (record every call, as before); `-auto=false` starts each
  call paused, so only calls where you tap the button get recorded. The page has a checkbox for each.
- If the button cannot be shown, the call is still recorded (the helper logs why and carries on).
- HyperOS quirks handled in `InCallButton.prepare()`: MIUI's floating-window whitelist check in
  `WindowManagerGlobal.addView` (fails for uid 2000), its `FramePredict` booster hook, and the
  system fonts that zygote would normally preload.

## Limits

- Needs USB debugging + the Xiaomi "Security settings" debugging toggle (which needs a signed-in Mi account and network on the phone to enable).
- The daemon stops at reboot; start it again from the page.
- Call detection polls `dumpsys telephony.registry` once a second: ~1 s to start, and it only sees cellular/VoLTE calls, not VoIP apps.
- Android 12/13 record the call fine; VoIP capture generally needs Android 14+.
- Recording calls may be illegal without consent where you are. Your responsibility.
