// A 14px Halo for a row: nine ticks that fill with ink clockwise as the note moves through its steps, with a "!"
// when something needs the user. Nothing at all once the note is done.
import type { NotePipeline, StepKey } from "@/lib/voiceNotes/notePipeline";

export const HALO_TICKS = 9;
export type HaloTick = "filled" | "partial" | "empty";

const HALO_STEPS: readonly StepKey[] = ["space", "transcript", "notes"];

/** How many of the nine ticks each visible step owns: 3 each for three steps, 5 and 4 for two, all 9 for one. */
function tickShares(count: number): number[] {
  const base = Math.floor(HALO_TICKS / count);
  const extra = HALO_TICKS % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The nine ticks, clockwise from the top. The phone step owns none: a note is on its way once it is recorded. */
export function haloTicks(pipeline: NotePipeline): HaloTick[] {
  const steps = pipeline.steps.filter((step) => HALO_STEPS.includes(step.key) && step.state !== "skipped");
  if (steps.length === 0) return Array.from({ length: HALO_TICKS }, () => "empty");
  const ticks: HaloTick[] = [];
  const shares = tickShares(steps.length);
  steps.forEach((step, index) => {
    const share = shares[index]!;
    for (let i = 0; i < share; i++) {
      if (step.state === "done") ticks.push("filled");
      else if (step.state === "active") {
        const units = (step.progress ?? 0) * share;
        ticks.push(i < Math.floor(units) ? "filled" : i === Math.floor(units) ? "partial" : "empty");
      } else ticks.push("empty");
    }
  });
  return ticks;
}

const TICK_INNER = 4.4;
const TICK_OUTER = 6.6;

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
      role="img"
      aria-label={haloLabel(pipeline)}
      data-pipeline-halo=""
      data-needs-you={needsYou ? "" : undefined}
    >
      {ticks.map((tick, index) => {
        const angle = (index / HALO_TICKS) * 2 * Math.PI;
        const sin = Math.sin(angle);
        const cos = -Math.cos(angle);
        return (
          <line
            key={index}
            data-tick={tick}
            x1={7 + sin * TICK_INNER}
            y1={7 + cos * TICK_INNER}
            x2={7 + sin * TICK_OUTER}
            y2={7 + cos * TICK_OUTER}
            stroke={tick === "empty" ? "var(--line)" : "var(--ink)"}
            strokeOpacity={tick === "partial" ? 0.5 : 1}
            strokeWidth={1.25}
            strokeLinecap="round"
          />
        );
      })}
      {needsYou && (
        <g data-halo-bang="">
          <path d="M7 4.6 V7.6" stroke="var(--ink)" strokeWidth={1.25} strokeLinecap="round" fill="none" />
          <circle cx={7} cy={9.4} r={0.8} fill="var(--ink)" />
        </g>
      )}
    </svg>
  );
}
