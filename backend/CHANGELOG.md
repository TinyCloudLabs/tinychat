# @tinychat/backend

## 0.2.0-beta.0

### Minor Changes

- 2eecb38: Private cloud transcription API for Exo desktop (`/api/transcriber/private-cloud`), dark by default: `PRIVATE_CLOUD_TRANSCRIPTION_ENABLED` plus an account allowlist gate the routes. The backend creates batch jobs on the private transcription service with an HMAC tenant reference instead of the wallet address, returns a relative upload path with a job-scoped capability (audio goes straight from the desktop to the service), and relays status, results, cancel and delete with stable error codes and correlation ids.

### Patch Changes

- e822748: Expose backendRevision and backendVersion in /api/server-info so deploys can prove the new build is live.
