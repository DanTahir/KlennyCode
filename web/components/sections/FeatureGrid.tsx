import Image from 'next/image';
import Feature, { type FeatureProps } from '@/components/Feature';

/*
 * Feature dedupe (plan step B6): the old page had 8 MiniFeatures + 11
 * FeatureCards = 19 items, with Pawprints and Assistant-shared-memory each
 * appearing twice in different wording. This is the single canonical list,
 * capped at 12 distinct features:
 *
 *  - Memory + cross-project lookup  -> merged into the wide "Memory" tile
 *  - Scheduling + Gmail/Discord     -> merged into the wide "Scheduling" tile
 *  - Pawprints (x2)                 -> dropped here; PawprintsSpotlight owns it
 *  - Assistant shared memory (x2)   -> one card
 *  - "No .gitignore gymnastics" + "plain-text, portable" -> one card
 *  - "Free & open source" / "self-updating" -> hero badge, footer, download CTA
 */
const CARDS: FeatureProps[] = [
  {
    icon: '🔑',
    title: 'Any model, one key',
    body: 'Paste an OpenRouter key and switch freely between Claude, GPT, Gemini, and hundreds more — per tab, mid-conversation, with a cheaper utility model handling background work.',
    accent: 'orange',
  },
  {
    icon: '📋',
    title: 'Plan mode and diff approvals',
    body: 'Ask for a plan before any code moves, then approve each edit as a real diff. Per-tab approval modes let you go hands-off where you trust it and stay strict where you don\u2019t.',
    accent: 'orange',
  },
  {
    icon: '🧩',
    title: 'Skills and subagents',
    body: 'Reusable Markdown skills teach it your workflows, and subagents run open-ended research in their own context window so your main thread stays fast and focused.',
    accent: 'moss',
  },
  {
    icon: '🔍',
    title: 'Semantic codebase search',
    body: 'An optional local vector index finds code by meaning rather than exact text — useful in big repos where you don\u2019t know the name of the thing you\u2019re looking for.',
    accent: 'sky',
  },
  {
    icon: '🌐',
    title: 'Browser automation built in',
    body: 'A real local browser it can drive itself: snapshot a page, click, type, fill forms, and verify the result — with mutating actions gated behind your approval settings.',
    accent: 'sky',
  },
  {
    icon: '💻',
    title: 'Real terminal, real cost control',
    body: 'A genuine interactive shell lives in the app, next to a daily spending cap and a cost report that breaks spend down by model, so nothing runs away from you.',
    accent: 'cream',
  },
  {
    icon: '🔗',
    title: 'Assistant windows stay in sync',
    body: 'Every Assistant tab writes a short note about what it did and reads a digest of the others, so a second window picks up where the first left off instead of starting cold.',
    accent: 'sky',
  },
  {
    icon: '🐕',
    title: 'Personality you can rewrite',
    body: 'It ships as a playful corgi, and that persona is just a plain-text SOUL.md you can edit, tone down, or replace. The engineering rigor underneath is not editable.',
    accent: 'orange',
  },
  {
    icon: '🖼️',
    title: 'Vision and documents',
    body: 'Paste screenshots, mockups, and diagrams straight into chat, or hand it a Word document to read and edit — useful well beyond code.',
    accent: 'moss',
  },
  {
    icon: '📄',
    title: 'Nothing dumped in your repo',
    body: 'Plans, memory notes, and the search index live in the app\u2019s own data directory as plain text — portable, inspectable, and with no .gitignore gymnastics.',
    accent: 'cream',
  },
];

interface WideTile {
  eyebrow: string;
  title: string;
  body: string;
  art: string;
  alt: string;
}

const WIDE: WideTile[] = [
  {
    eyebrow: 'Memory',
    title: 'It remembers how your project works',
    body: 'Project and global memory files plus auto-generated notes mean your conventions, decisions, and dead ends survive between sessions. It can also read across your other projects read-only, so “port that feature from my other repo” works without leaving the window.',
    art: '/memory-art.png',
    alt: '',
  },
  {
    eyebrow: 'Scheduling and assistant',
    title: 'Work that happens while you\u2019re away',
    body: 'Give it a cron schedule and it runs unattended in the background — a morning repo digest, a nightly check, a one-off reminder. Connect Gmail and Discord and the same agent handles inbox triage and chat mentions from dedicated Assistant tabs.',
    art: '/scheduler-art.png',
    alt: '',
  },
];

function WideFeature({ tile, delay }: { tile: WideTile; delay: 's' | 'm' }) {
  return (
    <div
      data-reveal=""
      data-card-glow=""
      data-fade-delay={delay}
      className="glow-card relative overflow-hidden rounded-2xl border border-white/8 bg-white/[0.025] p-7 lg:col-span-2"
    >
      <div className="grid gap-6 sm:grid-cols-[1.35fr_1fr] sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-corgi-orange/80">
            {tile.eyebrow}
          </p>
          <h3 className="mt-3 font-display text-fluid-h3 font-semibold text-corgi-cream">{tile.title}</h3>
          <p className="mt-2 text-[0.95rem] leading-relaxed text-corgi-cream/65">{tile.body}</p>
        </div>

        <Image
          src={tile.art}
          alt={tile.alt}
          aria-hidden={tile.alt === '' ? 'true' : undefined}
          width={1024}
          height={1024}
          className="mx-auto w-full max-w-[16rem] rounded-xl opacity-90"
        />
      </div>
    </div>
  );
}

export default function FeatureGrid() {
  return (
    <section id="features" className="mx-auto max-w-shell px-6 pt-28">
      <div data-reveal="" className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-corgi-orange/80">Features</p>
        <h2 className="mt-3 font-display text-fluid-h2 font-bold text-corgi-cream">
          Everything a coding agent should be.{' '}
          <span className="text-corgi-orange">And then some.</span>
        </h2>
      </div>

      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <WideFeature tile={WIDE[0]} delay="s" />
        <Feature {...CARDS[0]} delay="m" />

        <Feature {...CARDS[1]} delay="s" />
        <Feature {...CARDS[2]} delay="m" />
        <Feature {...CARDS[3]} delay="l" />

        <WideFeature tile={WIDE[1]} delay="s" />
        <Feature {...CARDS[4]} delay="m" />

        <Feature {...CARDS[5]} delay="s" />
        <Feature {...CARDS[6]} delay="m" />
        <Feature {...CARDS[7]} delay="l" />
        <Feature {...CARDS[8]} delay="s" />
        <Feature {...CARDS[9]} delay="m" />
      </div>
    </section>
  );
}
