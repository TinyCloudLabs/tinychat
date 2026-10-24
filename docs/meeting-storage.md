# Meeting storage format

The shared meeting storage format is defined in `packages/core/src/meeting-db/` and exported from `@tinyboilerplate/core`. It describes three SQLite databases, the tables in each, and which database paths a privacy level grants.

## Databases

| Database | Path | Tables |
| --- | --- | --- |
| details | `xyz.tinycloud.tinychat/details` | `meeting`, `meeting_participant`, `meeting_keyword`, `meeting_source_ref`, `connector_state` |
| summaries | `xyz.tinycloud.tinychat/summaries` | `meeting_summary`, `meeting_action_item` |
| transcripts | `xyz.tinycloud.tinychat/transcripts` | `meeting_transcript`, `transcript_segment` |

Constants: `MEETING_DB_DETAILS`, `MEETING_DB_SUMMARIES`, `MEETING_DB_TRANSCRIPTS`. Schemas: `DETAILS_SCHEMA`, `SUMMARIES_SCHEMA`, `TRANSCRIPTS_SCHEMA`. Each schema is an array of `CREATE TABLE IF NOT EXISTS` statements, safe to re-run.

- Rows join across databases by `meeting_id`. There are no cross-database foreign keys.
- The schemas declare no `CREATE INDEX` statements. Lookups rely on primary keys.
- `meeting.schema_version` is `MEETING_DB_SCHEMA_VERSION` (currently `1`).

## Details database

The details database holds metadata only: identifiers, titles, timestamps, counts, flags, participant display fields, keywords, source references and connector state. Summary text, action items, transcript text and payloads belong in the other two databases.

`parseDetailsRow`, `parseParticipantRow`, `parseKeywordRow`, `parseSourceRefRow` and `parseConnectorStateRow` validate a row before it is written:

- Only the declared fields are accepted. Unknown keys throw `MeetingDbRowError`.
- Values must be scalars: strings, safe integers, finite numbers, or `0`/`1` flags. Objects and arrays are rejected.
- Strings are length-limited. Meeting titles are at most 500 characters and keywords at most 100 characters. The other limits are in `rows.ts`.
- The validators return a new object that contains only the declared fields.

## Privacy levels

| Level | Databases granted |
| --- | --- |
| 1 | details |
| 2 (default) | details, summaries |
| 3 | details, summaries, transcripts |

- `databasesForLevel(level)` returns the granted paths. It throws `RangeError` for any value other than `1`, `2` or `3`.
- `assertExactMeetingDbPath(path)` throws unless `path` exactly equals one of the three paths. Trailing slashes, the bare app prefix and other paths are rejected.
- Grants name whole databases. Every granted path passes `assertExactMeetingDbPath`.

## Compatibility

`connector_state` exists in two places with different shapes. The connectors database (`CONNECTOR_SCHEMA` in `connector-meeting.ts`) keeps sync status, error and item count columns. The details database `connector_state` holds only `connector_id`, `last_synced_at` and `status`. The two share the `connector_id`, `status` and `last_synced_at` column names. This module does not migrate or merge them.

## Verification

Tests live in `packages/core/test/meeting-db.test.ts`. They run with `bun test` from `packages/core`, using in-memory SQLite (`bun:sqlite`). They cover DDL execution and idempotence, primary-key and NOT NULL behavior, row validation limits, privacy-level grants, and exact-path assertions.
