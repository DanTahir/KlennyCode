import Image from 'next/image';
import GithubIcon from '@/components/GithubIcon';

const GITHUB_URL = 'https://github.com/DanTahir/KlennyCode';

/** Sticky nav: transparent at rest, frosted past 50px (lib/effects/navScroll.ts). */
export default function Nav() {
  return (
    <header data-nav="" className="site-nav fixed inset-x-0 top-0 z-50">
      <div className="mx-auto flex h-[var(--nav-h)] max-w-shell items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <Image
            src="/Klenny.jpg"
            alt=""
            aria-hidden="true"
            width={32}
            height={32}
            className="rounded-full ring-1 ring-white/15"
          />
          <span className="font-display text-[1.05rem] font-bold tracking-tight text-corgi-cream">
            Klenny Code
          </span>
        </a>

        <nav className="flex items-center gap-1 text-sm text-corgi-cream/70 sm:gap-2">
          <a href="#how" className="hidden rounded-full px-3 py-1.5 transition hover:bg-white/5 hover:text-corgi-cream sm:inline-block">
            How it works
          </a>
          <a href="#features" className="hidden rounded-full px-3 py-1.5 transition hover:bg-white/5 hover:text-corgi-cream sm:inline-block">
            Features
          </a>
          <a href="#pawprints" className="hidden rounded-full px-3 py-1.5 transition hover:bg-white/5 hover:text-corgi-cream md:inline-block">
            Pawprints
          </a>
          <a
            href={GITHUB_URL}
            aria-label="Klenny Code on GitHub"
            className="grid h-9 w-9 place-items-center rounded-full transition hover:bg-white/5 hover:text-corgi-cream"
          >
            <GithubIcon />
          </a>
          <a
            href="#download"
            className="ml-1 rounded-full bg-corgi-orange px-4 py-2 text-sm font-semibold text-corgi-dark transition hover:brightness-110"
          >
            Download
          </a>
        </nav>
      </div>
    </header>
  );
}
