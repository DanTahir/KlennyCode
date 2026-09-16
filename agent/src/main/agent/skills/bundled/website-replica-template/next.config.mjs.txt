/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next dev` and `next build` both default to distDir '.next', so running a
  // production build while the dev server is live overwrites the very manifests
  // the dev server is serving from — the page then renders completely unstyled
  // with 404s on /_next/static/css/app/*.css, which looks exactly like a CSS
  // regression you just caused. Next sets NODE_ENV before loading this file, so
  // keying off it gives dev and build separate directories on every platform.
  distDir: process.env.NODE_ENV === 'production' ? '.next-build' : '.next',
  // The dev-mode overlay badge renders in the bottom-left corner of every
  // page in `next dev`. The live site has nothing there, so it shows up as a
  // permanent local-only delta in `npm run compare` at EVERY viewport — both
  // inflating the diff % and masking real regressions in that corner.
  devIndicators: false,
  images: {
    // Every image is already self-hosted under /public/assets at its original
    // dimensions. Running them back through the Next optimiser would re-encode
    // and resize them, which is the opposite of a pixel-faithful replica.
    unoptimized: true,
  },
};

export default nextConfig;
