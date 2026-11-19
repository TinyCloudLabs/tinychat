# Regular bots runtime

A bots service with the same internal API as [`bots/`](../bots/README.md). It reuses that code: the API, manifests,
bot states and history journal are the same. Each bot runs as one sandbox on a
[gke-sandboxes](https://github.com/comp-work/gke-sandboxes) cluster on Google Cloud (`@getenergy/gke-sandboxes`
0.3.0).

- A bot's sandbox id is `bot-` and the first 52 characters of its bot id.
- Each sandbox starts `sandbox/bridge.ts`, which runs OMP and carries its RPC over a WebSocket on port 7070.
- The model gateway from `bots/` runs in a second container and listens on port 8081 at `/bots/<bot id>/v1/...`.
- A bot sleeps after `BOTS_IDLE_MS` without use (default 5 minutes) and wakes from its snapshot on the next call.
- Deleting a bot's working state deletes its sandbox and snapshots, then its local files.
- The service takes calls signed for the `regular` environment with `BOTS_REGULAR_SERVICE_SECRET`.

## Environment

Service container (`bun src/main.ts`):

| Name | Notes |
| --- | --- |
| `BOTS_REGULAR_SERVICE_SECRET` | Required. This service's own 256-bit secret, different from the bots service's. |
| `BOTS_TEST_ACCOUNTS` | Addresses allowed to use the service, comma separated, or `*`. |
| `BOTS_REGULAR_PROVIDER` | Required. `gke`, or `local` for local runs. |
| `BOTS_REGULAR_SANDBOX_IMAGE` | Required with `gke`. The sandbox image, pinned by digest. |
| `BOTS_REGULAR_KUBERNETES_URL` | Default `https://kubernetes.default.svc`. |
| `BOTS_REGULAR_NAMESPACE` | Default `sandboxes`. |
| `BOTS_REGULAR_SANDBOX_SERVICE_ACCOUNT` | Default `sandbox`. |
| `BOTS_REGULAR_GATEWAY_ORIGIN` | Required. The gateway as sandboxes reach it, `http://<host>:<port>`. |
| `BOTS_REGULAR_GATEWAY_CONTROL_SOCKET` | Default `/run/gateway/control.sock`. |
| `BOTS_REGULAR_START_TIMEOUT_MS` | Default 180000. Starting or waking a sandbox and OMP. |
| `BOTS_REGULAR_TOUCH_MS` | Default 60000. How often a running sandbox is marked in use. |
| `BOTS_REGULAR_LOCAL_ROOT`, `BOTS_REGULAR_LOCAL_AGENT` | Required with `local`. |
| `NODE_EXTRA_CA_CERTS` | The cluster's certificate authority. |
| `BOTS_MAX_RUNNING` | Default 4. Bots awake at once across all machines; a start past it is refused (`bot_unavailable`), not queued. |
| `BOTS_REGULAR_SANDBOX_CPU_REQUEST`, `BOTS_REGULAR_SANDBOX_MEMORY_REQUEST`, `BOTS_REGULAR_SANDBOX_DISK_REQUEST` | Defaults `250m`, `1Gi`, `2Gi`. What each sandbox reserves on its machine. |
| `BOTS_REGULAR_SANDBOX_CPU_LIMIT`, `BOTS_REGULAR_SANDBOX_MEMORY_LIMIT`, `BOTS_REGULAR_SANDBOX_DISK_LIMIT` | Defaults `1`, `2Gi`, `8Gi`. The most each sandbox may use. |
| `PORT`, `BOTS_MODEL`, `BOTS_IDLE_MS`, `BOTS_DATA_ROOT`, `BOTS_RUN_ROOT`, `BOTS_TURN_TIMEOUT_MS`, `BOTS_MAX_TURN_BYTES`, `BOTS_RETENTION_DAYS`, `BOTS_HISTORY_ENABLED`, `BOTS_HISTORY_SIGNER_DID`, `BOTS_HISTORY_NODE_ORIGIN`, `BOTS_UNARCHIVED_HISTORY_POLICY` | As in `bots/`. `BOTS_IDLE_MS` (when an unused bot sleeps) defaults to 300000 here. |

