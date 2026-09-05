import type { ReactNode } from 'react';
import { metadata as generatedMetadata, viewport as generatedViewport } from './generated/metadata';
import ClientRuntime from './ClientRuntime';
import './generated/index.css';

// Re-exported from the generated file so codegen owns <head> entirely:
// title, description, OG/Twitter cards, icons and the viewport tag are all
// lifted verbatim from the captured page.
export const metadata = generatedMetadata;
export const viewport = generatedViewport;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {/* Re-applies the behaviours the original page's JS provided. */}
        <ClientRuntime />
      </body>
    </html>
  );
}
