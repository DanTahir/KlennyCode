'use client';

import { useEffect, useRef, useState } from 'react';
import { INTRO_DONE_EVENT, INTRO_FADE_MS, INTRO_POSTER, INTRO_SMALL_MEDIA, INTRO_SOURCES } from '@/lib/intro';

/** No frame has played this long after mount: give up and show the page. */
const START_TIMEOUT_MS = 5000;
/** Playback stopped advancing mid-clip (buffering) for this long: give up. */
const STALL_TIMEOUT_MS = 4000;
/** Absolute ceiling regardless of state (the clip itself is 7.25s). */
const HARD_CAP_MS = 20000;
const WATCHDOG_INTERVAL_MS = 250;

/**
 * Full-screen intro that plays the corgi clip once on load, then crossfades
 * into the page. See lib/intro.ts for the <html> class lifecycle.
 *
 * Every failure mode resolves to "show the page": autoplay refused (iOS Low
 * Power Mode, strict browser policies), a network error, a slow start, a
 * mid-clip stall, or a hard time cap. The video src is assigned here rather
 * than in markup so the right encode is picked per device and nothing is
 * downloaded when the intro is skipped up front.
 */
export default function IntroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const finishRef = useRef<() => void>(() => {});
  const finishedRef = useRef(false);
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const video = videoRef.current;

    if (!root.classList.contains('intro') || !video) {
      root.classList.remove('intro', 'intro-live', 'intro-out');
      window.dispatchEvent(new Event(INTRO_DONE_EVENT));
      setRemoved(true);
      return;
    }

    let active = true;
    let watchdog: number | undefined;
    let hardCap: number | undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };

    const stopWatching = () => {
      window.clearInterval(watchdog);
      window.clearTimeout(hardCap);
      video.removeEventListener('ended', finish);
      video.removeEventListener('error', finish);
      window.removeEventListener('keydown', onKey);
    };

    // A const arrow (not a hoisted function declaration) so TypeScript keeps
    // the `video` null-narrowing from the guard above inside this closure.
    const finish = (): void => {
      if (!active || finishedRef.current) return;
      finishedRef.current = true;
      stopWatching();
      root.classList.add('intro-out');
      window.dispatchEvent(new Event(INTRO_DONE_EVENT));
      window.setTimeout(() => {
        root.classList.remove('intro', 'intro-live', 'intro-out');
        video.pause();
        video.removeAttribute('src');
        video.load();
        setRemoved(true);
      }, INTRO_FADE_MS + 50);
    };

    finishRef.current = finish;
    root.classList.add('intro-live');

    const src = window.matchMedia(INTRO_SMALL_MEDIA).matches ? INTRO_SOURCES.small : INTRO_SOURCES.large;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    if (video.getAttribute('src') !== src) video.src = src;

    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);
    window.addEventListener('keydown', onKey);

    let lastTime = -1;
    let lastProgressAt = performance.now();
    let started = false;
    watchdog = window.setInterval(() => {
      const now = performance.now();
      // A background tab may legitimately hold playback; don't count that.
      if (document.hidden) {
        lastProgressAt = now;
        return;
      }
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastProgressAt = now;
        if (lastTime > 0) started = true;
        return;
      }
      if (now - lastProgressAt > (started ? STALL_TIMEOUT_MS : START_TIMEOUT_MS)) finish();
    }, WATCHDOG_INTERVAL_MS);
    hardCap = window.setTimeout(finish, HARD_CAP_MS);

    const attempt = video.play();
    if (attempt) {
      attempt.catch((error: unknown) => {
        // AbortError only means a load was superseded; the watchdog still
        // covers it. Anything else (NotAllowedError etc.) means no intro.
        if ((error as { name?: string } | null)?.name !== 'AbortError') finish();
      });
    }

    return () => {
      active = false;
      stopWatching();
    };
  }, []);

  if (removed) return null;

  return (
    <div className="intro-overlay">
      <video
        ref={videoRef}
        className="intro-video"
        poster={INTRO_POSTER}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
      />
      <button type="button" className="intro-skip" onClick={() => finishRef.current()}>
        Skip intro
      </button>
    </div>
  );
}
