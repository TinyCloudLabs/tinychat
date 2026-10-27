# Frozen meeting-answer eval (v1)

A versioned, deterministic set of meeting-answer cases that can score any chat backend: Eliza today, the MCP-backed wrapper later. It makes no network calls and uses synthetic data only.

```sh
bun run eval:mcp                       # answer-key self-check over all offered models
bun run eval:mcp --backend=eliza       # Eliza stub: every model reports NOT RUN
bun run eval:mcp --models=z-ai/glm-5.3 --json
bun test backend/scripts/mcp-eval/mcp-eval.test.ts
```

Exit code is 0 only if the gate passes for every model.

## What is frozen

- `cases.json`: 95 cases. 90 come from `backend/scripts/meeting-eval-fixtures.ts` (30 scenarios x 3 paraphrases, evidence read through the existing fixture service). 5 come from Eliza's answer tests and the TC-2163 size-limit test at tinycloud-agents `ed320bda0fd40ecbf1f0088719d2fd8392ddb919`. Each case records question, history, fixture meetings with evidence ids, expectations (required facts, citable evidence, citation syntax, `### Coverage` section, public sources, size-limit) and its origin.
- `manifest.json`: version, case count, sha256 of `cases.json`. The runner refuses to run if the hash differs. Change the set only by bumping `VERSION` in `generate-cases.ts` and regenerating (a new version, with a new baseline).
- Size-limit case: 501 transcript-heavy rows, regenerated deterministically at run time (over 20 MiB of raw metadata) with the question "List my three most recent meetings."

Citation syntax: `[M1:E1]` or `[M1:E1, Speaker, hh:mm:ss]` (speaker and time must match the evidence); metadata answers may use `[M1]`. Public links are `[title](url)`.

## Backend interface

`types.ts`: `ChatBackend { id; models(); answer(question, fixtureSpace) }`, where `answer` returns `{ text, toolErrors? }`. A backend that cannot answer throws `BackendUnavailableError`; the model is recorded as NOT RUN, never as a pass or fail.

Built-in backends (`backends.ts`):

- `answer-key`: builds answers from the case expectations. It checks that the scorer accepts a correct answer for every case. Its numbers are not a baseline.
- `eliza`: **STUB, does not work.** The current Eliza path (`backend/src/agent-task-client.ts`, `POST /tasks`) needs a live Eliza service, a user delegation and a paid model provider, and there is no loader that puts the fixture space into Eliza storage. It always reports NOT RUN.

## Gate (docs/plans/mcp-chat-cutover.md)

Per model, in `runner.ts` (`GATE_THRESHOLDS`, `evaluateGate`):

1. pass rate >= 95%;
2. no regression vs the recorded baseline: pass rate not lower and no case that passed in the baseline fails;
3. 0 size-limit errors on the size-limit case.

A check that cannot be evaluated (baseline NOT RUN, model NOT RUN) is `not_evaluable` and the gate does not pass.

## Recorded Eliza baseline

`baseline/eliza-ed320bd.json`. Frozen-eval per-model numbers: **NOT RUN**, because they need Eliza answering with a real model (live service, delegation, paid provider) and no adapter exists. Eliza's own deterministic suite at that commit (`bun test --preload ../../test/no-spend-setup.ts` in `packages/eliza-service`, no model calls) ran: 601 pass, 0 fail, 42 files. Those are unit tests of validators and evidence code, not per-model scores.

To record real numbers: implement a working `ChatBackend` for Eliza (or the MCP wrapper), run it under an explicit budget, and write the result into the baseline file as `status: "recorded"` with per-model `passRate` and `cases`.

Details: TC-2197
