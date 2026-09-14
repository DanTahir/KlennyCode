import { getLatestRelease } from '@/lib/getLatestRelease';
import Nav from '@/components/sections/Nav';
import Hero from '@/components/sections/Hero';
import ModelMarquee from '@/components/sections/ModelMarquee';
import PrimaryScreenshot from '@/components/sections/PrimaryScreenshot';
import Stats from '@/components/sections/Stats';
import HowItWorks from '@/components/sections/HowItWorks';
import FeatureGrid from '@/components/sections/FeatureGrid';
import PawprintsSpotlight from '@/components/sections/PawprintsSpotlight';
import ScreenshotPair from '@/components/sections/ScreenshotPair';
import DownloadCta from '@/components/sections/DownloadCta';
import Footer from '@/components/sections/Footer';

/**
 * Server component on purpose: getLatestRelease() reads the build-time
 * generated/latest-release.json with readFileSync, so it must resolve during
 * `next build`, not in the browser. All interactivity lives in the two client
 * components (<Effects /> mounted from layout.tsx, and <DownloadButtons />).
 */
export default function HomePage() {
  const release = getLatestRelease();

  return (
    <>
      <Nav />
      <main className="relative bg-corgi-ink">
        <Hero release={release} />
        <ModelMarquee />
        <PrimaryScreenshot />
        <Stats />
        <HowItWorks />
        <FeatureGrid />
        <PawprintsSpotlight />
        <ScreenshotPair />
        <DownloadCta release={release} />
        <Footer />
      </main>
    </>
  );
}
