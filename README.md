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
| `web/src/native.js` | Permanent recording: switches a Global ROM to Xiaomi's own dialer and its built-in recorder (see below). |
| `web/src/daemon.js` | Helper state on the phone; restarts the helper on connect when a reboot killed it. |
| `web/payload/` | Built artifacts the page serves: `callrec.dex`, `callrecd-arm64`, `callrecd-arm`. |
| `cmd/callrec-web/` | Go web server for the page: one binary with `web/` embedded. |
| `php/` | The same web server in PHP, for hosts that run PHP rather than a Go binary. |

## Build

```bash
helper/build-dex.sh                      # -> web/payload/callrec.dex  (uses the cimg/android docker image)
CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o web/payload/callrecd-arm64 ./cmd/callrecd
CGO_ENABLED=0 GOOS=linux  GOARCH=arm GOARM=7 go build -tags timetzdata -trimpath -ldflags='-s -w' -o web/payload/callrecd-arm ./cmd/callrecd
cd web && npm install && ./build.sh --minify   # -> web/app.bundle.js
cd web && npm test                       # phone logic against a simulated phone
go test ./...
go build -o callrec-web ./cmd/callrec-web  # the local server embeds web/, rebuild it after the bundle
```

## PHP version

`php/index.php` is `cmd/callrec-web` in PHP: it serves the same page and payload with the same
routes, redirects, headers (`Cache-Control: no-store` on everything), byte ranges and errors.
Only the web server is PHP. The page is JavaScript and the payload runs on the phone, where there
is no PHP, so the PHP version serves the very files the Go binary embeds and needs no Go on the host.

```bash
php -S 127.0.0.1:8084 php/index.php   # local, straight from the source tree
php/build.sh                          # -> php/dist/, the counterpart of `go build`
```

Upload what is in `php/dist/` (`index.php`, `.htaccess`, `index.html`, `app.bundle.js`, `payload/`)
to the site root or any subfolder of an HTTPS site; WebUSB does not work over plain HTTP. Run
`php/build.sh` again after every `web/build.sh`. Needs PHP 7.2+; on Apache/LiteSpeed the
`.htaccess` sends every request through `index.php` (mod_rewrite).

Checked against the Go server with the same requests under PHP 7.2 (built-in server) and PHP 8.3
(Apache, at the root and in a subfolder): the page, the bundle, the payload, its listing, byte
ranges and errors answer the same, byte for byte. What differs is what Apache answers itself before
PHP runs, none of which the page asks for: `/payload` without the slash (redirects to the same
place, with an absolute URL), `/.htaccess` (403 rather than 404), and unclean paths such as `/../x`,
which Go redirects and PHP or Apache refuse.

## Use

The page explains both methods in Persian and English (switch at the top, Persian first); buttons and live
messages stay in English.


1. Serve `web/` over HTTPS (or `localhost`) — WebUSB needs a secure context and desktop Chrome/Edge.
2. On the phone: Developer options → **USB debugging** and **USB debugging (Security settings)** on.
3. **Stop the local `adb` server first** (`adb kill-server`). WebUSB needs exclusive access to the phone; it cannot share with a running adb daemon.
4. Open the page → Connect → accept the prompt on the phone → *Install helper* → *Start watching*.
5. The phone now records every call by itself. Unplug if you like. *Load recordings* to play/download.

## Two ways to record

The page checks the phone on connect and says which one applies.

- **Permanent recording** — the XDA "MIUI dialer on Global ROM" method, no root. Three changes for
  user 0: bring back Xiaomi's dialer (`pm install-existing` `com.android.contacts` +
  `com.android.incallui`), make it the default phone app (`cmd role add-role-holder`), and remove
  the regional overlay `com.android.phone.cust.overlay.miui` (`pm uninstall -k --user 0`), whose
  only resource sets `com.android.phone:bool/config_call_recording` to false. The recorder is then
  a system app: it is set once, **survives reboots** and does not need USB debugging. The customer
  then turns on automatic recording in the Phone app → Settings → Call recording (it is
  `button_auto_record_call` in `Settings.System`; the page reads it and says whether it is on).
  Recordings land in `/sdcard/MIUI/sound_recorder/call_rec/*.mp3`.
  Unlike the XDA guide the page keeps Google Phone and Google Contacts by default: recording works
  with them installed. Ticking "Also remove Google Phone and Google Contacts" removes them as the
  guide does (only after the Xiaomi dialer is confirmed as the phone app), also on a phone that is
  already switched. On the test phones (HyperOS 1, MIUI 12.5) `pm install-existing` and
  `pm uninstall --user 0` worked with MIUI's "USB debugging (Security settings)" off. What it changed is written to `native.baseline` on the phone and *Undo* reverts
  exactly that. It needs a ROM that still ships the Xiaomi dialer: Global builds do, EEA/EU builds
  do not. Verified by hand on a Redmi Note 13 Pro 4G (emerald_global, HyperOS 3, Android 16):
  recorded before and after a reboot, no restart needed to switch it on.
- **Recording helper** — the `callrecd` daemon. Works on any HyperOS phone, but it runs as the ADB
  shell user as a child of adbd, so **a reboot stops it, and so does switching USB debugging or
  Developer options off**. Android gives that user no way to start by itself.
  Reconnecting to the page is enough: it sees the helper was killed (its pid file is still there)
  and starts it again with the flags of its last start (`callrecd.args` on the phone).

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
- If the button cannot be shown, the call is still recorded in full, also with `-auto=false`
  (the helper logs why and carries on).
- No button on HyperOS 3 / Android 16: every call logs `IllegalStateException: Unknown pid=… uid=2000`.
  That is WindowManager's `Session` constructor refusing a process ActivityManager does not know,
  which a shell-started `app_process` always is. Android 14 has no such check.
- HyperOS quirks handled in `InCallButton.prepare()`: MIUI's floating-window whitelist check in
  `WindowManagerGlobal.addView` (fails for uid 2000), its `FramePredict` booster hook, and the
  system fonts that zygote would normally preload.

## Limits

- Needs USB debugging + the Xiaomi "Security settings" debugging toggle (which needs a signed-in Mi account and network on the phone to enable).
- The helper stops at reboot and when USB debugging is switched off. Plug the phone in and click Connect; the page starts it again. Without an
  installed app or root nothing can start it at boot, so only permanent recording avoids this.
- Call detection polls `dumpsys telephony.registry` once a second: ~1 s to start, and it only sees cellular/VoLTE calls, not VoIP apps.
- Android 12/13 record the call fine; VoIP capture generally needs Android 14+.
- Recording calls may be illegal without consent where you are. Your responsibility.
