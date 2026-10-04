package xyz.tinycloud.exo.health;

import static xyz.tinycloud.exo.health.HealthPlugin.HEART_RATE;
import static xyz.tinycloud.exo.health.HealthPlugin.SLEEP;
import static xyz.tinycloud.exo.health.HealthPlugin.STEPS;
import static xyz.tinycloud.exo.health.HealthPlugin.readPermission;
import static xyz.tinycloud.exo.health.HealthPlugin.writePermission;

import androidx.annotation.RequiresApi;
import androidx.health.connect.client.HealthConnectClient;
import androidx.health.connect.client.aggregate.AggregateMetric;
import androidx.health.connect.client.aggregate.AggregationResult;
import androidx.health.connect.client.aggregate.AggregationResultGroupedByPeriod;
import androidx.health.connect.client.records.HeartRateRecord;
import androidx.health.connect.client.records.Record;
import androidx.health.connect.client.records.SleepSessionRecord;
import androidx.health.connect.client.records.StepsRecord;
import androidx.health.connect.client.records.metadata.DataOrigin;
import androidx.health.connect.client.records.metadata.Metadata;
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest;
import androidx.health.connect.client.request.ReadRecordsRequest;
import androidx.health.connect.client.response.ReadRecordsResponse;
import androidx.health.connect.client.time.TimeRangeFilter;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.Period;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import kotlin.jvm.JvmClassMappingKt;
import kotlinx.coroutines.CoroutineScope;
import org.json.JSONObject;

/**
 * The Health Connect reads and writes behind HealthPlugin. java.time is used freely here; HealthPlugin only creates
 * this class after confirming Health Connect is available, which implies Android 9+.
 */
@RequiresApi(26)
final class HealthConnectReader {

    /** Asleep time excludes these stages when a session has stages. */
    private static final Set<Integer> AWAKE_STAGES = new HashSet<>(
        Arrays.asList(
            SleepSessionRecord.STAGE_TYPE_AWAKE,
            SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
            SleepSessionRecord.STAGE_TYPE_OUT_OF_BED
        )
    );

    private final CoroutineScope scope;
    private final HealthConnectClient client;

    HealthConnectReader(CoroutineScope scope, HealthConnectClient client) {
        this.scope = scope;
        this.client = client;
    }

    /** A sleep interval counts for day D when it ends between 18:00 on D-1 and 18:00 on D (same rule as iOS). */
    private static final int SLEEP_DAY_START_HOUR = 18;

    private static final class Day {

        Long steps;
        final List<long[]> sleep = new ArrayList<>();
        Long heartRateMin;
        Long heartRateAvg;
        Long heartRateMax;
        final Set<String> sources = new TreeSet<>();
    }

    /**
     * Steps and heart rate are Health Connect aggregates bucketed by local day (Health Connect de-duplicates
     * overlapping sources by the user's app priority list). Sleep is read as sessions: the asleep parts (the session
     * minus awake stages, or all of it when it has no stages) count for the night they end in (the 18:00 rule above;
     * the night of the 3rd to the 4th is the 4th), and overlapping sessions from two apps count once (union). A type
     * whose read permission is not granted is null and listed in `notGranted`.
     */
    JSObject readDays(Set<String> granted, List<String> types, int days) throws Exception {
        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);
        LocalDate first = today.minusDays(days - 1);
        Map<LocalDate, Day> byDay = new LinkedHashMap<>();
        for (int i = 0; i < days; i++) byDay.put(first.plusDays(i), new Day());

        boolean steps = types.contains(STEPS) && granted.contains(readPermission(STEPS));
        boolean heartRate = types.contains(HEART_RATE) && granted.contains(readPermission(HEART_RATE));
        boolean sleep = types.contains(SLEEP) && granted.contains(readPermission(SLEEP));

