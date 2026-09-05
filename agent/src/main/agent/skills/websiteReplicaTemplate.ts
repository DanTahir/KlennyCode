/** Asset manifest for the bundled `website-replica` skill's project template.
 *
 *  Unlike every other bundled skill, `website-replica` is not just a SKILL.md: the skill is
 *  useless without the 34-file Next.js project template it tells the agent to copy. That template
 *  therefore has to ship with the app and be seeded to disk alongside the SKILL.md (see
 *  manager.ts's seedBundledSkills + BundledSkill.assets).
 *
 *  Why the files are vendored with a `.txt` suffix
 *  ----------------------------------------------
 *  The template contains real `.ts`/`.tsx`/`.mjs` sources for a *different* project (Next 15 +
 *  React 19 + Vitest). Vendored under their true extensions inside src/main/, they would be swept
 *  up by this repo's own tooling and break the build:
 *    - tsconfig.node.json includes `src/main/**\/*`, so `tsc --noEmit` would type-check them
 *      against the agent's own config, where `next`/`react`/`vitest` imports don't resolve.
 *    - `bun test` auto-discovers `*.test.ts`, so the template's own effects.test.ts /
 *      generated.test.ts would be collected into KlennyCode's suite and fail on missing `vitest`.
 *  Appending `.txt` makes them inert to both (tsc only compiles .ts/.tsx; bun only collects
 *  *.test.ts), while Vite's `?raw` import is extension-agnostic so the content still inlines into
 *  the main bundle at build time. The seeder strips the suffix when writing to disk via the
 *  destination paths below.
 *
 *  Consequence worth knowing: because `?raw` inlines the bytes into out/main/index.js, the
 *  template needs NO electron-builder `files`/`extraResources`/asarUnpack entry. Don't "fix" that
 *  by adding one.
 *
 *  Editing the template: edit the `.txt` files under ./bundled/website-replica-template/ directly
 *  (they're the real thing, just suffixed), then bump `version` on the `website-replica` entry in
 *  bundledSkills.ts so existing installs pick the change up. Per-file edit detection means a user
 *  who customised one template file keeps their copy of that file and still receives updates to
 *  the rest.
 */

import tplGitignore from './bundled/website-replica-template/.gitignore.txt?raw'
import tplReadme from './bundled/website-replica-template/README.md.txt?raw'
import tplPackageJson from './bundled/website-replica-template/package.json.txt?raw'
import tplTsconfig from './bundled/website-replica-template/tsconfig.json.txt?raw'
import tplNextConfig from './bundled/website-replica-template/next.config.mjs.txt?raw'
import tplVitestConfig from './bundled/website-replica-template/vitest.config.ts.txt?raw'
import tplReplicaConfigExample from './bundled/website-replica-template/replica.config.example.json.txt?raw'

import tplAppLayout from './bundled/website-replica-template/app/layout.tsx.txt?raw'
import tplAppPage from './bundled/website-replica-template/app/page.tsx.txt?raw'
import tplAppClientRuntime from './bundled/website-replica-template/app/ClientRuntime.tsx.txt?raw'
import tplAppGeneratedPageBody from './bundled/website-replica-template/app/generated/PageBody.tsx.txt?raw'
import tplAppGeneratedIndexCss from './bundled/website-replica-template/app/generated/index.css.txt?raw'
import tplAppGeneratedMetadata from './bundled/website-replica-template/app/generated/metadata.ts.txt?raw'

import tplLibIndex from './bundled/website-replica-template/app/lib/index.ts.txt?raw'
import tplLibRuntime from './bundled/website-replica-template/app/lib/runtime.ts.txt?raw'
import tplLibFadeIn from './bundled/website-replica-template/app/lib/fadeIn.ts.txt?raw'
import tplLibNav from './bundled/website-replica-template/app/lib/nav.ts.txt?raw'
import tplLibReveal from './bundled/website-replica-template/app/lib/reveal.ts.txt?raw'
import tplLibForms from './bundled/website-replica-template/app/lib/forms.ts.txt?raw'
import tplLibAdapters from './bundled/website-replica-template/app/lib/adapters.ts.txt?raw'

