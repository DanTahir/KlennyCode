import DownloadButtons from '@/components/DownloadButtons';
import type { LatestReleaseData } from '@/lib/getLatestRelease';

const GITHUB_URL = 'https://github.com/DanTahir/KlennyCode';

export default function DownloadCta({ release }: { release: LatestReleaseData }) {
  return (
    <section id="download" className="mx-auto max-w-shell px-6 pt-28">
      <div
        data-reveal=""
        className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center sm:px-12"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-40 h-80 bg-[radial-gradient(ellipse_at_top,_rgba(232,134,58,0.28),_transparent_65%)]"
        />

        <h2 className="relative font-display text-fluid-h2 font-bold text-corgi-cream">
          Ready to fetch some code?
        </h2>
        <p className="relative mx-auto mt-3 max-w-xl text-fluid-lead text-corgi-cream/65">
          Free to download, free to keep. Updates arrive in-app on Windows and Linux, and you only
          ever pay OpenRouter for the models you actually use.
        </p>

        <div className="relative mt-10">
          <DownloadButtons release={release} />
        </div>

        <p className="relative mt-8 text-sm text-corgi-cream/50">
          MIT licensed and fully open source.{' '}
          <a href={GITHUB_URL} className="underline decoration-dotted hover:text-corgi-cream">
            Read the code, file an issue, or send a pull request
          </a>
          .
        </p>
      </div>
    </section>
  );
}
