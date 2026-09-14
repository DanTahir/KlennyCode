import { mountCardGlow } from './cardGlow';
import { mountCounters } from './counters';
import { mountMarquee } from './marquee';
import { mountNavScroll } from './navScroll';
import { mountReveal } from './reveal';
import { mountSpotlight } from './spotlight';
import { mountTilt } from './tilt';
import { mountTypewriter } from './typewriter';
import { mountWordReveal } from './wordReveal';
import { NOOP, type EffectFactory, type Teardown } from './shared';

export const EFFECTS: EffectFactory[] = [
  mountReveal,
  mountWordReveal,
  mountTypewriter,
  mountCounters,
  mountMarquee,
  mountSpotlight,
  mountNavScroll,
  mountTilt,
  mountCardGlow,
];

/**
 * Mounts every effect and returns a single teardown. One failing module must
 * never prevent the others from running -- especially mountReveal, which is
 * what makes revealed content visible.
 */
export function mountEffects(): Teardown {
  const teardowns = EFFECTS.map((factory) => {
    try {
      return factory();
    } catch (error) {
      console.error('[effects] failed to mount', factory.name, error);
      return NOOP;
    }
  });

  return () => {
    teardowns.forEach((teardown) => {
      try {
        teardown();
      } catch (error) {
        console.error('[effects] failed to tear down', error);
      }
    });
  };
}

export type { Teardown, EffectFactory };
