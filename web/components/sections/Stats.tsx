interface Stat {
  to: number;
  prefix?: string;
  suffix?: string;
  label: string;
}

const STATS: Stat[] = [
  { to: 400, suffix: '+', label: 'models reachable through one OpenRouter key' },
  { to: 3, label: 'desktop platforms: Windows, macOS, Linux' },
  { to: 0, prefix: '$', label: 'subscription — you pay OpenRouter directly' },
  { to: 100, suffix: '%', label: 'open source, MIT licensed' },
];

/** Count-up strip driven by lib/effects/counters.ts. */
export default function Stats() {
  return (
    <section className="mx-auto max-w-shell px-6 pt-24">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-10 rounded-3xl border border-white/8 bg-white/[0.02] px-6 py-10 sm:px-10 lg:grid-cols-4">
        {STATS.map((stat, index) => (
          <div
            key={stat.label}
            data-reveal=""
            data-fade-delay={(['s', 'm', 'l', 'xl'] as const)[index] ?? 's'}
            className="text-center"
          >
            <dd
              data-counter=""
              data-counter-to={stat.to}
              {...(stat.prefix ? { 'data-counter-prefix': stat.prefix } : {})}
              {...(stat.suffix ? { 'data-counter-suffix': stat.suffix } : {})}
              className="font-display text-fluid-stat font-extrabold text-corgi-orange"
            >
              {`${stat.prefix ?? ''}${stat.to}${stat.suffix ?? ''}`}
            </dd>
            <dt className="mx-auto mt-2 max-w-[16rem] text-sm leading-snug text-corgi-cream/60">
              {stat.label}
            </dt>
          </div>
        ))}
      </dl>
    </section>
  );
}
