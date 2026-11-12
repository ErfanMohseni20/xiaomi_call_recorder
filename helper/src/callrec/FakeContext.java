// A Context that identifies as com.android.shell (uid 2000), so the audio server
// accepts our capture request. Mirrors scrcpy's FakeContext (Apache-2.0).
package callrec;

import android.annotation.TargetApi;
import android.content.AttributionSource;
import android.content.Context;
import android.content.ContextWrapper;

public final class FakeContext extends ContextWrapper {
    static final String PACKAGE_NAME = "com.android.shell";
    static final int SHELL_UID = 2000;

    private static FakeContext instance;

    static synchronized FakeContext get() {
        if (instance == null) {
            instance = new FakeContext();
        }
        return instance;
    }

    private FakeContext() {
        super(Workarounds.getSystemContext());
    }

    @Override
    public String getPackageName() {
        return PACKAGE_NAME;
    }

    @Override
    public String getOpPackageName() {
        return PACKAGE_NAME;
    }

    @TargetApi(31)
    @Override
    public AttributionSource getAttributionSource() {
        return new AttributionSource.Builder(SHELL_UID).setPackageName(PACKAGE_NAME).build();
    }

    @Override
    public int getDeviceId() {
        return 0;
    }

    @Override
    public Context getApplicationContext() {
        return this;
    }
}
