import Image from 'next/image';
import ScreenshotFrame from '@/components/ScreenshotFrame';

export default function PawprintsSpotlight() {
  return (
    <section id="pawprints" className="mx-auto max-w-shell px-6 pt-28">
      <div className="grid gap-10 lg:grid-cols-[1fr_0.8fr] lg:items-center">
        <div data-reveal="">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-corgi-orange/80">Pawprints</p>
          <h2 className="mt-3 font-display text-fluid-h2 font-bold text-corgi-cream">
            Ask for a widget. Get a real desktop app.
          </h2>
          <p className="mt-4 max-w-xl text-fluid-lead text-corgi-cream/65">
            Pawprints are small sandboxed apps Klenny writes for you — a weather panel, a
            calendar, an analog clock, a sticky-note board — each running in its own window,
            outside the chat.
          </p>
          <ul className="mt-6 space-y-3 text-[0.95rem] text-corgi-cream/70">
            <li className="flex gap-3">
              <span aria-hidden="true" className="text-corgi-orange">
                ✓
              </span>
              Nothing runs until you approve it — one review shows the full source, every npm
              package, and every network domain it asked for.
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="text-corgi-orange">
                ✓
              </span>
              Sandboxed by design: no API key, no shell, no access to the rest of your disk.
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="text-corgi-orange">
                ✓
              </span>
              Run as many instances as you like and manage them all from the My Pawprints panel.
            </li>
          </ul>
        </div>

        <Image
          src="/pawprints-art.png"
          alt=""
          aria-hidden="true"
          width={1024}
          height={1024}
          data-reveal=""
          data-fade-delay="s"
          className="mx-auto w-full max-w-sm rounded-2xl"
        />
      </div>

      <ScreenshotFrame
        src="/KlennyCodePawprints.png"
        alt="The My Pawprints panel alongside three running Pawprints: a 7-Day Weather widget, a Calendar, and an Analog Clock Plus, each in its own desktop window"
        width={1917}
        height={1017}
        className="mt-14"
      />
    </section>
  );
}
