---
"@tinychat/frontend": minor
"exo-desktop": minor
---

Handle a full TinyCloud storage across voice notes: pause audio uploads while full (audio stays on device, marked waiting for space), show "Manage storage" in place of "Save now" with a button that opens the storage management page in the external browser, show a storage warning on Settings and a read-only banner, resume held audio and private transcripts automatically once storage is available again, and keep transcripts whose save failed on storage-full locally until they commit.
