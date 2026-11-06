// The feed rig's fixture, resolved at build time by vite.feed-rig.config.ts: the committed
// feed-fixture.json, or a merged copy when FEED_RIG_FIXTURE names one.
declare module "feed-rig-fixture" {
  const fixture: unknown;
  export default fixture;
}
