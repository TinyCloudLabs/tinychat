# Connector key volume operations

Mount the dedicated named volume only in the TinyChat backend service. Use one backend writer and keep the volume attached across backend redeploys. The backend UID owns the key file, which uses mode `0600`.
Set `CONNECTOR_KEY_STORE_DIR` to the volume mount path.

Exclude the volume from backups and snapshots, including CVM disk snapshots that would capture it. Keep its contents out of diagnostics, logs, and health responses.

If the volume is lost, initialize a fresh volume. The next startup generates fresh keys. Previously sealed meeting data becomes unreadable and is removed by retention maintenance. Owners with stored Fireflies sign-ins need to sign in again.

Details: TC-2778
