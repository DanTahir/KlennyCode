import ScreenshotFrame from '@/components/ScreenshotFrame';

export default function PrimaryScreenshot() {
  return (
    <section className="mx-auto max-w-shell px-6 pt-20">
      <div data-reveal="" className="mx-auto max-w-4xl text-center">
        <h2 className="font-display text-fluid-h2 font-bold text-corgi-cream">
          The whole loop, in one window
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-fluid-lead text-corgi-cream/65">
          Chat, plans, diffs, a real terminal, and live progress checklists — no browser tab, no
          context switching, nothing to copy and paste.
        </p>
      </div>

      <ScreenshotFrame
        src="/KlennyScreenshot1.png"
        alt="The Klenny Code desktop app: a chat with the coding agent on the right, project files and tools alongside it"
        width={1577}
        height={1011}
        tilt
        className="mx-auto mt-12 max-w-5xl"
      />
    </section>
  );
}
