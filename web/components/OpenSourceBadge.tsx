import GithubIcon from './GithubIcon';

const GITHUB_URL = 'https://github.com/DanTahir/KlennyCode';

export default function OpenSourceBadge() {
  return (
    <a
      href={GITHUB_URL}
      className="inline-flex items-center gap-2 rounded-full border border-corgi-orange/40 bg-corgi-orange/10 px-4 py-1.5 text-xs font-medium text-corgi-orange transition hover:bg-corgi-orange/20"
    >
      <GithubIcon />
      Free &amp; open source on GitHub
    </a>
  );
}
