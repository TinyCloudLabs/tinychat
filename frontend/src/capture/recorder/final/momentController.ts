import {
  appendLine,
  momentLine,
  momentTime,
  removeLine,
  replaceLine,
} from "./momentLines";

export interface MomentDeps {
  /** The recording time in ms, taken now. */
  markMoment(): number | Promise<number>;
  readMd(): string;
  writeMd(md: string): void;
  onError(error: unknown): void;
}

/** What the field under the timer shows; null while no moment is being noted. */
export interface MomentField {
  /** The time the moment was marked at, `m:ss`; null until `markMoment` answers. */
  time: string | null;
}

interface Active {
  atMs: number | null;
  draft: string;
  index: number;
  failed: boolean;
}

/**
 * Noting a moment: the time is taken at the tap, a bare `- **m:ss**` line is written as soon as it is known (a bookmark
 * even if the app dies mid-type), and the text replaces it on save. Cancel removes the line.
 */
export function createMomentFlow(
  deps: MomentDeps,
  onChange: (field: MomentField | null) => void,
) {
  let active: Active | null = null;
  // Note edits run in the order of the taps, even when `markMoment` answers late.
  let tail: Promise<void> = Promise.resolve();
  const show = () =>
    onChange(
      active
        ? { time: active.atMs === null ? null : momentTime(active.atMs) }
        : null,
    );

  return {
    begin(): void {
      if (active) this.commit();
      const marked = deps.markMoment();
      const moment: Active = {
        atMs: typeof marked === "number" ? marked : null,
        draft: "",
        index: -1,
        failed: false,
      };
      active = moment;
      show();
      tail = tail
        .then(() => marked)
        .then(
          (atMs) => {
            moment.atMs = atMs;
            const next = appendLine(deps.readMd(), momentLine(atMs, ""));
            moment.index = next.index;
            deps.writeMd(next.md);
            if (active === moment) show();
          },
          (error: unknown) => {
            moment.failed = true;
            if (active === moment) {
              active = null;
              show();
            }
            deps.onError(error);
          },
        );
    },
    type(draft: string): void {
      if (active) active.draft = draft;
    },
    commit(): void {
      const moment = active;
      if (!moment) return;
      active = null;
      show();
      tail = tail.then(() => {
        if (moment.failed) return;
        deps.writeMd(
          replaceLine(
            deps.readMd(),
            moment.index,
            momentLine(moment.atMs!, moment.draft),
          ),
        );
      });
    },
    cancel(): void {
      const moment = active;
      if (!moment) return;
      active = null;
      show();
      tail = tail.then(() => {
        if (moment.failed) return;
        deps.writeMd(removeLine(deps.readMd(), moment.index));
      });
    },
    isOpen: () => active !== null,
    /** Resolves once every queued note edit has been written. */
    settled: () => tail,
  };
}

export type MomentFlow = ReturnType<typeof createMomentFlow>;
