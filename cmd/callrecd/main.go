// callrecd is the on-phone part of callrec. It runs as the ADB shell user (uid 2000),
// watches the telephony call state and, during every call, runs the Java capture
// helper (callrec.dex via app_process) and saves its PCM stream as a WAV file.
//
//	callrecd [-dir DIR] [-mode call|split] [-auto=false] [-button=false] start   detach and keep running after USB is unplugged
//	callrecd stop | status | run
//
// During a call the helper shows a floating REC button that pauses/resumes the
// recording; -button=false hides it, -auto=false starts each call paused so only
// calls where the button is tapped get recorded.
//
// It survives USB disconnect (own session, SIGHUP ignored) but not a reboot.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	home    = "/data/local/tmp/callrec"
	pidFile = home + "/callrecd.pid"
	logFile = home + "/callrecd.log"
	dexFile = home + "/callrec.dex"
	rate    = 16000
)

func main() {
	dir := flag.String("dir", "/sdcard/CallRecordings", "where recordings are saved")
	mode := flag.String("mode", "call", "call = mixed mono (VOICE_CALL), split = stereo L=uplink R=downlink")
	auto := flag.Bool("auto", true, "start recording when a call starts (false: wait for a tap on the in-call button)")
	button := flag.Bool("button", true, "show the floating REC button during calls")
	flag.Parse()
	if !*auto && !*button {
		log.Fatal("-auto=false needs the in-call button to start a recording")
	}
	opts := options{dir: *dir, mode: *mode, auto: *auto, button: *button}
	if *mode != "call" && *mode != "split" {
		log.Fatalf("bad -mode %q", *mode)
	}
	// Neither the android nor the linux build picks up the phone's zone on its own, so
	// set it from the system property (the linux/arm build embeds tzdata via -tags timetzdata).
	if out, err := exec.Command("getprop", "persist.sys.timezone").Output(); err == nil {
		if loc, err := time.LoadLocation(strings.TrimSpace(string(out))); err == nil {
			time.Local = loc
		}
	}

	var err error
	switch flag.Arg(0) {
	case "start":
		err = start(opts)
	case "stop":
		err = stop()
	case "status":
		status(*dir)
	case "run":
		err = run(opts)
	default:
		fmt.Fprintln(os.Stderr, "usage: callrecd [-dir DIR] [-mode call|split] [-auto=false] [-button=false] start|stop|status|run")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

type options struct {
	dir, mode    string
	auto, button bool
}

func (o options) channels() int {
	if o.mode == "split" {
		return 2
	}
	return 1
}

// helperArgs is the app_process command line for one call's capture helper.
func (o options) helperArgs() []string {
	args := []string{"/", "callrec.Main", o.mode}
	if !o.auto {
		args = append(args, "--paused")
	}
	if !o.button {
		args = append(args, "--no-button")
	}
	return args
}

// start re-executes this binary as "run" in a new session so it outlives the adb shell.
func start(o options) error {
	if pid := runningPid(); pid > 0 {
		fmt.Println("already running, pid", pid)
		return nil
	}
	if _, err := os.Stat(dexFile); err != nil {
		return fmt.Errorf("helper missing: %w", err)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	lf, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer lf.Close()
	cmd := exec.Command(self, "-dir", o.dir, "-mode", o.mode,
		"-auto="+strconv.FormatBool(o.auto), "-button="+strconv.FormatBool(o.button), "run")
	cmd.Stdout, cmd.Stderr = lf, lf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(cmd.Process.Pid)), 0o644); err != nil {
		return err
	}
	fmt.Println("started, pid", cmd.Process.Pid, "saving to", o.dir, "auto:", o.auto, "button:", o.button)
	return cmd.Process.Release()
}

func stop() error {
	pid := runningPid()
	if pid == 0 {
		fmt.Println("not running")
		return nil
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		return err
	}
	for i := 0; i < 50 && runningPid() > 0; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if runningPid() > 0 {
		return fmt.Errorf("pid %d did not exit", pid)
	}
	fmt.Println("stopped")
	return nil
}

func status(dir string) {
	if pid := runningPid(); pid > 0 {
		fmt.Println("running, pid", pid)
	} else {
		fmt.Println("not running")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.wav"))
	fmt.Println("recordings:", len(files), "in", dir)
}

// runningPid returns the daemon pid, or 0. It checks /proc so a stale pid file
// (reboot, crash) or a recycled pid is not mistaken for a live daemon.
func runningPid() int {
	b, err := os.ReadFile(pidFile)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if pid <= 0 {
		return 0
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil || !strings.Contains(string(cmdline), "callrecd") {
		return 0
	}
	return pid
}

func run(o options) error {
	signal.Ignore(syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM, syscall.SIGINT)
	log.SetFlags(log.LstdFlags)
	log.Printf("callrecd running: dir=%s mode=%s auto=%v button=%v", o.dir, o.mode, o.auto, o.button)

	var rec *recording
	failed := false // don't respawn a failing helper every second for the same call
	// shortcut: polls dumpsys once a second (~1 s start latency, misses VoIP apps); a
	// TelephonyCallback in the Java helper would be event driven if this proves too slow.
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-term:
			if rec != nil {
				rec.stop()
			}
			os.Remove(pidFile)
			log.Print("callrecd stopped")
			return nil
		case <-tick.C:
		}

		active, err := callActive()
		if err != nil {
			log.Print("call state: ", err)
			continue
		}
		switch {
		case active && rec == nil && !failed:
			if rec, err = startRecording(o); err != nil {
				log.Print("start recording: ", err)
				failed = true
			}
		case active && rec != nil && rec.exited():
			log.Print("helper exited during call, see log above")
			rec.stop()
			rec, failed = nil, true
		case !active:
			if rec != nil {
				rec.stop()
				rec = nil
			}
			failed = false
		}
	}
}

var callStateRe = regexp.MustCompile(`mCallState=(\d)`)

func callActive() (bool, error) {
	out, err := exec.Command("dumpsys", "telephony.registry").Output()
	if err != nil {
		return false, err
	}
	return offHook(string(out)), nil
}

// offHook reports whether any SIM slot is in CALL_STATE_OFFHOOK (2).
func offHook(dump string) bool {
	for _, m := range callStateRe.FindAllStringSubmatch(dump, -1) {
		if m[1] == "2" {
			return true
		}
	}
	return false
}

type recording struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	f        *os.File
	channels int
	done     chan error // closed after the PCM copy finishes
	n        int64
}

