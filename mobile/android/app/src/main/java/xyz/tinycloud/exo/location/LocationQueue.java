package xyz.tinycloud.exo.location;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * On-device queue of location samples and OS-state events, one JSON object per
 * line, each with a monotonically increasing {@code seq}. Native code appends
 * (the WebView may be paused, or gone, while the foreground service records);
 * the web layer reads a page with {@link #read}, writes it to the user's
 * TinyCloud space, then confirms with {@link #ack}. Nothing leaves this queue
 * until that confirmation, so a failed upload or a killed process loses
 * nothing that was already written here.
 *
 * TC-524 spike: a plain file is enough at this rate (one line per fix). A
 * shipped version would want SQLite (Room) for range reads and compaction.
 */
final class LocationQueue {

    /** Oldest entries are dropped past this, and counted in {@link #dropped()}. */
    static final int MAX_ENTRIES = 20_000;

    private static final String PREFS = "xyz.tinycloud.exo.location.queue";
    private static final String PREF_NEXT_SEQ = "nextSeq";
    private static final String PREF_DROPPED = "dropped";

    private final File file;
    private final SharedPreferences prefs;
    private int count;

    LocationQueue(Context context) {
        File dir = new File(context.getFilesDir(), "location");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        file = new File(dir, "queue.jsonl");
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        count = readAll().size();
    }

    /** Appends {@code entry} with the next seq and returns that seq. */
    synchronized long append(JSONObject entry) {
        long seq = prefs.getLong(PREF_NEXT_SEQ, 1);
        prefs.edit().putLong(PREF_NEXT_SEQ, seq + 1).apply();
        try {
            entry.put("seq", seq);
        } catch (JSONException e) {
            return -1;
        }
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write((entry.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            count++;
        } catch (IOException e) {
            return -1;
        }
        if (count > MAX_ENTRIES) {
            List<JSONObject> all = readAll();
            int drop = all.size() - (MAX_ENTRIES * 9) / 10;
            if (drop > 0) {
                prefs.edit().putLong(PREF_DROPPED, dropped() + drop).apply();
                rewrite(all.subList(drop, all.size()));
            }
        }
        return seq;
    }

    /** The oldest {@code limit} entries, oldest first. */
    synchronized List<JSONObject> read(int limit) {
        List<JSONObject> all = readAll();
        return new ArrayList<>(all.subList(0, Math.min(limit, all.size())));
    }

    /** Removes every entry with seq at or below {@code throughSeq}; returns how many are left. */
    synchronized int ack(long throughSeq) {
        List<JSONObject> keep = new ArrayList<>();
        for (JSONObject entry : readAll()) {
            if (entry.optLong("seq", 0) > throughSeq) keep.add(entry);
        }
        rewrite(keep);
        return keep.size();
    }

    synchronized int size() {
        return count;
    }

    long dropped() {
        return prefs.getLong(PREF_DROPPED, 0);
    }

    private List<JSONObject> readAll() {
        List<JSONObject> entries = new ArrayList<>();
        if (!file.isFile()) return entries;
        try (BufferedReader in = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isEmpty()) continue;
                try {
                    entries.add(new JSONObject(line));
                } catch (JSONException e) {
                    // A torn last line (process killed mid-write) is skipped, not fatal.
                }
            }
        } catch (IOException e) {
            // Unreadable queue reads as empty; the file is left for inspection.
        }
        return entries;
    }

    private void rewrite(List<JSONObject> entries) {
        File tmp = new File(file.getParentFile(), "queue.jsonl.tmp");
        try (FileOutputStream out = new FileOutputStream(tmp, false)) {
            for (JSONObject entry : entries) {
                out.write((entry.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException e) {
            return;
        }
        if (tmp.renameTo(file)) count = entries.size();
    }
}
