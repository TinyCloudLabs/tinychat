// motion's animation features (layout, shared layoutId, gestures, drag) in a chunk of their own (TC-2882): the feed's
// `m` components render at once without them and start animating once this has loaded (MotionFeatures).
export { domMax as default } from "motion/react";