        // A metric whose read permission is missing fails the whole request, so ask only for granted ones.
        Set<AggregateMetric<?>> metrics = new HashSet<>();
        if (steps) metrics.add(StepsRecord.COUNT_TOTAL);
        if (heartRate) {
            metrics.add(HeartRateRecord.BPM_MIN);
            metrics.add(HeartRateRecord.BPM_AVG);
            metrics.add(HeartRateRecord.BPM_MAX);
        }
        if (!metrics.isEmpty()) {
            AggregateGroupByPeriodRequest request = new AggregateGroupByPeriodRequest(
                metrics,
                TimeRangeFilter.between(first.atStartOfDay(), today.plusDays(1).atStartOfDay()),
                Period.ofDays(1),
                Collections.<DataOrigin>emptySet()
            );
            List<AggregationResultGroupedByPeriod> groups = Suspend.await(scope, continuation ->
                client.aggregateGroupByPeriod(request, continuation)
            );
            for (AggregationResultGroupedByPeriod group : groups) {
                Day day = byDay.get(group.getStartTime().toLocalDate());
                if (day == null) continue;
                AggregationResult result = group.getResult();
                if (steps) day.steps = result.get(StepsRecord.COUNT_TOTAL);
                if (heartRate) {
                    day.heartRateMin = result.get(HeartRateRecord.BPM_MIN);
                    day.heartRateAvg = result.get(HeartRateRecord.BPM_AVG);
                    day.heartRateMax = result.get(HeartRateRecord.BPM_MAX);
                }
                for (DataOrigin origin : result.getDataOrigins()) day.sources.add(origin.getPackageName());
            }
        }
        if (sleep) readSleep(byDay, first, today, zone);

        JSArray out = new JSArray();
        for (Map.Entry<LocalDate, Day> entry : byDay.entrySet()) {
            Day day = entry.getValue();
            JSObject json = new JSObject();
            json.put("date", entry.getKey().toString());
            // JSONObject drops a key put with null; JSONObject.NULL keeps it as JSON null.
            if (types.contains(STEPS)) json.put("steps", steps && day.steps != null ? day.steps : JSONObject.NULL);
            if (types.contains(SLEEP)) {
                long[] asleep = union(day.sleep);
                json.put("sleepMinutes", asleep[1] > 0 ? (Object) (asleep[0] / 60_000) : JSONObject.NULL);
                json.put("sleepBlocks", asleep[1]);
            }
            if (types.contains(HEART_RATE)) {
                if (heartRate && day.heartRateAvg != null) {
                    JSObject bpm = new JSObject();
                    bpm.put("min", day.heartRateMin);
                    bpm.put("avg", day.heartRateAvg);
                    bpm.put("max", day.heartRateMax);
                    json.put("heartRate", bpm);
                } else {
                    json.put("heartRate", JSONObject.NULL);
                }
            }
            json.put("sources", new JSArray(day.sources));
            out.put(json);
        }
        JSArray notGranted = new JSArray();
        if (types.contains(STEPS) && !steps) notGranted.put(STEPS);
        if (types.contains(SLEEP) && !sleep) notGranted.put(SLEEP);
        if (types.contains(HEART_RATE) && !heartRate) notGranted.put(HEART_RATE);

