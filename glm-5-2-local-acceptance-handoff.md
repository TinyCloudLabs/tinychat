# GLM 5.2 local acceptance handoff

This is a local, logged-in acceptance run for the GLM 5.2 cutover. Do not deploy, merge, expose secrets, or claim inference quality before completing the browser run below.

## 1. Confirm the checkout

From the repository root:

```bash
git fetch origin
test "$(git branch --show-current)" = "chore/redpill-glm-5-2"
git merge-base --is-ancestor f1c5781 HEAD
git show --no-patch --oneline f1c5781
git status --short
```

Expect commit `f1c5781 chore: switch RedPill default to GLM 5.2` in the branch history. Stop if the branch is wrong or tracked files are unexpectedly dirty.

## 2. Install and build

Prerequisites: Git, Bun 1.3.9 (the version pinned in `package.json`), and a normal browser with a working OpenKey/passkey login. Then run:

```bash
bun install --frozen-lockfile
test -f backend/.env || bun run generate-key
test -f frontend/.env || cp frontend/.env.example frontend/.env
bun run build:backend
bun run build:frontend
```

Do not put `REDPILL_API_KEY` in a command, file, shell history, screenshot, log, issue, or PR. In the terminal that will run the backend, ask the human to enter it without echo and keep it only in that shell:

```bash
read -rsp "REDPILL_API_KEY: " REDPILL_API_KEY; printf '\n'; export REDPILL_API_KEY
```

Do not print the variable. Unset it when finished with `unset REDPILL_API_KEY`.

## 3. Start locally, then stop for the human

In the key-bearing terminal:

```bash
bun run --cwd backend dev
```

In a second terminal:

```bash
bun run --cwd frontend dev
```

Use the URLs printed by the servers (normally `http://localhost:5186` and `http://localhost:3014`; trusted local certificates switch both to HTTPS). Never continue through a certificate warning because WebAuthn will not work there.

**STOP HERE. Explicitly tell the human that the local app is ready, ask them to log in through the browser with OpenKey/passkey, and wait for them to confirm that the signed-in chat is visible. Do not attempt to bypass or automate login.**

## 4. Logged-in GLM 5.2 acceptance

After the human confirms login, keep DevTools Console and Network open, preserve the request log, and run this matrix:

1. **Identity and catalog:** confirm the local models response and chat request select exactly `z-ai/glm-5.2`; confirm streamed completion frames do not report a contradictory model identity. The 2026-08-24 live RedPill catalog check recorded a 1,048,576-token context window, text input/output, reasoning, structured output, tool calling, and TEE routing. It also priced GLM 5.2 about **6.3x higher for input** and **7.5x higher for output** than the prior DeepSeek V4 Flash baseline; record the rates returned today rather than assuming they are unchanged.
2. **Plain streaming:** send `In exactly five numbered steps, explain how a browser verifies an SSE chat stream without buffering the whole response.` Confirm text arrives incrementally, remains ordered, completes once, and leaves no raw SSE or tool markup in the bubble.
3. **Representative prompts:** try all of these and record observations, not a quality verdict:
   - `A job takes 18 minutes on 3 identical workers with perfect scaling. Show the arithmetic for 8 workers and state the idealized answer.`
   - `Return valid JSON only with keys summary, risks, and next_step for: rotating an API key without downtime.`
   - `Rewrite this in a calm, concise tone: We cannot ship until the evidence is reproducible.`
   - In a new turn, ask a specific follow-up about an earlier answer and check that conversation context is used.
4. **Latency and errors:** for each turn capture HTTP status, time to first visible token, total time, any long inter-token stall, retry, cancellation behavior, and any 4xx/5xx/429 or upstream error. Do not hide intermittent failures.
5. **Memory extraction:** state a durable preference such as `Remember that I prefer acceptance reports as compact tables.` Complete a normal reply, allow the background extraction to finish, then inspect the Memory settings and a later turn/new chat for the preference. Confirm the background `/api/chat` request uses an offered model, does not 403, and that its credits—if reported—fold into the receipt as memory upkeep.
6. **Tools, only if locally enabled:** the backend enables `/api/agent` only when `AGENT_DID`, `ELIZA_SERVICE_URL`, and `ELIZA_SERVICE_SECRET` are configured. If the UI offers **Enable agent memory & tools**, ask the human to approve its passkey prompt, then request a current fact that requires web search. Confirm a running/done tool activity chip, a real tool request/result, a final synthesized answer, and no leaked `<tool_call>` markup. Otherwise mark this item `N/A (local agent service disabled)`; do not add credentials or widen scope.
7. **Billing and receipts:** confirm the user and assistant footers appear after completion, input and output shares sum to the charged total, input includes conversation context, and any background memory charge is labeled as upkeep. Compare UI values with the usage/rates network payload and record any missing or stale receipt without inventing a charge.
8. **Honest verification:** GLM 5.2 is TEE-capable but is not allowlisted for a flat per-message response signature. It must not show a green **Response verified** badge or imply that the exact reply bytes were signed. Record the model-level enclave verdict actually shown, including `Not verifiable` or an error. Separately, current backend attestation infrastructure cannot fully bind the compose leg because the backend does not yet serve `app_compose`; Settings must stay at **Quote issued — verification incomplete**, never **Backend attested**, until all three browser proof legs pass.
9. **Browser health:** record every new Console error/warning and failed Network request, including URL path, status, response error code, and whether it affected the user-visible result. Redact tokens, addresses, cookies, authorization headers, and private content from evidence.

## 5. Evidence template

```text
Branch / HEAD:
Included f1c5781: PASS | FAIL
Login completed by human: PASS | FAIL
Catalog + model identity: PASS | FAIL — observed model/rates:
Plain streaming: PASS | FAIL — TTFB / total / stalls:
Representative prompts: PASS | FAIL — factual observations:
Memory extraction: PASS | FAIL — evidence:
Tool calling: PASS | FAIL | N/A — evidence:
Billing / receipts: PASS | FAIL — input + output = total:
Model verification badge honesty: PASS | FAIL — observed tier:
Backend attestation honesty: PASS | FAIL — observed status:
Console / Network: PASS | FAIL — errors/statuses:
Overall local acceptance: PASS | FAIL
Evidence locations (secret-free):
Open issues / reproduction steps:
```

Known automated evidence already recorded for commit `f1c5781` is **1,163 backend tests**, **1,056 frontend tests**, both backend and frontend builds, and lint passing. Treat that as prior automated evidence, not as a substitute for this logged-in run.

When finished, stop both servers and unset the key. Do not deploy or merge; return the completed evidence and any reproducible failures to the human.