The defaults suit one small sandbox machine (2 vCPU, 8 GB). Kubernetes places sandboxes by their requests, so one
machine holds about its allocatable memory divided by `BOTS_REGULAR_SANDBOX_MEMORY_REQUEST`. Keep `BOTS_MAX_RUNNING`
at or below that number times the machines in the sandbox node pool; the cluster check below measures it.

Gateway container (`bun src/gateway-main.ts`):

| Name | Notes |
| --- | --- |
| `REDPILL_API_KEY` | Required. The model key. |
| `BOTS_REGULAR_GATEWAY_PORT` | Default 8081. |
| `BOTS_REGULAR_GATEWAY_CONTROL_SOCKET` | Default `/run/gateway/control.sock`. |
| `BOTS_BUDGET_FILE`, `BOTS_OWNERS_FILE`, `BOTS_MODEL`, `BOTS_MODELS`, `BOTS_MAX_TOKENS`, `BOTS_BOT_DAILY_TOKENS`, `BOTS_OWNER_DAILY_TOKENS`, `BOTS_GLOBAL_DAILY_TOKENS`, `BOTS_MAX_BODY_BYTES`, `BOTS_MAX_RESPONSE_BYTES`, `BOTS_UPSTREAM_CONNECT_TIMEOUT_MS`, `BOTS_UPSTREAM_TOTAL_TIMEOUT_MS`, `BOTS_BODY_TIMEOUT_MS`, `BOTS_HISTORY_ENABLED` | As in the `bots/` gateway. |

## Tests

```sh
(cd ../bots && bun install --frozen-lockfile)
bun install --frozen-lockfile
bun test src
bunx tsc --noEmit
```

The tests use `LocalProvider`, which runs each sandbox's bridge as a local process, with `test/fake-agent.ts` in
place of OMP.

## Run it locally

```sh
export BOTS_REGULAR_SERVICE_SECRET="$(openssl rand -hex 32)"
export BOTS_TEST_ACCOUNTS='*' BOTS_IDLE_MS=5000 PORT=18080
export BOTS_REGULAR_PROVIDER=local BOTS_REGULAR_LOCAL_ROOT="$PWD/.local-run/host"
export BOTS_REGULAR_LOCAL_AGENT="bun $PWD/test/fake-agent.ts"
export BOTS_DATA_ROOT="$PWD/.local-run/data" BOTS_RUN_ROOT="$PWD/.local-run/run"
export BOTS_REGULAR_GATEWAY_CONTROL_SOCKET="$PWD/.local-run/control.sock" BOTS_REGULAR_GATEWAY_PORT=18081
export BOTS_REGULAR_GATEWAY_ORIGIN=http://127.0.0.1:18081
export REDPILL_API_KEY=unused BOTS_BUDGET_FILE="$PWD/.local-run/budget.json"
mkdir -p .local-run
bun src/gateway-main.ts &
bun src/main.ts
```

Calls are signed as the backend signs them: `signedCallHeader` in `../bots/src/signed-call.ts`, environment
`regular`.

## Deploying

First the cluster: the gke-sandboxes infrastructure and manifests, set up and verified as its `docs/deploy.md`
describes. Then, with `kubectl` pointed at that cluster:

1. **Workflow variables.** In the repository's `regular-bots` environment, set `BOTS_REGULAR_GCP_PROJECT`,
   `BOTS_REGULAR_GCP_REGION`, `BOTS_REGULAR_GKE_CLUSTER` (for example `sandboxes-staging`), `BOTS_REGULAR_REGISTRY`
   (an Artifact Registry repository, `<region>-docker.pkg.dev/<project>/<repository>`), `BOTS_REGULAR_WIF_PROVIDER`
   and `BOTS_REGULAR_DEPLOY_SERVICE_ACCOUNT` (a workload identity provider for this repository, and the service
   account it uses, with Artifact Registry writer and Kubernetes developer on the project).
