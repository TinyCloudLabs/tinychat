/** `size` is the disc diameter and layout box; a centered 1.75× canvas bleeds outside it without shifting layout. */
export { HaloRing } from "./HaloRing";
export type { HaloRingProps } from "./HaloRing";
export {
  LevelBars,
  MirroredSpectrumBars,
  mirroredBandIndex,
} from "./LevelBars";
export type { LevelBarsProps, MirroredSpectrumBarsProps } from "./LevelBars";
export {
  LevelSourceAdapter,
  QUIET,
  sourceFromLevel,
  whitenSpectrum,
} from "./source";
/** Push samples here; HaloRing reads the latest source each render frame, without React state. */
export type { HaloSource, HaloSourceSubscriber } from "./source";
/** Test hooks: the render path in use and how many draws reached a ring's canvas since it was last cleared. */
export { haloDrawCount, haloRenderPath } from "./renderer";
