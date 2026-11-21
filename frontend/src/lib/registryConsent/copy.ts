// TC-3547: every word the registry-publish consent shows, and the one switch that lets it show.
//
// DRAFT COPY. The words below are the draft the policy owner wrote (tc3547-registry-policy-consent-DRAFT.md). They have
// not been approved, so the consent is OFF: `REGISTRY_CONSENT_MODAL_ENABLED` stays false and nothing in the app
// registers the consent callback, calls the SDK to publish, or reads the `finish-setup` link, until the approved words
// replace these and this one constant is flipped. Only this file changes then; a test pins the switch off.
//
// Open checks from the draft that decide the final words:
//  - [CHECK 1] The record lists the primary space (its URI carries the space name), so the longer second sentence of
//    the body is used. Drop "along with the names of your spaces" if the final record leaves space names out.
//  - [CHECK 3] The draft's line shown after "Not now" ("... You can do it later in Settings.") is not here: no Settings
//    entry exists and nothing shows a line after the dialog closes. Add both if the approved words include it.
//  - The labels of the preview rows are not in the draft; they name each value as the TinyChat lead described it.

/** False until the approved words are in this file. The production build must not show the consent. */
export const REGISTRY_CONSENT_MODAL_ENABLED: boolean = false;

export const REGISTRY_CONSENT_COPY = {
  title: "Let your apps find your space",
  body:
    "To use TinyCloud apps outside TinyCloud Home, we publish a public record that links your account address to the server that holds your space. " +
    "Anyone who knows your account address can see it, along with the names of your spaces. It doesn't include any of your content.",
  publish: "Publish and continue",
  notNow: "Not now",
  previewLabels: {
    subject: "Your account address",
    nodeDid: "node.tinycloud.xyz address",
    nodeOrigin: "Server web address",
    space: "Your Feed space",
  },
} as const;
