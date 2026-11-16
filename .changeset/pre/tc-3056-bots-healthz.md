---
---

The bots deploy checks the service's /healthz the way the backend reaches it: through the TLS passthrough host, with the certificate checked against the service's own domain. Details: TC-3056.
