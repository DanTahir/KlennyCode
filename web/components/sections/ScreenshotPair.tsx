import ScreenshotFrame from '@/components/ScreenshotFrame';

export default function ScreenshotPair() {
  return (
    <section className="mx-auto max-w-shell px-6 pt-24">
      <div className="grid gap-8 sm:grid-cols-2">
        <ScreenshotFrame
          src="/KlennyScreenshot2.png"
          alt="Klenny Code showing a plan document alongside the chat"
          width={1582}
          height={1007}
          glow={false}
        />
        <ScreenshotFrame
          src="/KlennyScreenshot3.png"
          alt="Klenny Code showing the settings and model configuration screen"
          width={1580}
          height={1007}
          glow={false}
        />
      </div>
    </section>
  );
}
