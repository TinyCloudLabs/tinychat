# Data processing and encryption boundaries

Engineering guidance, checked against TinyChat `7f02ca803b9bb0be3004ff16bb11932abe93fd40`
and node `622e78cfc989134f6c38f2edebe98a9c8791ee89` on 2026-11-27.
Changes on the delivery-unblocking branch are identified below; this document
does not assert that they are deployed.

## Assess the actual path

For each feature, identify the data, authorized reader, key custody, execution
location, outbound destinations, retention and revocation behavior. Device-only
processing, an authorized confidential service, self-hosted processing and an
explicitly authorized external model have different trust boundaries. Assess
each against the user's chosen scope. Historical research cannot itself prohibit
one of these designs or require one model vendor.

Embeddings can disclose source information and need appropriate tenant isolation
and access controls. A shared service is not, solely by being shared, a backdoor.
Do not describe a path as keeping plaintext on the device when a service receives
it. At-rest encryption, transport encryption, end-to-end encryption and protected
execution are separate claims and need evidence for the named data path.

## Chat history

Modern bot history uses the dedicated key and permissions in
`frontend/src/bots/historyAuthorization.ts` and `botHistoryKey.ts`, merged in
PR #1055. A network-wide decrypt permission is not a prerequisite for normal
modern history. Earlier v1 records use a separate, explicit migration flow in
`earlierHistory.ts`; declining that migration does not block ordinary chat.
Manual history loading is a UX decision, not evidence that the dedicated key
does not exist.

## Private reads and approved actions

The delivery-unblocking branch allows a private-data conversation to propose
messages to one or more admitted bots. Proposing sends nothing. The owner's
approval names the digest of the exact owner, sending bot, action kind,
recipients and text shown on the card. The supervisor verifies the stored
payload, and the gateway spends that approval once. A changed binding,
recipient or body, expired/declined proposal or replay does not authorize a send.

This path does not clear the conversation's private-data mark. Direct model
messaging, web requests and secret-backed calls retain their existing export
checks. Further approved destinations need an equally concrete payload and
destination review path; the existence of those checks is not a reason to
disable the owner-approved message path.

## Node storage

The checked node implementation encrypts sensitive metadata columns with a
row-bound v2 format. General KV/SQL artifact sealing is a separate, unfinished
integration. Client-encrypted history and secrets are another layer. Do not use
the phrase "TinyCloud is unencrypted" to substitute for this distinction, or
declare an unrelated feature blocked by the unfinished sealing integration.

## Keep implementation evidence current

Record the source commit for a claimed limitation and the condition that would
retire it. Check current code and existing fixes before carrying a restriction
forward from memory. Distinguish proposed, implemented, merged, released and
deployed. A rejected proposal or closed unmerged PR is not an active requirement.
