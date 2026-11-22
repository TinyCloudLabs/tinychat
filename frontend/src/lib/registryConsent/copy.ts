// TC-3547: every word the registry-publish consent and the Home finish-setup banner show, and the one switch that lets
// them show.
//
// The product is TinyCloud One; the body names the spaces; the line after "Not now" is on the banner. The switch is on.
// The consent callback registers, the SDK publishes
// on approval, the `finish-setup` link is read and the banner shows, each only when the pinned SDK carries the hook
// (see intent.ts and config.ts).

/** True: the consent and the Home banner show whenever the pinned SDK supports them. */
export const REGISTRY_CONSENT_MODAL_ENABLED: boolean = true;

export const REGISTRY_CONSENT_COPY = {
  title: "Let your apps find your space",
  body:
    "To use TinyCloud apps outside TinyCloud One, publish a public record that links your account address to the server that holds your space. " +
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
  lead: "Let your apps find your space",
  /** On the banner, because the dialog has no place to show it after "Not now". */
  support: "Apps outside TinyCloud One can't find your space until you publish this.",
  action: "Review and publish",
} as const;
