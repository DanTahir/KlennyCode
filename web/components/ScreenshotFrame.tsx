import Image from 'next/image';

interface ScreenshotFrameProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  /** Scroll-linked straighten via lib/effects/tilt.ts. */
  tilt?: boolean;
  /** Soft corgi-orange bloom behind the panel. */
  glow?: boolean;
  className?: string;
}

/**
 * The single place screenshots are presented.
 *
 * This replaces the fake macOS window chrome (a bar with three traffic-light
 * dots) that used to be hand-inlined above two of the screenshots. Every
 * screenshot in public/ already contains its own REAL Windows titlebar, so the
 * fake bar painted a second, mismatched titlebar on top of an authentic one.
 *
 * Do not add cropping here. `overflow-hidden` exists only so the border radius
 * clips the image's own corners; there is deliberately no fixed height, no
 * negative offset and no object-fit crop, because any of those would slice off
 * the real product chrome inside the screenshot. The image keeps its intrinsic
 * aspect ratio from the width/height props.
 */
export default function ScreenshotFrame({
  src,
  alt,
  width,
  height,
  priority = false,
  tilt = false,
  glow = true,
  className = '',
}: ScreenshotFrameProps) {
  return (
    <div className={`relative ${className}`}>
      {glow ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-4 rounded-[2.25rem] bg-corgi-orange/20 blur-3xl sm:-inset-8"
        />
      ) : null}

      <div
        {...(tilt ? { 'data-tilt': '' } : {})}
        className={`relative overflow-hidden rounded-2xl ring-1 ring-white/10 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.85)] ${
          tilt ? 'tilt-frame' : ''
        }`}
      >
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          priority={priority}
          sizes="(max-width: 768px) 100vw, 1100px"
          className="block h-auto w-full"
        />
      </div>
    </div>
  );
}
