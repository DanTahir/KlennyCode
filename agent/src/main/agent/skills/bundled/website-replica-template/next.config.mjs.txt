/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
