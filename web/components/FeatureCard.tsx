interface Props {
  icon: string;
  title: string;
  children: React.ReactNode;
}

export default function FeatureCard({ icon, title, children }: Props) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 transition hover:border-corgi-orange/40 hover:bg-white/[0.07]">
      <div className="mb-3 text-3xl" aria-hidden>
        {icon}
      </div>
      <h3 className="mb-2 text-lg font-semibold text-corgi-cream">{title}</h3>
      <p className="text-sm leading-relaxed text-corgi-cream/70">{children}</p>
    </div>
  );
}
