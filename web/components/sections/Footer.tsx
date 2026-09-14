import Image from 'next/image';
import GithubIcon from '@/components/GithubIcon';

const GITHUB_URL = 'https://github.com/DanTahir/KlennyCode';

export default function Footer() {
  return (
    <footer className="mx-auto mt-24 max-w-shell px-6 py-10 text-sm text-corgi-cream/50">
      <div className="flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
        <div className="flex items-center gap-2">
          <Image
            src="/Klenny.jpg"
            alt=""
            aria-hidden="true"
            width={22}
            height={22}
            className="rounded-full"
          />
          <span>Klenny Code — MIT licensed, open source</span>
        </div>

        <div className="flex items-center gap-5">
          <a href={GITHUB_URL} className="inline-flex items-center gap-1.5 hover:text-corgi-cream">
            <GithubIcon />
            GitHub
          </a>
          <a href={`${GITHUB_URL}/blob/main/LICENSE`} className="hover:text-corgi-cream">
            License
          </a>
          <a href="https://openrouter.ai" className="hover:text-corgi-cream">
            Powered by OpenRouter
          </a>
        </div>
      </div>
    </footer>
  );
}
