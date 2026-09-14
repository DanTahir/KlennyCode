import type { Metadata } from 'next';
import { Inter, Sora } from 'next/font/google';
import './globals.css';
import Effects from '@/components/Effects';

/*
 * next/font/google self-hosts these at build time, so they are emitted into
 * out/_next/static/media/** by `next build` and work under output: 'export'
 * with no runtime request to Google. This also fixes the long-standing silent
 * fallback to system-ui: tailwind.config.ts referenced "Inter" by name, but
 * nothing ever loaded it.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const display = Sora({
  subsets: ['latin'],
  display: 'swap',
  weight: ['600', '700', '800'],
  variable: '--font-display',
});

const SITE_URL = 'https://klennycode.com';
const DESCRIPTION =
  'Klenny Code is a free, open-source desktop coding agent. Bring your own OpenRouter key and use hundreds of AI models, with memory, cross-project lookup, scheduling, agent-built Pawprints mini apps, shared Assistant window memory, and more — for Windows, macOS, and Linux.';
const TITLE = 'Klenny Code — The open-source AI coding agent for your desktop';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'Klenny Code',
    'AI coding agent',
    'OpenRouter',
    'open source coding assistant',
    'Claude',
    'GPT',
    'desktop AI agent',
    'Pawprints',
    'AI-generated desktop widgets',
    'Assistant window memory',
  ],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: 'Klenny Code',
    // Dimensions must match the real file on disk (public/og-card.png).
    images: [{ url: '/og-card.png', width: 1536, height: 864, alt: 'Klenny Code' }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og-card.png'],
  },
  icons: {
    icon: '/Klenny.jpg',
  },
};

/*
 * Adds `js` to <html> before first paint. app/globals.css scopes every
 * reveal-hidden state to `html.js`, so without this class nothing is ever
 * hidden -- that is the no-JS fallback. Running it here (rather than in a
 * useEffect) avoids a flash of visible-then-hidden content.
 */
const JS_FLAG = 'document.documentElement.classList.add("js");';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      </head>
      <body className="bg-corgi-ink font-sans text-corgi-cream antialiased">
        {children}
        <Effects />
      </body>
    </html>
  );
}
