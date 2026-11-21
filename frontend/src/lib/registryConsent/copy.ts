// TC-3547: every word the registry-publish consent and the Home finish-setup banner show, and the one switch that lets
// them show.
//
// DRAFT COPY. The consent words are the policy owner's draft with her rulings applied (the product is TinyCloud One;
// the body names the spaces; the line after "Not now" lives on the banner). They have not been approved, so everything is
// OFF: `REGISTRY_CONSENT_MODAL_ENABLED` stays false and nothing in the app registers the consent callback, calls the SDK
// to publish, reads the `finish-setup` link or shows the banner, until the approved words replace these and this one
// constant is flipped. Only this file changes then; a test pins the switch off.
//
// Strings marked DRAFT-AWAITING-WORDS are placeholders: the policy owner has not supplied the final words for them yet.
// Do not ship them.

/** False until the approved words are in this file. The production build must not show the consent or the banner. */
export const REGISTRY_CONSENT_MODAL_ENABLED: boolean = false;

export const REGISTRY_CONSENT_COPY = {
  title: "Let your apps find your space",
  body:
    "To use TinyCloud apps outside TinyCloud One, we publish a public record that links your account address to the server that holds your space. " +
    "Anyone who knows your account address can see it, along with the names of your spaces. It doesn't include any of your content.",
  publish: "Publish and continue",
  notNow: "Not now",
  /** The rows under the body, from the SDK's preview (see preview.ts for how each value is derived). */
  previewLabels: {
    subject: "Your account address",
    host: "Server that holds your space",
    address: "Server address",
    space: "Space name",
  },
} as const;

/** The Home card that offers the consent again, shown only to an unregistered account that has not said "Not now". */
export const FINISH_SETUP_BANNER_COPY = {
  /** DRAFT-AWAITING-WORDS: the heading. */
  lead: "Finish setting up your account",
  /** The line the policy owner moved here from the dialog: the dialog has no place to show it after "Not now". */
  support: "Apps outside TinyCloud One can't find your space until you publish this.",
  /** DRAFT-AWAITING-WORDS: the button that opens the consent. */
  action: "Finish setup",
} as const;
