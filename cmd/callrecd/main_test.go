package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

func TestOffHook(t *testing.T) {
	idle := "  Phone Id=0\n    mCallState=0\n  Phone Id=1\n    mCallState=0\n"
	ringing := "  Phone Id=0\n    mCallState=1\n"
	sim2InCall := "  Phone Id=0\n    mCallState=0\n  Phone Id=1\n    mCallState=2\n"
	for dump, want := range map[string]bool{idle: false, ringing: false, sim2InCall: true, "": false} {
		if got := offHook(dump); got != want {
			t.Errorf("offHook(%q) = %v, want %v", dump, got, want)
		}
	}
}

func TestWavHeader(t *testing.T) {
	h := wavHeader(2, 16000, 6400)
	if len(h) != 44 || !bytes.Equal(h[0:4], []byte("RIFF")) || !bytes.Equal(h[36:40], []byte("data")) {
		t.Fatalf("bad header %q", h)
	}
	u32 := func(off int) uint32 { return binary.LittleEndian.Uint32(h[off:]) }
	u16 := func(off int) uint16 { return binary.LittleEndian.Uint16(h[off:]) }
	if u32(4) != 36+6400 || u16(22) != 2 || u32(24) != 16000 || u32(28) != 64000 || u16(32) != 4 || u16(34) != 16 || u32(40) != 6400 {
		t.Errorf("wrong fields: riff=%d ch=%d rate=%d byterate=%d align=%d bits=%d data=%d",
			u32(4), u16(22), u32(24), u32(28), u16(32), u16(34), u32(40))
	}
}

func TestHelperArgs(t *testing.T) {
	for _, tc := range []struct {
		o    options
		want string
	}{
		{options{mode: "call", auto: true, button: true}, "/ callrec.Main call"},
		{options{mode: "split", auto: true, button: false}, "/ callrec.Main split --no-button"},
		{options{mode: "call", auto: false, button: true}, "/ callrec.Main call --paused"},
	} {
		if got := strings.Join(tc.o.helperArgs(), " "); got != tc.want {
			t.Errorf("%+v: got %q, want %q", tc.o, got, tc.want)
		}
	}
	if (options{mode: "split"}).channels() != 2 || (options{mode: "call"}).channels() != 1 {
		t.Error("wrong channel count")
	}
}
