import {
  LockKeyholeIcon,
  CpuIcon,
  BadgeCheckIcon,
  EyeOffIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface Point {
  icon: LucideIcon;
  title: string;
  body: string;
}

const POINTS: Point[] = [
  {
    icon: CpuIcon,
    title: "Hardware enclaves",
    body: "Inference runs on confidential NVIDIA GPUs inside Intel TDX / AMD SEV virtual machines. Enclave memory is encrypted — the host OS can't read it.",
  },
  {
    icon: BadgeCheckIcon,
    title: "Remote attestation",
    body: "Each response is signed inside the enclave, so you can verify the exact model ran in a genuine TEE — not a logged or swapped-out copy.",
  },
  {
    icon: EyeOffIcon,
    title: "No silent logging",
    body: "Your prompt is decrypted only inside the enclave. The people running the GPUs can't inspect, store, or train on your conversations.",
  },
];

export function Confidential() {
  return (
    <section id="confidential" className="border-b border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-[-8rem] -z-10 h-[20rem] bg-gradient-to-b from-primary/10 via-primary/5 to-transparent blur-3xl"
          />
          <div className="px-6 py-12 sm:px-12 sm:py-16">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
                <LockKeyholeIcon className="size-3.5" />
                Confidential by design
              </span>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
                Models run inside a{" "}
                <span className="text-primary">trusted execution environment.</span>
              </h2>
              <p className="mt-4 text-muted-foreground">
                Most AI providers can read — and keep — everything you send.
                TinyCloud Chat runs inference inside TEEs: your prompt is
                processed in a sealed, hardware-isolated enclave the people
                running the GPUs can't see into, and every reply carries a
                hardware attestation you can verify. You get the model's help
                without handing over your data.
              </p>
            </div>

            <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
              {POINTS.map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex flex-col gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-4.5" />
                  </span>
                  <h3 className="text-base font-semibold">{title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
