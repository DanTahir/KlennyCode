import Image from 'next/image';
import { getLatestRelease } from '@/lib/getLatestRelease';
import DownloadButtons from '@/components/DownloadButtons';
import FeatureCard from '@/components/FeatureCard';
import MiniFeature from '@/components/MiniFeature';
import OpenSourceBadge from '@/components/OpenSourceBadge';
import GithubIcon from '@/components/GithubIcon';

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
      <section className="mx-auto grid max-w-6xl gap-12 px-6 pb-20 pt-6 lg:grid-cols-2 lg:items-center">
        {/* Left: copy + CTAs */}
        <div className="flex flex-col items-start text-left">
          <div className="mb-6">
            <OpenSourceBadge />
          </div>

          <h1 className="mb-5 text-4xl font-extrabold leading-tight tracking-tight text-corgi-cream sm:text-5xl lg:text-6xl">
            Your desktop
            <br />
            coding agent.
            <br />
            <span className="text-corgi-orange">
              Any model.
              <br />
              Zero leash.
            </span>
          </h1>

          <p className="mb-6 text-lg font-medium text-corgi-orange sm:text-xl">
            The open source coding agent with personality.
          </p>

          <p className="mb-8 max-w-xl text-lg text-corgi-cream/75">
            Klenny Code is a free, open-source AI coding agent for Windows, macOS, and Linux.
            Bring your own OpenRouter key and unleash hundreds of frontier models — Claude, GPT,
            Gemini, and more — on your real codebase, with memory, cross-project lookup, and a
            scheduler that works even while you&apos;re away. It comes with a playful corgi
            personality by default, fully yours to rewrite, dial down, or switch off in a
            plain-text file. No subscriptions. No lock-in. Just a very good boy with a very big
            toolbox.
          </p>

          <DownloadButtons release={release} showGithubButton align="left" />

          <a
            href={GITHUB_URL}
            className="mt-6 inline-flex items-center gap-1.5 text-sm text-corgi-cream/60 underline decoration-dotted hover:text-corgi-cream"
          >
            ⭐ Star Klenny Code on GitHub — it&apos;s 100% open source (MIT)
          </a>
        </div>

        {/* Right: hero artwork + mascot trio */}
        <div className="flex flex-col items-center gap-6">
          <Image
            src="/klennywebhero.png"
            alt="Klenny, the corgi mascot of Klenny Code, surrounded by icons representing coding, terminal, skills, search, scheduling, and browser automation"
            width={1536}
            height={1024}
            className="w-full max-w-xl drop-shadow-[0_0_60px_rgba(232,134,58,0.25)]"
            priority
          />
          <div className="flex items-end justify-center gap-4 sm:gap-6">
            <Image
              src="/Klenny2.png"
              alt="Klenny the corgi mascot, illustrated"
              width={1024}
              height={1536}
              className="w-20 -rotate-6 rounded-2xl shadow-xl shadow-black/40 sm:w-28 md:w-32"
            />
            <Image
              src="/Klenny4.png"
              alt="Klenny the corgi mascot, illustrated"
              width={1127}
              height={1396}
              className="w-24 rounded-2xl shadow-xl shadow-black/40 sm:w-32 md:w-36"
            />
            <Image
              src="/Klenny6.png"
              alt="Klenny the corgi mascot, illustrated"
              width={1024}
              height={1536}
              className="w-20 rotate-6 rounded-2xl shadow-xl shadow-black/40 sm:w-28 md:w-32"
            />
          </div>
        </div>
      </section>

      {/* ---------- Main screenshot ---------- */}
      <section className="mx-auto max-w-5xl px-6 pb-10">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2 border-b border-white/10 bg-black/30 px-4 py-2.5">
            <span className="h-3 w-3 rounded-full bg-red-400/70" />
            <span className="h-3 w-3 rounded-full bg-yellow-400/70" />
            <span className="h-3 w-3 rounded-full bg-green-400/70" />
            <span className="ml-3 text-xs text-corgi-cream/40">Klenny Code</span>
          </div>
          <Image
            src="/KlennyScreenshot1.png"
            alt="Klenny Code desktop app showing a chat with the AI coding agent"
            width={1577}
            height={1011}
            className="w-full"
          />
        </div>
      </section>

      {/* ---------- Mini feature strip ---------- */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-6">
          <MiniFeature icon="🔑" title="Bring your own key, use any model" color="yellow">
            Connect your own OpenRouter API key and pick from hundreds of models — Claude, GPT,
            Gemini, and more.
          </MiniFeature>
          <MiniFeature icon="🧠" title="Memory that actually sticks" color="purple">
            Projects and global memory files plus auto-generated notes ensure Klenny remembers
            your conventions, decisions, and quirks across sessions.
          </MiniFeature>
          <MiniFeature icon="🐕" title="Personality, tuned by you" color="orange">
            Klenny ships with a playful corgi personality out of the box — lovable, loyal, and a
            little sassy. Edit the .txt file to make it uniquely yours.
          </MiniFeature>
          <MiniFeature icon="🧩" title="Cross-project lookup" color="green">
            Ask Klenny to reference, search, or port a feature from one of your other projects
            without ever leaving your current window.
          </MiniFeature>
          <MiniFeature icon="🗓️" title="Scheduling & personal assistant" color="blue">
            Set up recurring background tasks, connect Gmail and Discord, and let Klenny handle
            chores unattended — even when the app is minimized.
          </MiniFeature>
          <MiniFeature icon="💻" title="Real terminal, real cost control" color="red">
            A genuine interactive shell lives right in the app, alongside a spending cap and cost
            reports so you always know exactly what you&apos;re spending, on what.
          </MiniFeature>
        </div>
      </section>

      {/* ---------- Additional screenshots ---------- */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 shadow-xl shadow-black/30">
            <Image
              src="/KlennyScreenshot2.png"
              alt="Klenny Code desktop app — another view of the interface"
              width={1582}
              height={1007}
              className="w-full"
            />
          </div>
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 shadow-xl shadow-black/30">
            <Image
              src="/KlennyScreenshot3.png"
              alt="Klenny Code desktop app — another view of the interface"
              width={1580}
              height={1007}
              className="w-full"
            />
          </div>
        </div>
      </section>

      {/* ---------- Features ---------- */}
      <section id="features" className="mx-auto max-w-6xl px-6 pb-24">
        <div className="mb-12 text-center">
          <h2 className="mb-3 text-3xl font-bold text-corgi-cream sm:text-4xl">
            Everything a coding agent should be. <span className="text-corgi-orange">And then some.</span>
          </h2>
          <p className="mx-auto max-w-2xl text-corgi-cream/70">
            Klenny fetches, refactors, remembers, and even runs errands for you — all from one
            free, open-source app.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard icon="📋" title="Plan mode & approvals" color="red">
            Ask Klenny to plan first. Review every proposed change as a diff before it touches a
            single file — full control, zero surprises.
          </FeatureCard>

          <FeatureCard icon="🧩" title="Skills & subagents" color="purple">
            Reusable, Corgi-style skills and parallel subagents tackle research and multi-step
            work in the background, so the main thread stays fast.
          </FeatureCard>

          <FeatureCard icon="🔍" title="Semantic codebase search" color="blue">
            An optional vector index finds code by what it means, not just what it says — perfect
            for sprawling codebases where grep alone won&apos;t cut it.
          </FeatureCard>

          <FeatureCard icon="🌐" title="Browser automation built in" color="blue">
            A real local browser Klenny can drive itself — click, type, fill forms, and navigate
            like you do via snapshots, with mutating actions gated behind your approval settings.
          </FeatureCard>

          <FeatureCard icon="</>" title="Free & open source, always" color="red">
            MIT licensed, fully open on GitHub, no subscriptions or hidden fees. You only ever pay
            OpenRouter directly for model usage — at whatever rate you choose.
          </FeatureCard>

          <FeatureCard icon="⬆️" title="Self-updating" color="purple">
            One click updates the app itself, so you&apos;re always on the latest and greatest.
          </FeatureCard>

          <FeatureCard icon="📁" title="No .gitignore gymnastics" color="blue">
            Plans, auto-memory notes, and the codebase index live in Klenny&apos;s own app data
            directory, not scattered inside your project — nothing to add to .gitignore.
          </FeatureCard>

          <FeatureCard icon="📄" title="Plain-text, portable, hackable" color="yellow">
            Your data lives in plain text. Back it up, version it, or tweak it by hand. Total
            transparency.
          </FeatureCard>

          <FeatureCard icon="🖼️" title="Vision, built in" color="green">
            Attach or paste images right in chat and let multimodal models reason about
            screenshots, mockups, and diagrams alongside your code.
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
            <a href={GITHUB_URL} className="inline-flex items-center gap-1.5 hover:text-corgi-cream">
              <GithubIcon />
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
