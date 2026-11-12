// Floating REC button shown for the length of a call, like the record button in
// Samsung's in-call screen. The dialer on these ROMs (Google Phone) has no record
// button we could reuse, so the helper draws its own overlay window: the shell UID
// holds SYSTEM_ALERT_WINDOW, INTERNAL_SYSTEM_WINDOW and SYSTEM_APPLICATION_OVERLAY.
//
// Tap toggles recording, drag moves it (position kept in button.pos next to the dex).
// Any failure here only loses the button; the recording keeps going without it.
package callrec;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.hardware.display.DisplayManager;
import android.os.Looper;
import android.view.Display;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

final class InCallButton extends View {
    private static final int SIZE_DP = 60;
    private static final int RED = 0xF0E53935;
    private static final int GREY = 0xE6374047;

    private final WindowManager wm;
    private final WindowManager.LayoutParams lp;
    private final float dp;
    private final boolean text; // false if fonts could not be loaded: drawText would abort hwui
    private final int screenW, screenH, slop;
    private final File posFile;
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();

    private float downX, downY;
    private int startX, startY;
    private boolean dragging;

    /** Shows the button and runs the main looper. Returns only if the UI fails. */
    static void run() {
        InCallButton b = null;
        try {
            boolean text = prepare();
            Context sys = FakeContext.get();
            Display d = sys.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
            Context ctx = sys.createDisplayContext(d);
            b = new InCallButton(ctx, d, text);
            b.wm.addView(b, b.lp);
            System.err.println("callrec: in-call button shown");
            Looper.loop();
        } catch (Throwable t) {
            System.err.println("callrec: in-call button failed, recording continues without it: " + t);
            if (b != null && b.isAttachedToWindow()) {
                try {
                    b.wm.removeViewImmediate(b);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    // app_process skips what zygote and bindApplication normally set up for a UI.
    // Returns whether text can be drawn.
    private static boolean prepare() {
        // MIUI: WindowManagerGlobal.addView consults a floating-window whitelist through
        // Settings as package "android", which a uid 2000 caller is refused. We are not a
        // MIUI floating window, so switch that check off.
        try {
            Field f = Class.forName("android.view.FloatingWindowInternalImpl").getDeclaredField("enable_floating_window");
            f.setAccessible(true);
            f.setBoolean(null, false);
        } catch (Throwable ignored) { // not MIUI/HyperOS
        }
        // MIUI: FramePredict registers with the booster service using a context we do not
        // have, logging an NPE. Mark it initialised so it stays idle.
        try {
            Class<?> c = Class.forName("android.view.FramePredict");
            Object inst = c.getMethod("getInstance").invoke(null);
            Field f = c.getDeclaredField("isInit");
            f.setAccessible(true);
            f.setBoolean(inst, true);
        } catch (Throwable ignored) {
        }
        // Zygote preloads the system fonts; without that the first drawText aborts natively.
        try {
            Method m = Typeface.class.getDeclaredMethod("loadPreinstalledSystemFontMap");
            m.setAccessible(true);
            m.invoke(null);
            return true;
        } catch (Throwable t) {
            System.err.println("callrec: no fonts, button without text: " + t);
            return false;
        }
    }

    @SuppressWarnings("deprecation") // FLAG_SHOW_WHEN_LOCKED, getRealSize: still the API for non-activity windows
    private InCallButton(Context ctx, Display d, boolean text) {
        super(ctx);
        this.text = text;
        wm = ctx.getSystemService(WindowManager.class);
        dp = ctx.getResources().getDisplayMetrics().density;
        slop = ViewConfiguration.get(ctx).getScaledTouchSlop();
        Point size = new Point();
        d.getRealSize(size);
        screenW = size.x;
        screenH = size.y;
        posFile = new File(new File(System.getenv("CLASSPATH")).getParentFile(), "button.pos");

        int px = (int) (SIZE_DP * dp);
        lp = new WindowManager.LayoutParams(px, px, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED, // the in-call screen also shows over the lock screen
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.setFitInsetsTypes(0); // x/y are plain screen coordinates
        lp.packageName = FakeContext.PACKAGE_NAME;
        lp.setTitle("callrec-button");
        try { // keep showing over apps that hide third-party overlays
            WindowManager.LayoutParams.class.getMethod("setSystemApplicationOverlay", boolean.class).invoke(lp, true);
        } catch (Throwable ignored) {
        }
        lp.x = screenW - px - (int) (12 * dp);
        lp.y = screenH / 4;
        loadPosition();

        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeWidth(1.5f * dp);
        ring.setColor(0x66FFFFFF);
        ink.setColor(0xFFFFFFFF);
        ink.setTextAlign(Paint.Align.CENTER);
        ink.setFakeBoldText(true);
        ink.setTextSize(12 * dp);
        setContentDescription("Call recording");
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            invalidate();
            postDelayed(this, 500);
        }
    };

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        post(tick);
    }

    @Override
    protected void onDetachedFromWindow() {
        removeCallbacks(tick);
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        boolean on = Main.recording();
        float w = getWidth(), cx = w / 2f, r = w / 2f - 2 * dp;
        fill.setColor(on ? RED : GREY);
        c.drawCircle(cx, cx, r, fill);
        c.drawCircle(cx, cx, r, ring);

        float iconY = text ? cx - 7 * dp : cx;
        if (on) { // stop square: tap to stop
            float h = 7 * dp;
            rect.set(cx - h, iconY - h, cx + h, iconY + h);
            ink.setColor(0xFFFFFFFF);
            c.drawRoundRect(rect, 2.5f * dp, 2.5f * dp, ink);
        } else { // red dot: tap to record
            ink.setColor(0xFFFF5252);
            c.drawCircle(cx, iconY, 8 * dp, ink);
        }
        if (text) {
            ink.setColor(0xFFFFFFFF);
            String label;
            if (on) {
                long s = Main.recordedMillis() / 1000;
                label = String.format("%d:%02d", s / 60, s % 60);
            } else {
                label = "REC";
            }
            c.drawText(label, cx, cx + 17 * dp, ink);
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = e.getRawX();
                downY = e.getRawY();
                startX = lp.x;
                startY = lp.y;
                dragging = false;
                return true;
            case MotionEvent.ACTION_MOVE:
                float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                if (dragging || Math.hypot(dx, dy) > slop) {
                    dragging = true;
                    moveTo(startX + (int) dx, startY + (int) dy);
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (dragging) {
                    savePosition();
                } else {
                    Main.setRecording(!Main.recording());
                    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                    invalidate();
                }
                return true;
            case MotionEvent.ACTION_CANCEL:
                return true;
        }
        return false;
    }

    private void moveTo(int x, int y) {
        lp.x = Math.max(0, Math.min(x, screenW - lp.width));
        lp.y = Math.max(0, Math.min(y, screenH - lp.height));
        if (isAttachedToWindow()) {
            wm.updateViewLayout(this, lp);
        }
    }

    private void loadPosition() {
        try {
            String[] xy = new String(Files.readAllBytes(posFile.toPath()), StandardCharsets.US_ASCII).trim().split("\\s+");
            moveTo(Integer.parseInt(xy[0]), Integer.parseInt(xy[1]));
        } catch (Throwable ignored) { // first run or bad file: keep the default spot
        }
    }

    private void savePosition() {
        try (FileOutputStream out = new FileOutputStream(posFile)) {
            out.write((lp.x + " " + lp.y + "\n").getBytes(StandardCharsets.US_ASCII));
        } catch (Throwable t) {
            System.err.println("callrec: save button position: " + t);
        }
    }
}
