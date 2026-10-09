/**
 * Shared contract for the home-page intro video (components/IntroVideo.tsx).
 *
 * Lifecycle, expressed as classes on <html> so CSS can drive every visual
 * state without waiting for React:
 *
 *   intro      added by INTRO_FLAG_SCRIPT in <head> before first paint. Shows
 *              the overlay (poster first) and hides the page underneath.
 *   intro-live added by IntroVideo once it has hydrated and taken control.
 *              Cancels the CSS-only failsafe and locks scrolling.
 *   intro-out  added when the video ends (or is skipped / fails). Runs the
 *              crossfade: overlay fades out while the page fades in.
 *
 * After INTRO_FADE_MS all three are removed and the overlay unmounts.
 */

/** Fired on window when the crossfade into the page starts. */
export const INTRO_DONE_EVENT = 'klenny:intro-done';

/** Must match the 1.2s transitions on .intro-overlay / page in globals.css. */
export const INTRO_FADE_MS = 1200;

export const INTRO_SOURCES = {
  large: '/intro/klenny-intro-1080.mp4',
  small: '/intro/klenny-intro-720.mp4',
} as const;

export const INTRO_POSTER = '/intro/klenny-intro-poster.jpg';

/** Phones (portrait or landscape) get the 720p encode. */
export const INTRO_SMALL_MEDIA = '(max-width: 767px), (max-height: 540px)';

/**
 * Inline <head> script. Only the home page plays the intro, and never under
 * prefers-reduced-motion or Save-Data. Wrapped in try/catch so a quirky
 * browser can only ever fail toward "no intro", never toward a hidden page.
 */
export const INTRO_FLAG_SCRIPT =
  '(function(){try{var d=document.documentElement,p=location.pathname,m=window.matchMedia,c=navigator.connection;' +
  'if((p==="/"||p==="/index.html")&&!(m&&m("(prefers-reduced-motion: reduce)").matches)&&!(c&&c.saveData)){d.classList.add("intro");}' +
  '}catch(e){}})();';
