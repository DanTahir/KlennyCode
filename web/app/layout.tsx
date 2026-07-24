import type { Metadata } from 'next';
import './globals.css';

const SITE_URL = 'https://klennycode.com';
const DESCRIPTION =
  'Klenny Code is a free, open-source desktop coding agent. Bring your own OpenRouter key and use hundreds of AI models, with memory, cross-project lookup, scheduling, and more — for Windows, macOS, and Linux.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Klenny Code — The open-source AI coding agent for your desktop',
  description: DESCRIPTION,
  keywords: [
    'Klenny Code',
    'AI coding agent',
    'OpenRouter',
    'open source coding assistant',
    'Claude',
    'GPT',
    'desktop AI agent',
  ],
  openGraph: {
    title: 'Klenny Code — The open-source AI coding agent for your desktop',
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: 'Klenny Code',
    images: [{ url: '/Screenshot1.png', width: 1572, height: 944 }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Klenny Code — The open-source AI coding agent for your desktop',
    description: DESCRIPTION,
    images: ['/Screenshot1.png'],
  },
  icons: {
    icon: '/Klenny.jpg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans text-corgi-cream antialiased">{children}</body>
    </html>
  );
}
