// app_process starts a bare runtime with no ActivityThread/Application. AudioRecord
// (and AudioFlinger's AttributionSource checks) expect one, so we fake it with
// reflection. Same steps as scrcpy's Workarounds (Apache-2.0) and ShizuCallRecorder's
// ShellWorkarounds.
package callrec;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Looper;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

final class Workarounds {
    private static final Class<?> ACTIVITY_THREAD_CLASS;
    private static final Object ACTIVITY_THREAD;

    static {
        Looper.prepareMainLooper(); // ActivityThread's constructor creates a Handler
        try {
            ACTIVITY_THREAD_CLASS = Class.forName("android.app.ActivityThread");
            Constructor<?> ctor = ACTIVITY_THREAD_CLASS.getDeclaredConstructor();
            ctor.setAccessible(true);
            ACTIVITY_THREAD = ctor.newInstance();
            set("sCurrentActivityThread", null, ACTIVITY_THREAD);
            Field systemThread = ACTIVITY_THREAD_CLASS.getDeclaredField("mSystemThread");
            systemThread.setAccessible(true);
            systemThread.setBoolean(ACTIVITY_THREAD, true);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private Workarounds() {
    }

    static void apply() {
        if (Build.VERSION.SDK_INT >= 31) {
            fillConfigurationController();
        }
        fillAppInfo();
        fillAppContext();
    }

    static Context getSystemContext() {
        try {
            Method m = ACTIVITY_THREAD_CLASS.getDeclaredMethod("getSystemContext");
            return (Context) m.invoke(ACTIVITY_THREAD);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static void fillAppInfo() {
        try {
            Class<?> bindDataClass = Class.forName("android.app.ActivityThread$AppBindData");
            Constructor<?> ctor = bindDataClass.getDeclaredConstructor();
            ctor.setAccessible(true);
            Object bindData = ctor.newInstance();

            ApplicationInfo info = new ApplicationInfo();
            info.packageName = FakeContext.PACKAGE_NAME;
            Field appInfo = bindDataClass.getDeclaredField("appInfo");
            appInfo.setAccessible(true);
            appInfo.set(bindData, info);

            set("mBoundApplication", ACTIVITY_THREAD, bindData);
        } catch (Throwable t) {
            System.err.println("callrec: fillAppInfo failed (non fatal): " + t);
        }
    }

    private static void fillAppContext() {
        try {
            Application app = new Application();
            Method attach = ContextWrapper.class.getDeclaredMethod("attachBaseContext", Context.class);
            attach.setAccessible(true);
            attach.invoke(app, FakeContext.get());
            set("mInitialApplication", ACTIVITY_THREAD, app);
        } catch (Throwable t) {
            System.err.println("callrec: fillAppContext failed (non fatal): " + t);
        }
    }

    private static void fillConfigurationController() {
        try {
            Class<?> ccClass = Class.forName("android.app.ConfigurationController");
            Class<?> internalClass = Class.forName("android.app.ActivityThreadInternal");
            Constructor<?> ctor = ccClass.getDeclaredConstructor(internalClass);
            ctor.setAccessible(true);
            set("mConfigurationController", ACTIVITY_THREAD, ctor.newInstance(ACTIVITY_THREAD));
        } catch (Throwable t) {
            System.err.println("callrec: fillConfigurationController failed (non fatal): " + t);
        }
    }

    private static void set(String field, Object target, Object value) throws Exception {
        Field f = ACTIVITY_THREAD_CLASS.getDeclaredField(field);
        f.setAccessible(true);
        f.set(target, value);
    }
}
