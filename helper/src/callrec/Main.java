// Audio capture helper. Runs on the phone as the ADB shell user via:
//   CLASSPATH=callrec.dex app_process / callrec.Main [call|split] [--paused] [--no-button]
// The shell UID (2000) holds CAPTURE_AUDIO_OUTPUT, so it may open the VOICE_CALL /
// VOICE_UPLINK / VOICE_DOWNLINK sources that normal apps cannot (approach taken from
// ShizuCallRecorder's AudioRecordCapture and scrcpy's AudioDirectCapture).
//
// Writes raw PCM s16le 16 kHz to stdout: mono for "call", stereo (L=uplink/you,
// R=downlink/them) for "split". Exits when stdin reaches EOF (parent says stop).
//
// Unless --no-button, it also shows a floating REC button for the call (InCallButton)
// that pauses/resumes the capture; paused stretches are simply not written, so a call
// still gives one file. --paused starts the call paused (record only on tap).
package callrec;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

public final class Main {
    // Voice paths are 16 kHz max on most devices (see ShizuCallRecorder AudioConfig).
    static final int RATE = 16000;
    static final int BLOCK = RATE / 50 * 2; // 20 ms of mono PCM16

    private static final Object LOCK = new Object();
    private static volatile boolean wanted; // set by the button, applied by the capture thread
    private static volatile long written;   // PCM bytes sent to the daemon
    private static volatile int channels = 1;

    public static void main(String[] args) {
        String mode = "call";
        boolean paused = false, button = true;
        for (String a : args) {
            if ("--paused".equals(a)) {
                paused = true;
            } else if ("--no-button".equals(a)) {
                button = false;
            } else {
                mode = a;
            }
        }
        try {
            Workarounds.apply();
            AudioRecord[] recs = "split".equals(mode)
                    ? new AudioRecord[]{open(MediaRecorder.AudioSource.VOICE_UPLINK), open(MediaRecorder.AudioSource.VOICE_DOWNLINK)}
                    : new AudioRecord[]{open(MediaRecorder.AudioSource.VOICE_CALL)};
            channels = recs.length;
            wanted = !paused;

            String m = mode;
            Thread capture = new Thread(() -> {
                try {
                    capture(recs, m);
                } catch (Throwable t) {
                    fatal(t);
                }
            }, "callrec-capture");
            capture.start();

            Thread stopper = new Thread(() -> {
                try {
                    while (System.in.read() != -1) { /* drain */ }
                } catch (IOException ignored) {
                }
                System.exit(0);
            });
            stopper.setDaemon(true);
            stopper.start();

            if (button) {
                InCallButton.run(); // main looper; returns only if the button fails
            }
            capture.join();
        } catch (Throwable t) {
            fatal(t);
        }
        System.exit(0);
    }

    // The default crash handler hangs under app_process (no ActivityManager link), so exit ourselves.
    static void fatal(Throwable t) {
        System.err.println("callrec: fatal: " + t);
        t.printStackTrace();
        System.exit(1);
    }

    static boolean recording() {
        return wanted;
    }

    static void setRecording(boolean on) {
        synchronized (LOCK) {
            wanted = on;
            LOCK.notifyAll();
        }
    }

    static long recordedMillis() {
        return written * 1000 / (RATE * 2L * channels);
    }

    // Runs on its own thread so the AudioRecords are only ever touched here: a toggle
    // from the button just flips `wanted`, and this loop starts/stops them between blocks.
    static void capture(AudioRecord[] recs, String mode) throws IOException, InterruptedException {
        OutputStream out = new FileOutputStream(FileDescriptor.out);
        byte[][] bufs = new byte[recs.length][BLOCK];
        byte[] frame = new byte[BLOCK * recs.length];
        boolean active = false;
        try {
            while (true) {
                boolean want = wanted;
                if (want != active) {
                    for (AudioRecord r : recs) {
                        if (want) {
                            r.startRecording();
                        } else {
                            r.stop();
                        }
                    }
                    for (AudioRecord r : recs) {
                        if (want && r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                            throw new IllegalStateException("startRecording failed for source " + r.getAudioSource());
                        }
                    }
                    active = want;
                    System.err.println("callrec: " + (want ? "recording" : "paused") + " mode=" + mode + " sdk=" + Build.VERSION.SDK_INT);
                }
                if (!active) {
                    synchronized (LOCK) {
                        while (!wanted) {
                            LOCK.wait();
                        }
                    }
                    continue;
                }

                for (int i = 0; i < recs.length; i++) {
                    readFully(recs[i], bufs[i]);
                }
                if (recs.length == 1) {
                    out.write(bufs[0]);
                    written += BLOCK;
                    continue;
                }
                for (int s = 0; s < BLOCK; s += 2) { // interleave 16-bit samples L,R
                    frame[2 * s] = bufs[0][s];
                    frame[2 * s + 1] = bufs[0][s + 1];
                    frame[2 * s + 2] = bufs[1][s];
                    frame[2 * s + 3] = bufs[1][s + 1];
                }
                out.write(frame);
                written += frame.length;
            }
        } finally {
            for (AudioRecord r : recs) {
                try {
                    r.stop();
                } catch (IllegalStateException ignored) {
                }
                r.release();
            }
        }
    }

    static void readFully(AudioRecord r, byte[] buf) {
        int off = 0;
        while (off < buf.length) {
            int n = r.read(buf, off, buf.length - off);
            if (n < 0) {
                throw new IllegalStateException("AudioRecord.read failed: " + n);
            }
            off += n;
        }
    }

    static AudioRecord open(int source) {
        AudioFormat fmt = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build();
        AudioRecord.Builder b = new AudioRecord.Builder().setAudioSource(source).setAudioFormat(fmt);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setContext(FakeContext.get()); // attribute the capture to com.android.shell
        }
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min > 0) {
            b.setBufferSizeInBytes(8 * min);
        }
        AudioRecord r = b.build();
        if (r.getState() != AudioRecord.STATE_INITIALIZED) {
            r.release();
            throw new IllegalStateException("AudioRecord init failed for source " + source);
        }
        return r;
    }
}
