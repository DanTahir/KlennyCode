const STEPS = [
  {
    n: '01',
    title: 'Install and paste your key',
    body: 'Download the app, drop in an OpenRouter API key, and pick a default model. No account with us, no subscription, no telemetry to opt out of.',
  },
  {
    n: '02',
    title: 'Open a project and talk',
    body: 'Klenny reads and edits real files, runs commands in a real shell, searches the codebase, and writes down what it learns so the next session starts informed.',
  },
  {
    n: '03',
    title: 'Approve, then let it run',
    body: 'Ask for a plan first, review each change as a diff, and choose how much to approve automatically. Long jobs pause at checkpoints instead of running away.',
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-shell px-6 pt-28">
      <div data-reveal="" className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-corgi-orange/80">How it works</p>
        <h2 className="mt-3 font-display text-fluid-h2 font-bold text-corgi-cream">
          Three steps, then it&apos;s just work getting done
        </h2>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-3">
        {STEPS.map((step, index) => (
          <div
            key={step.n}
            data-reveal=""
            data-card-glow=""
            data-fade-delay={(['s', 'm', 'l'] as const)[index]}
            className="glow-card relative rounded-2xl border border-white/8 bg-white/[0.025] p-7"
          >
            <span
              aria-hidden="true"
              className="font-display text-5xl font-extrabold leading-none text-corgi-orange/25"
            >
              {step.n}
            </span>
            <h3 className="mt-4 font-display text-fluid-h3 font-semibold text-corgi-cream">{step.title}</h3>
            <p className="mt-2 text-[0.95rem] leading-relaxed text-corgi-cream/65">{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
