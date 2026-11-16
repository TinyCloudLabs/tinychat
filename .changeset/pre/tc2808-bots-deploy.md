---
"@tinychat/backend": patch
---

Backend deploys pass the tiny bots settings (BOTS_ENABLED, BOTS_TEST_ACCOUNTS, BOTS_SERVICE_URL, BOTS_SERVICE_SECRET, BOTS_POST_TIMEOUT_MS) to the backend CVM; BOTS_ENABLED defaults to false. A new workflow, deploy-bots-phala.yml, deploys the bots service to its own CVM. Details: TC-2808
