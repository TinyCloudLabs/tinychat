package xyz.tinycloud.exo.health;

import android.app.Activity;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * What Health Connect shows when the user taps "Read privacy policy" (or the app's info) on its permission screen.
 * Health Connect requires an app to handle these intents, or it refuses the permission request without showing
 * anything:
 *   - Android 13 and lower (the Health Connect app): action androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE;
 *   - Android 14+ (Health Connect in the platform): action android.intent.action.VIEW_PERMISSION_USAGE, category
 *     android.intent.category.HEALTH_PERMISSIONS, through an activity-alias guarded by START_VIEW_PERMISSION_USAGE.
 * Both are declared in src/debug/AndroidManifest.xml only (health spike, TC-525). Google Play expects this screen to
 * be, or link to, the app's privacy policy; Exo has none yet, so this is the spike's placeholder text.
 */
public class HealthPermissionsRationaleActivity extends Activity {

    static final String TEXT =
        "Exo and Health Connect (development preview)\n\n" +
        "Exo reads the steps, sleep and heart rate you allow, and only while you use the health preview. " +
        "It turns them into one summary per day (step count, minutes asleep, lowest, average and highest heart rate, " +
        "and which apps recorded them) and saves the summaries to your own TinyCloud space, which only you and the " +
        "apps you authorize can read.\n\n" +
        "Exo does not sell this data, use it for advertising, or share it with anyone. You can turn access off at any " +
        "time in Health Connect, and delete the summaries from your space.\n\n" +
        "This preview has no published privacy policy yet; one is required before Exo can ask anyone outside the team " +
        "for health data.";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("Exo and Health Connect");
        int padding = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24, getResources().getDisplayMetrics());

        TextView text = new TextView(this);
        text.setText(TEXT);
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        text.setLineSpacing(0, 1.2f);

        Button close = new Button(this);
        close.setText("Close");
        close.setOnClickListener(v -> finish());

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(padding, padding, padding, padding);
        column.addView(text);
        column.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ScrollView scroll = new ScrollView(this);
        scroll.setFitsSystemWindows(true);
        scroll.addView(column);
        setContentView(scroll);
    }
}
