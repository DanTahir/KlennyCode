import Image from 'next/image';
import { getLatestRelease } from '@/lib/getLatestRelease';
import DownloadButtons from '@/components/DownloadButtons';
import FeatureCard from '@/components/FeatureCard';
import OpenSourceBadge from '@/components/OpenSourceBadge';

const GITHUB_URL = 'https://github.com/DanTahir/KlennyCode';

export default function HomePage() {
  const release = getLatestRelease();

  return (
    <main className="relative overflow-hidden bg-corgi-dark">
      {/* soft background glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[-10rem] -z-10 h-[40rem] bg-[radial-gradient(ellipse_at_top,_rgba(232,134,58,0.25),_transparent_60%)]"
      />

      {/* ---------- Nav ---------- */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <Image src="/Klenny.jpg" alt="Klenny Code logo" width={36} height={36} className="rounded-full" />
          <span className="text-lg font-bold text-corgi-cream">Klenny Code</span>
        </div>
        <nav className="flex items-center gap-5 text-sm text-corgi-cream/70">
          <a href="#features" className="hover:text-corgi-cream">
            Features
          </a>
          <a href="#download" className="hover:text-corgi-cream">
            Download
          </a>
          <a href={GITHUB_URL} className="hover:text-corgi-cream">
            GitHub ↗
          </a>
        </nav>
      </header>

      {/* ---------- Hero ---------- */}
      <section className="mx-auto flex max-w-4xl flex-col items-center px-6 pb-20 pt-10 text-center">
        <Image
          src="/Klenny.jpg"
          alt="Klenny, the corgi mascot of Klenny Code"
          width={120}
          height={120}
          className="mb-6 rounded-full shadow-2xl shadow-orange-900/40"
          priority
        />

        <div className="mb-5">
          <OpenSourceBadge />
        </div>

        <h1 className="mb-5 text-4xl font-extrabold leading-tight tracking-tight text-corgi-cream sm:text-6xl">
          Your desktop coding agent.
          <br />
          <span className="text-corgi-orange">Any model. Zero leash.</span>
        </h1>

        <p className="mb-8 max-w-2xl text-lg text-corgi-cream/75">
          Klenny Code is a free, open-source AI coding agent for Windows, macOS, and Linux.
          Bring your own OpenRouter key and unleash hundreds of frontier models — Claude, GPT,
          Gemini, and more — on your real codebase, with memory, cross-project lookup, and a
          scheduler that works even while you&apos;re away. No subscriptions. No lock-in. Just a
          very good boy with a very big toolbox.
        </p>

        <DownloadButtons release={release} />

        <a
          href={GITHUB_URL}
          className="mt-6 inline-flex items-center gap-1.5 text-sm text-corgi-cream/60 underline decoration-dotted hover:text-corgi-cream"
        >
          ⭐ Star Klenny Code on GitHub — it&apos;s 100% open source (MIT)
        </a>
      </section>

      {/* ---------- Screenshot ---------- */}
      <section className="mx-auto max-w-5xl px-6 pb-24">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2 border-b border-white/10 bg-black/30 px-4 py-2.5">
            <span className="h-3 w-3 rounded-full bg-red-400/70" />
            <span className="h-3 w-3 rounded-full bg-yellow-400/70" />
            <span className="h-3 w-3 rounded-full bg-green-400/70" />
            <span className="ml-3 text-xs text-corgi-cream/40">Klenny Code</span>
          </div>
          <Image
            src="/Screenshot1.png"
            alt="Klenny Code desktop app showing a chat with the AI coding agent"
            width={1572}
            height={944}
            className="w-full"
          />
        </div>
      </section>

      {/* ---------- Features ---------- */}
      <section id="features" className="mx-auto max-w-6xl px-6 pb-24">
        <div className="mb-12 text-center">
          <h2 className="mb-3 text-3xl font-bold text-corgi-cream sm:text-4xl">
            Everything a coding agent should be. And then some.
          </h2>
          <p className="mx-auto max-w-2xl text-corgi-cream/70">
            Klenny fetches, refactors, remembers, and even runs errands for you — all from one
            free, open-source app.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard icon="🔑" title="Bring your own key, use any model">
            Connect your own OpenRouter API key and pick from hundreds of models — Claude, GPT,
            Gemini, and more — all through one account. No vendor lock-in, no marked-up tokens,
            just the model you want at the price you choose.
          </FeatureCard>

          <FeatureCard icon="🧠" title="Memory that actually sticks">
            Project and global memory files plus auto-generated notes mean Klenny remembers your
            conventions, decisions, and quirks across sessions — so you stop repeating yourself.
          </FeatureCard>

          <FeatureCard icon="🔎" title="Cross-project lookup">
            Ask Klenny to reference, search, or port a feature from one of your other projects
            without ever leaving your current window. Your whole portfolio, one context away.
          </FeatureCard>

          <FeatureCard icon="🗓️" title="Scheduling & personal assistant">
            Set up recurring background tasks, connect Gmail and Discord, and let Klenny handle
            chores unattended from the system tray — even when the app is minimized.
          </FeatureCard>

          <FeatureCard icon="📋" title="Plan mode & approvals">
            Ask Klenny to plan first. Review every proposed change as a diff before it touches a
            single file — full control, zero surprises.
          </FeatureCard>

          <FeatureCard icon="🧩" title="Skills & subagents">
            Reusable, Cursor-style skills and parallel subagents tackle research and multi-step
            work in the background, so the main thread stays fast and focused.
          </FeatureCard>

          <FeatureCard icon="🧭" title="Semantic codebase search">
            An optional vector index finds code by what it means, not just what it says —
            perfect for sprawling codebases where grep alone won&apos;t cut it.
          </FeatureCard>

          <FeatureCard icon="💻" title="Real terminal, real cost control">
            A genuine interactive shell lives right in the app, alongside a spending cap and cost
            report so you always know exactly what you&apos;re spending, on what.
          </FeatureCard>

          <FeatureCard icon="🐾" title="Free & open source, always">
            MIT licensed, fully open on GitHub, no subscriptions or hidden fees. You only ever pay
            OpenRouter directly for model usage — at whatever rate you choose.
          </FeatureCard>
        </div>
      </section>

      {/* ---------- Download ---------- */}
      <section
        id="download"
        className="mx-auto max-w-4xl rounded-3xl border border-white/10 bg-white/5 px-6 py-16 text-center sm:mx-6 lg:mx-auto"
      >
        <h2 className="mb-3 text-3xl font-bold text-corgi-cream sm:text-4xl">
          Ready to fetch some code?
        </h2>
        <p className="mx-auto mb-10 max-w-xl text-corgi-cream/70">
          Download Klenny Code for free, right now. Available for Windows, macOS, and Linux.
        </p>
        <DownloadButtons release={release} />
        <p className="mt-8 text-sm text-corgi-cream/50">
          Klenny Code is open source under the MIT license.{' '}
          <a href={GITHUB_URL} className="underline decoration-dotted hover:text-corgi-cream">
            Browse the code, file an issue, or contribute on GitHub
          </a>
          .
        </p>
      </section>

      {/* ---------- Footer ---------- */}
      <footer className="mx-auto mt-20 max-w-6xl px-6 py-10 text-sm text-corgi-cream/50">
        <div className="flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
          <div className="flex items-center gap-2">
            <Image src="/Klenny.jpg" alt="Klenny Code logo" width={22} height={22} className="rounded-full" />
            <span>Klenny Code — MIT licensed, open source</span>
          </div>
          <div className="flex items-center gap-5">
            <a href={GITHUB_URL} className="hover:text-corgi-cream">
              GitHub
            </a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`} className="hover:text-corgi-cream">
              License
            </a>
            <a href="https://openrouter.ai" className="hover:text-corgi-cream">
              Powered by OpenRouter
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