func startRecording(o options) (*recording, error) {
	if err := os.MkdirAll(o.dir, 0o775); err != nil {
		return nil, err
	}
	channels := o.channels()
	path := filepath.Join(o.dir, time.Now().Format("call_20060102_150405")+".wav")
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(wavHeader(channels, rate, 0)); err != nil {
		f.Close()
		return nil, err
	}

	cmd := exec.Command("/system/bin/app_process", o.helperArgs()...)
	cmd.Env = append(os.Environ(), "CLASSPATH="+dexFile)
	cmd.Stderr = os.Stderr // the daemon log
	stdin, err := cmd.StdinPipe()
	if err != nil {
		f.Close()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		f.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		f.Close()
		os.Remove(path)
		return nil, err
	}

	r := &recording{cmd: cmd, stdin: stdin, f: f, channels: channels, done: make(chan error, 1)}
	go func() {
		n, err := io.Copy(f, stdout)
		r.n = n
		r.done <- err
		close(r.done)
	}()
	log.Printf("recording -> %s", path)
	return r, nil
}

func (r *recording) exited() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

// stop asks the helper to exit (stdin EOF), waits for the stream to drain, then
// patches the WAV sizes. Empty recordings are deleted.
func (r *recording) stop() {
	r.stdin.Close()
	select {
	case <-r.done:
	case <-time.After(3 * time.Second):
		r.cmd.Process.Kill()
		<-r.done
	}
	r.cmd.Wait()

	path := r.f.Name()
	_, err := r.f.WriteAt(wavHeader(r.channels, rate, uint32(r.n)), 0)
	err = errors.Join(err, r.f.Close())
	if r.n == 0 {
		os.Remove(path)
		log.Printf("nothing recorded, removed %s", path)
		return
	}
	if err != nil {
		log.Printf("finalize %s: %v", path, err)
		return
	}
	log.Printf("saved %s (%.1fs)", path, float64(r.n)/float64(rate*2*r.channels))
}

// wavHeader returns a 44-byte PCM16 WAV header for dataLen bytes of audio.
func wavHeader(channels, sampleRate int, dataLen uint32) []byte {
	h := make([]byte, 44)
	le32 := func(off int, v uint32) {
		h[off], h[off+1], h[off+2], h[off+3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
	}
	le16 := func(off int, v uint16) { h[off], h[off+1] = byte(v), byte(v>>8) }
	blockAlign := channels * 2
	copy(h[0:], "RIFF")
	le32(4, 36+dataLen)
	copy(h[8:], "WAVEfmt ")
	le32(16, 16)
	le16(20, 1) // PCM
	le16(22, uint16(channels))
	le32(24, uint32(sampleRate))
	le32(28, uint32(sampleRate*blockAlign))
	le16(32, uint16(blockAlign))
	le16(34, 16)
	copy(h[36:], "data")
	le32(40, dataLen)
	return h
}
