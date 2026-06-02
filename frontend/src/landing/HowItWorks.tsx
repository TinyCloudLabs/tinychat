const LAYERS = [
  {
    number: "01",
    title: "Identity",
    body: "Sign in with your wallet — no email, no password, no account form. A private TinyCloud space is provisioned the first time you connect.",
  },
  {
    number: "02",
    title: "Storage",
    body: "Every conversation is written to your own per-space SQL database in TinyCloud. It's portable, yours to export or delete, and not stored in our account silo.",
  },
  {
    number: "03",
    title: "Models",
    body: "Pick from a range of models and switch mid-thread. Requests stream through TinyCloud's gateway, so there are no keys for you to manage.",
  },
  {
    number: "04",
    title: "Sync",
    body: "Your threads follow you across devices, restored straight from your space the moment you sign in.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-b border-border bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary/80">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Your identity, your storage,{" "}
            <span className="text-primary">any model.</span>
          </h2>
          <p className="mt-4 text-muted-foreground">
            TinyCloud Chat is a thin client over a stack you own end to end.
          </p>
        </div>

        <ol className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {LAYERS.map((layer) => (
            <li
              key={layer.number}
              className="relative flex flex-col gap-3 rounded-xl border border-border bg-card p-6"
            >
              <span className="text-xs font-mono text-muted-foreground">
                {layer.number}
              </span>
              <h3 className="text-lg font-semibold tracking-tight">
                {layer.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {layer.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
