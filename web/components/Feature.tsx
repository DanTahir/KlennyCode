type Accent = 'orange' | 'cream' | 'sky' | 'moss';
type Size = 'sm' | 'md';

const ACCENT_CLASSES: Record<Accent, string> = {
  orange: 'bg-corgi-orange/12 text-corgi-orange ring-corgi-orange/25',
  cream: 'bg-corgi-cream/10 text-corgi-cream ring-corgi-cream/20',
  sky: 'bg-sky-400/10 text-sky-300 ring-sky-400/20',
  moss: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/20',
};

export interface FeatureProps {
  icon: string;
  title: string;
  body: string;
  accent?: Accent;
  /** 'md' is the full grid card; 'sm' is the compact hero/inline variant. */
  size?: Size;
  /** data-fade-delay stagger tier consumed by lib/effects/reveal.ts. */
  delay?: 's' | 'm' | 'l' | 'xl';
}

/**
 * Replaces the old near-identical FeatureCard / MiniFeature pair (same colour
 * map, different sizing) with one component and a size variant.
 */
export default function Feature({
  icon,
  title,
  body,
  accent = 'orange',
  size = 'md',
  delay,
}: FeatureProps) {
  const compact = size === 'sm';

  return (
    <div
      data-reveal=""
      data-card-glow=""
      {...(delay ? { 'data-fade-delay': delay } : {})}
      className={`glow-card group h-full rounded-2xl border border-white/8 bg-white/[0.025] transition-colors duration-300 hover:border-white/15 hover:bg-white/[0.045] ${
        compact ? 'p-4' : 'p-6'
      }`}
    >
      <div
        aria-hidden="true"
        className={`mb-3 grid place-items-center rounded-xl ring-1 ${ACCENT_CLASSES[accent]} ${
          compact ? 'h-9 w-9 text-lg' : 'h-11 w-11 text-2xl'
        }`}
      >
        <span>{icon}</span>
      </div>

      <h3
        className={`font-display font-semibold text-corgi-cream ${
          compact ? 'text-base' : 'text-fluid-h3'
        }`}
      >
        {title}
      </h3>

      <p
        className={`mt-1.5 text-corgi-cream/65 ${compact ? 'text-[0.9rem] leading-relaxed' : 'text-[0.95rem] leading-relaxed'}`}
      >
        {body}
      </p>
    </div>
  );
}
