import PageBody from './generated/PageBody';

// The entire page is generated markup; this file only mounts it.
// Server-rendered so the HTML matches the captured document on first paint.
export default function Page() {
  return <PageBody />;
}