2. **The cluster Secret**, created by hand:
   ```sh
   kubectl create namespace bots-regular
   kubectl create secret generic bots-regular -n bots-regular \
     --from-literal=BOTS_REGULAR_SERVICE_SECRET="$(openssl rand -hex 32)" \
     --from-literal=REDPILL_API_KEY="<the model key>"
   ```
   The backend signs its calls to this service with the same `BOTS_REGULAR_SERVICE_SECRET` value.
3. **Deploy:** `gh workflow run deploy-bots-regular-gke.yml --ref main -f ref=<full main SHA>`. It builds both
   images, applies `deploy/bots-regular.yaml` with their digests and waits for the rollout.
   *See:* the run's summary lists the commit and both image digests, and `kubectl get pods -n bots-regular` shows one
   pod with 2/2 containers ready.
4. **Order of manifests.** `deploy/bots-regular.yaml` contains a NetworkPolicy named `sandboxes` that takes the place
   of the library's policy with that name. Apply it after the library's manifests. Any later run of
   `terraform -chdir=infra output -raw manifests | kubectl apply -f -` restores the library's policy; apply
   `deploy/bots-regular.yaml` again after it (or re-run the deploy workflow), then run the check below.
5. **Sweeper version.** Keep Terraform's `sweeper_package` at `@getenergy/gke-sandboxes@0.3.0`.

The service uses its own Kubernetes service account, bound to the library's `sandbox-controller` Role in the
`sandboxes` namespace. The internal API is the `bots-regular` Service on port 8080; an ingress with TLS for the
backend is not part of these manifests.

### Cluster check

Run by hand against the deployed service. It starts one bot under a random owner, sends it three short messages
(a few model tokens), and deletes it at the end. With `BOTS_REGULAR_MEASURE_FIT_MAX=<n>` it then starts up to n more
bots, one message each, until one does not start, and deletes them.

```sh
kubectl exec -n bots-regular deploy/bots-regular -c service -- \
  env BOTS_REGULAR_REAL_CHECK=1 BOTS_REGULAR_MEASURE_FIT_MAX=8 bun scripts/real-cluster-check.ts > check.json
```

*See:* one `ok` line per step on stderr, then `REAL CHECK PASSED`.

stdout (`check.json`) is one JSON object:

| Field | What it holds |
| --- | --- |
| `passed`, `error`, `steps` | The result of each step. |
| `resources`, `max_running` | The sizes the service ran with. |
| `cold_start` | A new bot: `acquire_ms` (sandbox created and running; includes adding a machine when the sandbox node pool is at zero) and `turn` (`first_reply_ms`, `total_ms`). |
| `warm_turn` | A second message to the awake bot. |
| `memory` | The sandbox's memory in bytes from its cgroup: `idle` after the first reply, `turn_peak` during the warm turn. `working_set_bytes` leaves out inactive file cache. |
| `sleep_ms` | Putting the bot to sleep (snapshot taken, pod removed). |
| `wake` | The next message: `acquire_ms` (woken from its snapshot) and `turn`. |
| `fit` | With `BOTS_REGULAR_MEASURE_FIT_MAX`: `awake_at_once` bots that started, `acquire_ms` for each, and `first_refusal`. Each one waits up to `BOTS_REGULAR_START_TIMEOUT_MS` for room before it counts as not started. The number counts what the sandbox node pool holds at its maximum size. |

A failed step prints `FAIL <step>: <what it saw>`, then `REAL CHECK FAILED`, and exits 1. The check deletes its
bot's sandbox and snapshots either way; afterwards `kubectl get pods,podsnapshots -n sandboxes` lists nothing with
its sandbox id.
