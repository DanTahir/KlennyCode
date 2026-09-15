import Image from 'next/image';
import DownloadButtons from '@/components/DownloadButtons';
import OpenSourceBadge from '@/components/OpenSourceBadge';
import type { LatestReleaseData } from '@/lib/getLatestRelease';

const GITHUB_URL = 'https://github.com/DanTahir/KlennyCode';

/** Rotating line under the headline, typed out by lib/effects/typewriter.ts. */
const PHRASES = [
  'refactor this module and run the tests',
  'remember how we do migrations here',
  'plan it first, then show me the diff',
  'check the staging deploy every morning at 8',
  'build me a sticky-note widget for my desktop',
];

/**
 * The typed line is a single flow of inline text, so on narrow viewports it
 * wraps onto a second line partway through a phrase. An invisible sizer span
 * holding the longest phrase reserves that full height up front, so the block
 * stays a constant height instead of growing and shrinking as characters are
 * typed and erased. The font is monospace, which makes character count an
 * exact proxy for rendered width.
 */
const LONGEST_PHRASE = PHRASES.reduce((longest, phrase) => (phrase.length >= longest.length ? phrase : longest), '');

export default function Hero({ release }: { release: LatestReleaseData }) {
  return (
    <section
      id="top"
      data-spotlight=""
      className="relative isolate overflow-hidden pt-[calc(var(--nav-h)+2.5rem)] pb-16 sm:pb-20"
    >
      {/* Generated aurora backdrop */}
      <Image
        src="/hero-aurora.png"
        alt=""
        aria-hidden="true"
        width={1536}
        height={864}
        priority
        className="pointer-events-none absolute inset-0 -z-20 h-full w-full animate-aurora-drift object-cover opacity-70"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-20 bg-gradient-to-b from-corgi-ink/70 via-corgi-ink/40 to-corgi-ink"
      />
      {/* Cursor-follow glow + fine grain */}
      <div aria-hidden="true" className="spotlight-layer pointer-events-none absolute inset-0 -z-10" />
      <div aria-hidden="true" className="grain-overlay pointer-events-none absolute inset-0 -z-10 opacity-[0.18]" />

      <div className="mx-auto grid max-w-shell gap-10 px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <div className="relative z-10 flex flex-col items-start text-left">
          <div data-reveal="" className="mb-6">
            <OpenSourceBadge />
          </div>

          <h1
            data-word-reveal=""
            className="font-display text-fluid-hero font-extrabold text-corgi-cream"
          >
            Your desktop coding agent.{' '}
            <span className="text-gradient-corgi animate-gradient-pan">Any model. Zero leash.</span>
          </h1>

          {/*
            Both spans occupy the same single grid cell, so the taller of the
            two sets the height. The first is an invisible copy of the longest
            phrase (see LONGEST_PHRASE) that holds the line box open; the
            second carries the live typed text. The typed line therefore never
            changes the height of this block as it wraps, types, or erases.
          */}
          <p
            data-typewriter=""
            data-phrases={JSON.stringify(PHRASES)}
            className="mt-6 grid font-mono text-sm text-corgi-cream/80 sm:text-base"
          >
            <span aria-hidden="true" className="invisible col-start-1 row-start-1 select-none">
              <span className="mr-2">klenny&gt;</span>
              {LONGEST_PHRASE}
            </span>
            <span className="col-start-1 row-start-1">
              <span aria-hidden="true" className="mr-2 text-corgi-orange/70">
                klenny&gt;
              </span>
              <span data-typewriter-out="" />
              <span aria-hidden="true" className="tw-caret" />
            </span>
          </p>

          <p data-reveal="" data-fade-delay="s" className="mt-6 max-w-xl text-fluid-lead text-corgi-cream/70">
            A free, open-source AI coding agent for Windows, macOS, and Linux. Bring your own
            OpenRouter key, point it at a real codebase, and keep every plan, diff, and command
            under your approval.
          </p>

          <div data-reveal="" data-fade-delay="m" className="mt-9">
            <DownloadButtons release={release} showGithubButton align="left" />
          </div>

          <a
            data-reveal=""
            data-fade-delay="l"
            href={GITHUB_URL}
            className="mt-6 inline-flex items-center gap-1.5 text-sm text-corgi-cream/55 underline decoration-dotted transition hover:text-corgi-cream"
          >
            ⭐ Star it on GitHub — MIT licensed, 100% open source
          </a>
        </div>

        {/* Mascot artwork */}
        <div data-reveal="" data-fade-delay="s" className="relative flex flex-col items-center gap-6">
          {/*
            The corgi is not centred inside its own artwork: the left ~40% of
            the PNG is empty transparency, putting the dog's centre at roughly
            73% of the image width. Centring the image therefore left the dog
            sitting well right of the three thumbnails below it. So scale the
            artwork up and shift it left by scale * (0.73 - 0.5) of its width,
            which drops the dog's centre onto the column's centre line -- the
            same line the thumbnails centre on, and at every breakpoint, since
            both numbers are proportions rather than pixels. A transform is
            used deliberately: it is layout-neutral, so the empty left part of
            the PNG just underlaps the text column (which paints above it via
            `z-10`) and nothing below the image shifts or grows.
          */}
          <Image
            src="/klennywebhero.png"
            alt="Klenny, the corgi mascot of Klenny Code, surrounded by icons for coding, terminal, skills, search, scheduling, and browser automation"
            width={1536}
            height={1024}
            priority
            className="w-full max-w-xl -translate-x-[28%] scale-[1.22] drop-shadow-[0_0_70px_rgba(232,134,58,0.28)]"
          />

          <div className="flex items-end justify-center gap-4 sm:gap-6">
            <Image
              src="/Klenny2.png"
              alt=""
              aria-hidden="true"
              width={1024}
              height={1536}
              className="w-16 -rotate-6 rounded-2xl shadow-xl shadow-black/40 sm:w-24"
            />
            <Image
              src="/Klenny4.png"
              alt=""
              aria-hidden="true"
              width={1127}
              height={1396}
              className="w-20 animate-float-soft rounded-2xl shadow-xl shadow-black/40 sm:w-28"
            />
            <Image
              src="/Klenny6.png"
              alt=""
              aria-hidden="true"
              width={1024}
              height={1536}
              className="w-16 rotate-6 rounded-2xl shadow-xl shadow-black/40 sm:w-24"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
