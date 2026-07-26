interface Props {
  icon: string;
  title: string;
  children: React.ReactNode;
  color?: 'orange' | 'purple' | 'blue' | 'green' | 'red' | 'yellow';
}

const COLOR_CLASSES: Record<Required<Props>['color'], string> = {
  orange: 'bg-orange-500/15 text-orange-400',
  purple: 'bg-purple-500/15 text-purple-400',
  blue: 'bg-sky-500/15 text-sky-400',
  green: 'bg-emerald-500/15 text-emerald-400',
  red: 'bg-rose-500/15 text-rose-400',
  yellow: 'bg-amber-500/15 text-amber-400',
};

export default function MiniFeature({ icon, title, children, color = 'orange' }: Props) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-full text-lg ${COLOR_CLASSES[color]}`}
        aria-hidden
      >
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-corgi-cream">{title}</h3>
      <p className="text-xs leading-relaxed text-corgi-cream/60">{children}</p>
    </div>
  );
}