        JSObject ret = new JSObject();
        ret.put("platform", "android");
        ret.put("source", "health_connect");
        ret.put("timeZone", zone.getId());
        ret.put("readAt", System.currentTimeMillis());
        ret.put("notGranted", notGranted);
        ret.put("days", out);
        return ret;
    }

    private void readSleep(Map<LocalDate, Day> byDay, LocalDate first, LocalDate today, ZoneId zone) throws Exception {
        // Sessions overlapping [18:00 the day before the first day, 18:00 today]: every night that can count.
        TimeRangeFilter range = TimeRangeFilter.between(
            first.minusDays(1).atTime(SLEEP_DAY_START_HOUR, 0),
            today.atTime(SLEEP_DAY_START_HOUR, 0)
        );
        String pageToken = null;
        do {
            ReadRecordsRequest<SleepSessionRecord> request = new ReadRecordsRequest<>(
                JvmClassMappingKt.getKotlinClass(SleepSessionRecord.class),
                range,
                Collections.<DataOrigin>emptySet(),
                true,
                1000,
                pageToken
            );
            ReadRecordsResponse<SleepSessionRecord> response = Suspend.await(scope, continuation -> client.readRecords(request, continuation));
            for (SleepSessionRecord session : response.getRecords()) {
                ZoneOffset offset = session.getEndZoneOffset();
                List<long[]> asleep = new ArrayList<>();
                if (session.getStages().isEmpty()) {
                    asleep.add(new long[] { session.getStartTime().toEpochMilli(), session.getEndTime().toEpochMilli() });
                } else {
                    for (SleepSessionRecord.Stage stage : session.getStages()) {
                        if (AWAKE_STAGES.contains(stage.getStage())) continue;
                        asleep.add(new long[] { stage.getStartTime().toEpochMilli(), stage.getEndTime().toEpochMilli() });
                    }
                }
                for (long[] interval : asleep) {
                    Instant end = Instant.ofEpochMilli(interval[1]);
                    LocalDate night = (offset != null ? end.atOffset(offset).toLocalDateTime() : end.atZone(zone).toLocalDateTime())
                        .plusHours(24 - SLEEP_DAY_START_HOUR)
                        .toLocalDate();
                    Day day = byDay.get(night);
                    if (day == null) continue;
                    day.sleep.add(interval);
                    day.sources.add(session.getMetadata().getDataOrigin().getPackageName());
                }
            }
            pageToken = response.getPageToken();
        } while (pageToken != null && !pageToken.isEmpty());
    }

    /** { asleep milliseconds in the union of the intervals, number of separate blocks in that union }. */
    private static long[] union(List<long[]> intervals) {
        List<long[]> sorted = new ArrayList<>(intervals);
        Collections.sort(sorted, (a, b) -> Long.compare(a[0], b[0]));
        long total = 0;
        long blocks = 0;
        long[] open = null;
        for (long[] interval : sorted) {
            if (open != null && interval[0] <= open[1]) {
                open[1] = Math.max(open[1], interval[1]);
            } else {
                if (open != null) total += open[1] - open[0];
                open = new long[] { interval[0], interval[1] };
                blocks += 1;
            }
        }
        if (open != null) total += open[1] - open[0];
        return new long[] { total, blocks };
    }

    /** Inserts the sample records the granted write permissions allow; returns how many (0 = no write permission). */
    int insertSampleData(Set<String> granted) throws Exception {
        List<Record> records = sampleRecords(granted);
        if (records.isEmpty()) return 0;
        Suspend.await(scope, continuation -> client.insertRecords(records, continuation));
        return records.size();
    }

    private static List<Record> sampleRecords(Set<String> granted) {
        ZoneId zone = ZoneId.systemDefault();
        Instant now = Instant.now();
        LocalDate today = LocalDate.now(zone);
        List<Record> records = new ArrayList<>();
        for (int i = 0; i < 7; i++) {
            LocalDate day = today.minusDays(i);
            int seed = day.getDayOfYear();
            if (granted.contains(writePermission(STEPS))) {
                for (int hour : new int[] { 8, 12, 18 }) {
                    Instant start = day.atTime(hour, 0).atZone(zone).toInstant();
                    Instant end = start.plus(Duration.ofMinutes(45));
                    if (end.isAfter(now)) continue;
                    long count = 900 + ((seed * 37L + hour * 101L) % 2600);
                    records.add(
                        new StepsRecord(
                            start,
                            offset(zone, start),
                            end,
                            offset(zone, end),
                            count,
                            Metadata.manualEntry("exo-sample-steps-" + day + "-" + hour, 1L)
                        )
                    );
                }
            }
            if (granted.contains(writePermission(HEART_RATE))) {
                Instant start = day.atTime(10, 0).atZone(zone).toInstant();
                Instant end = start.plus(Duration.ofMinutes(6));
                if (!end.isAfter(now)) {
                    List<HeartRateRecord.Sample> samples = new ArrayList<>();
                    for (int k = 0; k < 6; k++) {
                        samples.add(new HeartRateRecord.Sample(start.plusSeconds(60L * k), 58 + ((seed * 7L + k * 5L) % 35)));
                    }
                    records.add(
                        new HeartRateRecord(start, offset(zone, start), end, offset(zone, end), samples, Metadata.manualEntry("exo-sample-hr-" + day, 1L))
                    );
                }
            }
            if (granted.contains(writePermission(SLEEP))) {
                Instant start = day.minusDays(1).atTime(23, 0).plusMinutes(seed % 50).atZone(zone).toInstant();
                Instant end = day.atTime(6, 30).plusMinutes(seed % 40).atZone(zone).toInstant();
                if (!end.isAfter(now)) {
                    records.add(
                        new SleepSessionRecord(
                            start,
                            offset(zone, start),
                            end,
                            offset(zone, end),
                            Metadata.manualEntry("exo-sample-sleep-" + day, 1L),
                            "Exo sample",
                            null,
                            Collections.<SleepSessionRecord.Stage>emptyList()
                        )
                    );
                }
            }
        }
        return records;
    }

    private static ZoneOffset offset(ZoneId zone, Instant instant) {
        return zone.getRules().getOffset(instant);
    }
}
