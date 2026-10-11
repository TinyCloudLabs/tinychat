// A 14px Halo for a row (design §8): three clusters of three short rim ticks around a faint disc, filling with ink
// clockwise from 12 o'clock as the note moves through its steps, with a "!" when something needs the user. Two tones
// only, whole ticks only, never animated. Nothing at all once the note is done.
import type { NotePipeline, StepKey } from "@/lib/voiceNotes/notePipeline";

export const HALO_TICKS = 9;
export type HaloTick = "filled" | "empty";

const HALO_STEPS: readonly StepKey[] = ["space", "transcript", "notes"];

/** How many of the nine ticks each visible step owns: 3 each for three steps, 5 and 4 for two, all 9 for one. */
function tickShares(count: number): number[] {
  const base = Math.floor(HALO_TICKS / count);
  const extra = HALO_TICKS % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The nine ticks in clockwise order from 12 o'clock. The phone step owns none: a note is on its way once it is
 * recorded. A done step fills all its ticks; an active step fills at least one and never all of them (1 or 2 of 3),
 * by its progress, so an unfinished step never looks finished.
 */
export function haloTicks(pipeline: NotePipeline): HaloTick[] {
  const steps = pipeline.steps.filter((step) => HALO_STEPS.includes(step.key) && step.state !== "skipped");
  if (steps.length === 0) return Array.from({ length: HALO_TICKS }, () => "empty");
  const ticks: HaloTick[] = [];
  const shares = tickShares(steps.length);
  steps.forEach((step, index) => {
    const share = shares[index]!;
    const filled =
      step.state === "done" ? share
      : step.state === "active" ? Math.min(share - 1, Math.max(1, Math.floor((step.progress ?? 0) * share)))
      : 0;
    for (let i = 0; i < share; i++) ticks.push(i < filled ? "filled" : "empty");
  });
  return ticks;
}

const CENTER = 7;
const TICK_INNER = 4.6;
const TICK_OUTER = 6.4;
const TICK_STEP_DEG = 24;
const CLUSTER_PERIOD_DEG = 120;
/** The gap between the last and first clusters (72°) is centred at 12 o'clock, so the first tick sits half a gap past it. */
const FIRST_TICK_DEG = 36;

/** Degrees clockwise from 12 o'clock for tick `index` (0..8). */
export const tickAngle = (index: number): number =>
  FIRST_TICK_DEG + Math.floor(index / 3) * CLUSTER_PERIOD_DEG + (index % 3) * TICK_STEP_DEG;

export function haloLabel(pipeline: NotePipeline): string {
  const step = pipeline.steps.find((candidate) => candidate.key === pipeline.current);
  return pipeline.blocker?.cause ?? step?.caption ?? step?.label ?? "In progress";
}

export function PipelineHalo(props: { pipeline: NotePipeline; className?: string }) {
  const { pipeline } = props;
  if (pipeline.done) return null;
  const ticks = haloTicks(pipeline);
  const needsYou = pipeline.blocker !== undefined;
  return (
    <svg
      className={props.className}
      width={14}
      height={14}
      viewBox="0 0 14 14"
      overflow="visible"
      role="img"
      aria-label={haloLabel(pipeline)}
      data-pipeline-halo=""
      data-needs-you={needsYou ? "" : undefined}
    >
      {!needsYou && <circle data-halo-disc="" cx={CENTER} cy={CENTER} r={2} fill="var(--dim)" fillOpacity={0.25} />}
      {ticks.map((tick, index) => {
        const radians = (tickAngle(index) * Math.PI) / 180;
        const sin = Math.sin(radians);
        const cos = -Math.cos(radians);
        return (
          <line
            key={index}
            data-tick={tick}
            x1={(CENTER + sin * TICK_INNER).toFixed(3)}
            y1={(CENTER + cos * TICK_INNER).toFixed(3)}
            x2={(CENTER + sin * TICK_OUTER).toFixed(3)}
            y2={(CENTER + cos * TICK_OUTER).toFixed(3)}
            stroke={tick === "filled" ? "var(--ink)" : "var(--dim)"}
            strokeOpacity={tick === "filled" ? 1 : 0.3}
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        );
      })}
      {needsYou && (
        <g data-halo-bang="">
          <path d="M7 5.4 V7.2" stroke="var(--ink)" strokeWidth={1.1} strokeLinecap="round" fill="none" />
          <circle cx={7} cy={8.6} r={0.65} fill="var(--ink)" />
        </g>
      )}
    </svg>
  );
}
