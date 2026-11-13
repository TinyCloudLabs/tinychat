---
"@tinychat/frontend": patch
---

Opening Home no longer runs schema checks or table creation in front of its first reads. The chat list and settings read at once on a new device; only a read that finds its table missing creates the tables and reads again, and the full schema check runs in the background after the open's reads. Voice-note setup (its two schema statements and definition check) runs once per account and schema version on each device, after the open's reads when there is nothing to save, instead of on every open; later opens only sweep archived duplicates in the background.
