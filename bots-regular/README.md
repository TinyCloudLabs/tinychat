# Regular bots runtime

The regular runtime runs Free bots. It has the same internal API, manifests, bot states and history journal as the
bots service in [`../bots`](../bots/README.md); it reuses that code. The difference is where a bot runs: each bot is
one sandbox on a [gke-sandboxes](https://github.com/comp-work/gke-sandboxes) cluster on Google Cloud
(`@getenergy/gke-sandboxes` 0.3.0, Apache-2.0), not a gVisor sandbox on the service's own machine.

Regular bots are not confidential: their files are on Google Cloud, readable by TinyCloud and Google.

## How a bot runs

- **One bot, one sandbox.** The sandbox id is `bot-` and the first 52 characters of the bot's id (a hash of the owner
  and the bot's key). It is built only from that id, never from a request.
- **Bridge.** OMP speaks its RPC on stdin and stdout, and the cluster runs commands with stdin closed. So every sandbox
  starts a small bridge (`sandbox/bridge.ts`) that holds OMP's stdio and offers it on port 7070 as one WebSocket.
- **Tokens, fresh for every start.** The service makes a new bridge token and a new gateway token each time it starts
  a bot. It hands them to the sandbox through the cluster's exec channel (`sandbox/arm.ts`), so they live in the
  bridge's memory only: never in the sandbox's files, its labels or a snapshot. The bridge takes one connection, the
  service's, with that bridge token. OMP gets the gateway token.
- **Gateway.** The model gateway is the bots service's own, in a container beside the service and the only holder of
  the model key. Sandboxes reach it at `/bots/<bot id>/v1/...`; a bot's token opens its own path only. Sandboxes
  reach nothing else (see the network policy below).
- **Sleep and wake.** A bot sleeps after 5 idle minutes (`BOTS_IDLE_MS`): the service stops OMP and asks the cluster
  to save the sandbox's files to a snapshot and remove its pod. The next message wakes it from that snapshot, with
  new tokens. If the service cannot put it to sleep, the cluster's own sweeper does after 5 minutes without use.
- **What survives a sleep:** the files only. OMP starts again on wake and opens its saved session. Files written
  since the last sleep are lost if the cluster loses the pod first.
- **Deleting** a bot's working state deletes its sandbox and every snapshot of it first. If that fails, nothing is
  deleted locally and the deletion is logged as failed.
- **Calls.** The service takes only calls the backend signed for the regular environment with this service's own
  secret, `BOTS_REGULAR_SERVICE_SECRET`. It refuses the private runtime's secret, calls signed for the private
  runtime, and the old owner header. It holds no permission for an owner's history space.

## Environment

Service container (`bun src/main.ts`):

| Name | Notes |
| --- | --- |
| `BOTS_REGULAR_SERVICE_SECRET` | Required. This service's own 256-bit secret. Never the private runtime's. |
| `BOTS_TEST_ACCOUNTS` | Addresses allowed to use the service, comma separated, or `*`. |
| `BOTS_REGULAR_PROVIDER` | Required. `gke`, or `local` for the local check only. |
| `BOTS_REGULAR_SANDBOX_IMAGE` | Required with `gke`. The sandbox image, pinned by digest. |
| `BOTS_REGULAR_KUBERNETES_URL` | Default `https://kubernetes.default.svc`. |
| `BOTS_REGULAR_NAMESPACE` | Default `sandboxes`. |
| `BOTS_REGULAR_SANDBOX_SERVICE_ACCOUNT` | Default `sandbox`. |
| `BOTS_REGULAR_GATEWAY_ORIGIN` | Required. The gateway as sandboxes reach it, `http://<host>:<port>`. |
| `BOTS_REGULAR_GATEWAY_CONTROL_SOCKET` | Default `/run/gateway/control.sock`. |
| `BOTS_REGULAR_START_TIMEOUT_MS` | Default 180000. Waking a sandbox, arming its bridge and OMP's start. |
| `BOTS_REGULAR_TOUCH_MS` | Default 60000. How often a running sandbox is marked in use. |
| `BOTS_REGULAR_LOCAL_ROOT`, `BOTS_REGULAR_LOCAL_AGENT` | Required with `local`. |
| `NODE_EXTRA_CA_CERTS` | The cluster's certificate authority. |
| `PORT`, `BOTS_MODEL`, `BOTS_IDLE_MS`, `BOTS_DATA_ROOT`, `BOTS_RUN_ROOT`, `BOTS_MAX_RUNNING`, `BOTS_TURN_TIMEOUT_MS`, `BOTS_MAX_TURN_BYTES`, `BOTS_RETENTION_DAYS`, `BOTS_HISTORY_ENABLED`, `BOTS_HISTORY_SIGNER_DID`, `BOTS_HISTORY_NODE_ORIGIN`, `BOTS_UNARCHIVED_HISTORY_POLICY` | As in the bots service. `BOTS_IDLE_MS` defaults to 300000 here. |

Gateway container (`bun src/gateway-main.ts`):

| Name | Notes |
| --- | --- |
| `REDPILL_API_KEY` | Required. The model key. |
| `BOTS_REGULAR_GATEWAY_PORT` | Default 8081. |
| `BOTS_REGULAR_GATEWAY_CONTROL_SOCKET` | Default `/run/gateway/control.sock`. |
| `BOTS_BUDGET_FILE`, `BOTS_OWNERS_FILE`, `BOTS_MODEL`, `BOTS_MODELS`, `BOTS_MAX_TOKENS`, `BOTS_BOT_DAILY_TOKENS`, `BOTS_OWNER_DAILY_TOKENS`, `BOTS_GLOBAL_DAILY_TOKENS`, `BOTS_MAX_BODY_BYTES`, `BOTS_MAX_RESPONSE_BYTES`, `BOTS_UPSTREAM_CONNECT_TIMEOUT_MS`, `BOTS_UPSTREAM_TOTAL_TIMEOUT_MS`, `BOTS_BODY_TIMEOUT_MS`, `BOTS_HISTORY_ENABLED` | As in the bots service's gateway. |

## Tests

```sh
(cd ../bots && bun install --frozen-lockfile)
bun install --frozen-lockfile
bun test src
bunx tsc --noEmit
```

The tests run real bridges on this machine with a stand-in agent (`test/fake-agent.ts`) in place of OMP, through
`LocalProvider`. They never reach Google Cloud.

## Run it on this machine

`LocalProvider` runs each sandbox as a local bridge process, with a directory standing in for its files and snapshot.
It is for checks only: bots are not isolated from each other or from the machine.

```sh
export BOTS_REGULAR_SERVICE_SECRET="$(openssl rand -hex 32)"   # a throwaway value for this run
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

Calls must be signed as the backend signs them (`signedCallHeader` in `../bots/src/signed-call.ts`, environment
`regular`).

## Deploying

The cluster comes first: the gke-sandboxes infrastructure and its manifests, applied and verified with the library's
`examples/verify.ts` (its `docs/deploy.md`). Then, with `kubectl` pointed at that cluster:

1. **Workflow settings.** In the repository's `regular-bots` environment, set these variables (no secrets):
   `BOTS_REGULAR_GCP_PROJECT`, `BOTS_REGULAR_GCP_REGION`, `BOTS_REGULAR_GKE_CLUSTER` (for example
   `sandboxes-staging`), `BOTS_REGULAR_REGISTRY` (an Artifact Registry repository,
   `<region>-docker.pkg.dev/<project>/<repository>`), `BOTS_REGULAR_WIF_PROVIDER` and
   `BOTS_REGULAR_DEPLOY_SERVICE_ACCOUNT` (a workload identity provider for this repository and the service account it
   may act as; that account needs Artifact Registry writer and Kubernetes developer on the project).
2. **The Secret, by hand, never in chat:**
   ```sh
   kubectl create namespace bots-regular
   kubectl create secret generic bots-regular -n bots-regular \
     --from-literal=BOTS_REGULAR_SERVICE_SECRET="$(openssl rand -hex 32)" \
     --from-literal=REDPILL_API_KEY="<the model key>"
   ```
   The backend needs the same `BOTS_REGULAR_SERVICE_SECRET` value to sign its calls.
3. **Deploy:** `gh workflow run deploy-bots-regular-gke.yml --ref main -f ref=<full main SHA>`. It builds both images,
   applies `deploy/bots-regular.yaml` with their digests and waits for the rollout.
   *See:* the run's summary names the commit and both image digests, and
   `kubectl get pods -n bots-regular` shows one pod with 2/2 containers ready.

The service reaches the cluster API with its own Kubernetes service account, bound to the library's
`sandbox-controller` Role in the `sandboxes` namespace (as the library's sweeper is). It needs no Google key and does
not act as the controller account.

The internal API is the `bots-regular` Service on port 8080 inside the cluster. Reaching it from the backend needs
your own ingress with TLS; that is not in these manifests.

### ⚠️ The network policy must be applied after the library's manifests

The library's own policy, also named `sandboxes`, lets every sandbox reach the whole internet. Network policies add
up, so a second policy cannot narrow it. `deploy/bots-regular.yaml` therefore **replaces** it under the same name:
sandboxes may resolve names and reach the gateway's port, nothing else, and only the service may reach a sandbox's
bridge. **Re-applying the library's manifests** (`terraform -chdir=infra output -raw manifests | kubectl apply -f -`)
**puts the wider policy back.** After any such run, apply `deploy/bots-regular.yaml` again (or re-run the deploy
workflow) and run the real check below; its "cannot reach the internet" step fails while the wider policy is in place.

Keep the library's sweeper on the same package version as this service: Terraform's `sweeper_package` at
`@getenergy/gke-sandboxes@0.3.0`.

### Real cluster check

Opt-in, by hand, against the deployed service. It starts one throwaway bot under a random owner and sends it two
short messages, so it spends a few model tokens and a few minutes of a sandbox. Run it from your machine with
`kubectl` pointed at the cluster:

```sh
kubectl exec -n bots-regular deploy/bots-regular -c service -- \
  env BOTS_REGULAR_REAL_CHECK=1 bun scripts/real-cluster-check.ts
```

*See:* one line per step, then `REAL CHECK PASSED`:

```
sandbox bot-<52 hex>, started <time>
ok   start a bot and get a reply: done b-<number>, reply "ok"
ok   bridge refuses a call without this launch's token: no token 401, another token 401
ok   sandbox cannot reach the internet: blocked
ok   sandbox reaches the gateway, which refuses another bot's path: status 403
ok   bot goes to sleep: stopped; sandbox saved and its pod removed
ok   bot wakes with its files: done b-<number>, 4 messages listed after waking
ok   deleting the bot deletes its sandbox and snapshots: deleted
REAL CHECK PASSED in <seconds> s
```

A failed step prints `FAIL <step>: <what it saw>` and `REAL CHECK FAILED`, and exits 1. The check deletes its bot's
sandbox and snapshots either way; `kubectl get pods,podsnapshots -n sandboxes` should not list its sandbox id after.
