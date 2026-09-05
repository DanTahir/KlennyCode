/** Content + version metadata for SKILL.md files bundled with the app and seeded into the global
 *  skills dir (see manager.ts's seedBundledSkills). The actual markdown lives in real .md files
 *  under ./bundled/ (edit those directly — no escaping, no template-literal wrangling) and is
 *  inlined at build time via Vite's `?raw` import, so this file only wires up versioning.
 *
 *  Editing a bundled skill going forward:
 *  1. Edit the .md file under ./bundled/ directly (it's a normal SKILL.md — frontmatter + body).
 *  2. Bump that skill's entry's `version` below (+1).
 *  3. That's it — manager.ts's seedBundledSkills() re-seeds the new content into every existing
 *     install's global skills dir next launch, but ONLY if the user hasn't edited their local
 *     copy since it was last seeded (detected via a content hash stored alongside the version in
 *     seed-state.json — see manager.ts). A user's own edits are never overwritten; they just stop
 *     receiving automatic updates for that one skill until they delete/reset it. A brand-new
 *     install always seeds the current version directly.
 *
 *  IMPORTANT — `legacyVariants`: before versioning existed, this app only tracked "have we ever
 *  seeded this skill" via a boolean marker file, not *which* content was seeded. Across releases,
 *  the shipped content for a skill can change multiple times before a `version` field is ever
 *  introduced for it — so a legacy (marker-only) install could be sitting on any one of several
 *  different historical variants, not just "the most recent one before versioning shipped". If
 *  the legacy-migration check only compares against one frozen baseline, everyone who happens to
 *  be on an earlier variant gets wrongly flagged as "user-edited" and permanently stops receiving
 *  updates for that skill. `legacyVariants` must list every distinct variant that was ever
 *  actually shipped under the marker-only scheme, oldest first, so the migration can match
 *  against any of them. Never edit files under ./bundled/_legacy/ after the fact — they're a
 *  frozen historical record, not current content. */

import browserAutomationMd from './bundled/browser-automation.md?raw'
import browserAutomationLegacy1Md from './bundled/_legacy/browser-automation.legacy-1.md?raw'
import browserAutomationLegacy2Md from './bundled/_legacy/browser-automation.legacy-2.md?raw'
import browserAutomationLegacy3Md from './bundled/_legacy/browser-automation.legacy-3.md?raw'
import pawprintAuthoringMd from './bundled/pawprint-authoring.md?raw'
import websiteReplicaMd from './bundled/website-replica.md?raw'
import { WEBSITE_REPLICA_TEMPLATE } from './websiteReplicaTemplate'

export interface BundledSkill {
  content: string
  /** Bump by 1 any time the .md content changes and you want existing installs to pick up the
   *  update (subject to the not-locally-edited check described above). */
  version: number
  /** Every distinct content variant this skill actually shipped as under the old marker-only
   *  seeding scheme (see the file-level doc comment above), oldest first. A legacy install's
   *  on-disk content is compared against each of these in turn; matching any of them means the
   *  user never touched the file, so it's safe to upgrade to the current `content`. Empty for any
   *  skill introduced after versioning already existed — it never shipped under the old
   *  marker-only scheme, so there's nothing to migrate from. */
  legacyVariants: string[]
  /** Optional extra files seeded into this skill's directory alongside SKILL.md, keyed by path
   *  relative to that directory (e.g. `template/app/page.tsx`). For skills that are useless
   *  without shipped scaffolding — currently only `website-replica` and its project template.
   *  Versioned by the same `version` field as `content`, but edit-detected per file, so a user
   *  who customises one asset keeps it and still gets updates to the rest (see manager.ts's
   *  seedSkillAssets). */
  assets?: Record<string, string>
}

export const BUNDLED_SKILLS: Record<string, BundledSkill> = {
  'browser-automation': {
    content: browserAutomationMd,
    version: 2,
    legacyVariants: [browserAutomationLegacy1Md, browserAutomationLegacy2Md, browserAutomationLegacy3Md]
  },
  'pawprint-authoring': {
    content: pawprintAuthoringMd,
    version: 1,
    legacyVariants: []
  },
  'website-replica': {
    content: websiteReplicaMd,
    version: 1,
    legacyVariants: [],
    assets: WEBSITE_REPLICA_TEMPLATE
  }
}
