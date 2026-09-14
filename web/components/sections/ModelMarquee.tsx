const MODELS = [
  'Claude',
  'GPT',
  'Gemini',
  'Grok',
  'DeepSeek',
  'Qwen',
  'Kimi',
  'Llama',
  'Mistral',
  'GLM',
  'Command',
  'MiniMax',
];

/**
 * "Works with any model" ticker. lib/effects/marquee.ts clones the track's
 * children once and animates it to -50%, so the loop is seamless.
 */
export default function ModelMarquee() {
  return (
    <section aria-label="Models available through OpenRouter" className="border-y border-white/8 bg-white/[0.015] py-7">
      <p data-reveal="" className="mb-5 text-center text-xs font-semibold uppercase tracking-[0.2em] text-corgi-cream/40">
        One key. Hundreds of models, via OpenRouter
      </p>

      <div className="marquee-mask overflow-hidden">
        <div data-marquee="" className="marquee-track gap-10 px-5">
          {MODELS.map((name) => (
            <span
              key={name}
              className="whitespace-nowrap font-display text-lg font-semibold text-corgi-cream/35 sm:text-xl"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
