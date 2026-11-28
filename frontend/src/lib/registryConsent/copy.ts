// TC-3547: every word the Home finish-setup card and the finish-setup notice show. The notice reuses the card's words, so
// a change to them is one edit here.

/** The Home card that offers to publish the owner's registry record, shown only to an unregistered account. */
export const FINISH_SETUP_BANNER_COPY = {
  lead: "Let your apps find your space",
  support:
    "Apps outside TinyCloud One can't find your space until you publish where it lives. " +
    "This is a public record: anyone can see your account address, the names of your spaces and which servers hold them. " +
    "It doesn't include anything stored in your spaces.",
  action: "Publish",
} as const;

/** The notice a finish-setup link opens when the owner did not just read the card: the card's title, body and button. */
export const FINISH_SETUP_NOTICE_COPY = {
  title: FINISH_SETUP_BANNER_COPY.lead,
  body: FINISH_SETUP_BANNER_COPY.support,
  publish: FINISH_SETUP_BANNER_COPY.action,
  cancel: "Cancel",
} as const;