import tplScriptCapture from './bundled/website-replica-template/scripts/capture.mjs.txt?raw'
import tplScriptScrape from './bundled/website-replica-template/scripts/scrape.mjs.txt?raw'
import tplScriptAnalyze from './bundled/website-replica-template/scripts/analyze.mjs.txt?raw'
import tplScriptCodegen from './bundled/website-replica-template/scripts/codegen.mjs.txt?raw'
import tplScriptFetchExtras from './bundled/website-replica-template/scripts/fetch-extras.mjs.txt?raw'
import tplScriptViewportCheck from './bundled/website-replica-template/scripts/viewport-check.mjs.txt?raw'
import tplScriptCompareLive from './bundled/website-replica-template/scripts/compare-live.mjs.txt?raw'
import tplScriptDev from './bundled/website-replica-template/scripts/dev.mjs.txt?raw'
import tplScriptLibConfig from './bundled/website-replica-template/scripts/lib/config.mjs.txt?raw'
import tplScriptLibChromium from './bundled/website-replica-template/scripts/lib/chromium.mjs.txt?raw'
import tplScriptLibAssets from './bundled/website-replica-template/scripts/lib/assets.mjs.txt?raw'

import tplTestSetup from './bundled/website-replica-template/tests/setup.ts.txt?raw'
import tplTestEffects from './bundled/website-replica-template/tests/effects.test.ts.txt?raw'
import tplTestGenerated from './bundled/website-replica-template/tests/generated.test.ts.txt?raw'

/** Destination path (relative to the seeded skill's own directory, i.e.
 *  `<global skills dir>/website-replica/`) -> file content.
 *
 *  Keys deliberately keep the `template/` prefix: the SKILL.md instructs the agent to copy
 *  `~/.klenny/skills/website-replica/template/.` into the new project, so these paths and that
 *  documented location have to agree. Suffix-free by design — the `.txt` vendoring suffix is a
 *  build-tooling concern that must not leak into the seeded output. */
export const WEBSITE_REPLICA_TEMPLATE: Record<string, string> = {
  'template/.gitignore': tplGitignore,
  'template/README.md': tplReadme,
  'template/package.json': tplPackageJson,
  'template/tsconfig.json': tplTsconfig,
  'template/next.config.mjs': tplNextConfig,
  'template/vitest.config.ts': tplVitestConfig,
  'template/replica.config.example.json': tplReplicaConfigExample,

  'template/app/layout.tsx': tplAppLayout,
  'template/app/page.tsx': tplAppPage,
  'template/app/ClientRuntime.tsx': tplAppClientRuntime,
  'template/app/generated/PageBody.tsx': tplAppGeneratedPageBody,
  'template/app/generated/index.css': tplAppGeneratedIndexCss,
  'template/app/generated/metadata.ts': tplAppGeneratedMetadata,

  'template/app/lib/index.ts': tplLibIndex,
  'template/app/lib/runtime.ts': tplLibRuntime,
  'template/app/lib/fadeIn.ts': tplLibFadeIn,
  'template/app/lib/nav.ts': tplLibNav,
  'template/app/lib/reveal.ts': tplLibReveal,
  'template/app/lib/forms.ts': tplLibForms,
  'template/app/lib/adapters.ts': tplLibAdapters,

  'template/scripts/capture.mjs': tplScriptCapture,
  'template/scripts/scrape.mjs': tplScriptScrape,
  'template/scripts/analyze.mjs': tplScriptAnalyze,
  'template/scripts/codegen.mjs': tplScriptCodegen,
  'template/scripts/fetch-extras.mjs': tplScriptFetchExtras,
  'template/scripts/viewport-check.mjs': tplScriptViewportCheck,
  'template/scripts/compare-live.mjs': tplScriptCompareLive,
  'template/scripts/dev.mjs': tplScriptDev,
  'template/scripts/lib/config.mjs': tplScriptLibConfig,
  'template/scripts/lib/chromium.mjs': tplScriptLibChromium,
  'template/scripts/lib/assets.mjs': tplScriptLibAssets,

  'template/tests/setup.ts': tplTestSetup,
  'template/tests/effects.test.ts': tplTestEffects,
  'template/tests/generated.test.ts': tplTestGenerated
}
