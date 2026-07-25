import type { ToolName } from '@shared/types'
import { CODING_ONLY_TOOLS } from '@shared/types'
import type { ToolDef } from '../../openrouter/client'

export function getToolDefinitions(
  mode: 'agent' | 'plan',
  restrictTo?: ToolName[] | 'all',
  /** false (default) hides codebase_search entirely — the model never sees a tool it can't use, avoiding confusing failures when the feature isn't configured. */
  codebaseSearchAvailable = false,
  /** true (default) means coding tools (file r/w, run_command, codebase_search) stay available
   *  as before. Pass false for the ephemeral Assistant tab or any tab with no real workspace
   *  open — see CODING_ONLY_TOOLS in shared/types.ts and the Personal Assistant Platform plan's
   *  tool-gating design. */
  hasWorkspace = true
): ToolDef[] {
  const all: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file with optional offset/limit. Line numbers (1|) are display-only — never include them in edit_file old_string.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write or overwrite a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Edit a file by replacing old_string with new_string. You must read_file first and copy the exact text for old_string (no line-number prefixes). Use replace_all when renaming or changing every occurrence.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: {
              type: 'boolean',
              description: 'Replace every occurrence (use for renames across a file)'
            }
          },
          required: ['path', 'old_string', 'new_string']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'multi_edit',
        description:
          'Batch multiple edit_file-style replacements, across one file or several, into a single call that needs only one approval. Prefer this over several separate edit_file calls whenever you already know all the changes you want to make (for example updating the same file in 3 places, or making a coordinated change across multiple files) - it cuts down on repeated round-trips and approval prompts. Edits are validated as one all-or-nothing batch: if any old_string fails to match, nothing is written. Edits are applied in order, so a later edit can target text produced by an earlier edit to the same file. Each edit follows the same rules as edit_file: old_string must match file contents exactly (read_file first, no line-number prefixes), and replace_all replaces every occurrence of the old_string within that edit.',
        parameters: {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              description: 'One or more edits to apply, each targeting a path (the same file may repeat across entries).',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  old_string: { type: 'string' },
                  new_string: { type: 'string' },
                  replace_all: { type: 'boolean', description: 'Replace every occurrence within that edit.' }
                },
                required: ['path', 'old_string', 'new_string']
              }
            }
          },
          required: ['edits']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description:
          'Search files with regex using ripgrep. Set context to include surrounding lines (like grep -C) — use it instead of a follow-up read_file when the match lines alone are enough to decide what to do or to see what to pass as old_string in edit_file.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
            case_insensitive: { type: 'boolean' },
            context: { type: 'number', description: 'Lines of context before/after each match, 0-10 (default 0).' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'glob',
        description: 'Find files by glob pattern.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, cwd: { type: 'string' } },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Run a shell command for builds, tests, git, and package managers. Do NOT use this to create or edit files — use write_file or edit_file instead.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' },
            timeout_ms: { type: 'number' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for documentation or errors. Returns a list of { title, url } results — pass a result\'s url to fetch_url to read its content.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'Fetch a URL and return readable text. Fails with ok:false on a non-2xx response or a non-text/HTML content-type (e.g. PDFs, images) — do not retry the same URL after that, try a different source instead.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_skills',
        description: 'List available Cursor-style skills.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_skill',
        description: 'Read full skill instructions by path from list_skills.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_memory',
        description:
          'Read the full content of one auto-memory topic note by its exact title, as shown in the Auto-memory index in the system prompt (e.g. "Shell selection feature"). Do NOT use read_file for this — memory notes live outside the workspace tree, not in the project filesystem.',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['project', 'global'] },
            topic: { type: 'string' }
          },
          required: ['scope', 'topic']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_memory',
        description: 'Persist a memory note (topic + content).',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['project', 'global'] },
            topic: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['scope', 'topic', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task',
        description:
          "Delegate a self-contained chunk of work to a subagent that runs in its own isolated context window and reports back only a final summary. Use it proactively, before doing the work yourself, when a step is open-ended or likely to take many tool calls — broad codebase exploration, multi-file research, hunting for where something is handled, verifying a hypothesis across many files — so that exploration noise (file reads, grep hits, dead ends) stays out of your own context instead of bloating it. Also use it to fan out independent, parallelizable lookups by issuing multiple task calls in the same turn (e.g. researching several unrelated libraries at once). Do NOT delegate a single small, well-scoped edit or lookup you could finish yourself in 1-2 tool calls — the round-trip isn't worth it there. Pick agent_type from the Subagents catalog in the system prompt. Write `prompt` as a fully self-contained brief: the subagent sees nothing else from this conversation, so include all relevant context, files, and the exact question or outcome you need back.",
        parameters: {
          type: 'object',
          properties: {
            agent_type: { type: 'string' },
            prompt: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['agent_type', 'prompt']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ask_question',
        description: 'Ask the user structured clarifying questions. Blocks until answered.',
        parameters: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  prompt: { type: 'string' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { id: { type: 'string' }, label: { type: 'string' } },
                      required: ['id', 'label']
                    }
                  },
                  allowMultiple: { type: 'boolean' }
                },
                required: ['id', 'prompt', 'options']
              }
            }
          },
          required: ['questions']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_plan',
        description: 'Save a plan artifact (plan mode only). The plan is shown to the user as its own tab with an Approve button.',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Short kebab-case identifier, e.g. "add-dark-mode-toggle".' },
            title: { type: 'string', description: 'Short human-readable plan title, shown in tabs and lists.' },
            markdown: {
              type: 'string',
              description:
                'Full plan body in Markdown. Must start with a "# Title" heading, use "##" subheadings (e.g. Overview, Approach/Steps, Risks/Open questions), and use numbered/bulleted lists and tables where they aid clarity.'
            }
          },
          required: ['slug', 'title', 'markdown']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_projects',
        description:
          'List other projects Klenny has previously opened on this machine (read-only, excludes the current workspace). Use this to discover exact project paths before calling read_other_project_file / grep_other_project / glob_other_project / read_other_project_memory — e.g. when the user says "port feature X from my other project Y".',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_other_project_file',
        description:
          'Read a file from a DIFFERENT project Klenny has previously opened (read-only — there is no write/edit equivalent). "project" must be an exact path from list_projects (or an unambiguous folder name). Never use this on the current workspace — use read_file for that.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Path (or unique folder name) of the other project, as returned by list_projects.' },
            path: { type: 'string', description: 'File path relative to that project\'s root (or absolute, inside it).' },
            offset: { type: 'number' },
            limit: { type: 'number' }
          },
          required: ['project', 'path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grep_other_project',
        description: 'Search files with regex (ripgrep) inside a DIFFERENT known project. Same semantics as grep, scoped to that project.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Path (or unique folder name) of the other project, as returned by list_projects.' },
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
            case_insensitive: { type: 'boolean' },
            context: { type: 'number', description: 'Lines of context before/after each match, 0-10 (default 0).' }
          },
          required: ['project', 'pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'glob_other_project',
        description: 'Find files by glob pattern inside a DIFFERENT known project. Same semantics as glob, scoped to that project.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Path (or unique folder name) of the other project, as returned by list_projects.' },
            pattern: { type: 'string' },
            cwd: { type: 'string' }
          },
          required: ['project', 'pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_other_project_memory',
        description:
          'Read memory from a DIFFERENT known project: its KLENNY.md/auto-memory index and topic list (omit "topic"), or one specific auto-memory topic note (set "topic" to its exact title). Only "scope": "project" is meaningful here — global memory is shared everywhere, so use read_memory for that instead.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Path (or unique folder name) of the other project, as returned by list_projects.' },
            scope: { type: 'string', enum: ['project', 'global'] },
            topic: { type: 'string', description: 'Optional — exact auto-memory topic title. Omit to get the overview + topic list.' }
          },
          required: ['project', 'scope']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'codebase_search',
        description:
          'Semantic search across the codebase — finds relevant code by meaning, not exact text. Use for "where is X handled" / "find code related to Y" style questions; use grep for exact string/symbol matches. Only available when the user has enabled codebase indexing in Settings.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            topK: { type: 'number', description: 'Max results, default 8' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_settings_panel',
        description:
          'Switches the app to the Settings screen and focuses a specific section — use this when the user asks to connect/configure something (e.g. "connect my Gmail") instead of just telling them where to click.',
        parameters: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              enum: ['integrations', 'general', 'models', 'automation', 'appearance'],
              description:
                '"integrations" for Gmail/Discord connection UI, "automation" for Automation Permissions, "appearance" for custom app name/icon/animation branding.'
            }
          },
          required: ['section']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'gmail_list_messages',
        description: 'List Gmail messages matching an optional Gmail search query (e.g. "is:unread from:boss@example.com"). Requires Gmail to be connected in Settings.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Gmail search syntax; omit to list the most recent messages.' },
            maxResults: { type: 'number', description: 'Max results, default 10, hard cap 25.' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'gmail_get_message',
        description: 'Fetch one Gmail message\'s headers and snippet by id (from gmail_list_messages).',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'gmail_send_message',
        description: 'Send an email via the connected Gmail account. Disabled by default until the user enables gmail.send in Automation Permissions.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' }
          },
          required: ['to', 'subject', 'body']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'discord_post_message',
        description: 'Post a message to a Discord channel or DM via the connected bot. Disabled by default until the user enables discord.post in Automation Permissions.',
        parameters: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Discord channel or DM channel id to post into.' },
            text: { type: 'string' }
          },
          required: ['channelId', 'text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'scheduler_create_task',
        description:
          'Create a background task that runs as an unattended subagent on a cron schedule (e.g. "0 8 * * *" for every day at 8am). ' +
          'IMPORTANT — one-time vs. recurring: if the user names a single moment ("at 8pm", "in 10 minutes", "tomorrow morning") without ' +
          'saying it should repeat, treat it as a ONE-TIME task: set `schedule` to the cron expression for that single next occurrence and ' +
          'set `maxRuns: 1` so it fires once and deletes itself. Only omit `maxRuns` (unlimited/indefinite) or set it >1 when the user explicitly ' +
          'asks for repetition ("every day", "every 10 minutes", "three times in a row", "each Monday", etc.) — in the "N times" case, set ' +
          '`maxRuns` to that N so the task self-deletes after its last run. When in doubt about which the user means, ask.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string', description: "Natural-language instruction the subagent will follow each time this task fires." },
            schedule: { type: 'string', description: 'Standard 5-field cron expression, evaluated in local time.' },
            targetWorkspace: { type: 'string', description: 'Absolute path of a known coding project to run against, or omit for the general Assistant tool context.' },
            maxCostUsd: { type: 'number', description: 'Optional per-run USD ceiling.' },
            maxRuns: {
              type: 'number',
              description:
                'Optional cap on total number of firings before the task automatically deletes itself. Use 1 for a one-time task ' +
                '("at 8pm", "in 10 minutes"), or N for "run N times" ("every 10 minutes, 3 times in a row"). Omit for a task that should ' +
                'recur indefinitely on its schedule until the user deletes it.'
            }
          },
          required: ['name', 'prompt', 'schedule']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'scheduler_list_tasks',
        description: 'List all scheduled background tasks and their last run status.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'scheduler_update_task',
        description: 'Update a scheduled task (e.g. change its schedule, prompt, or enabled state).',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            schedule: { type: 'string' },
            targetWorkspace: { type: 'string' },
            maxCostUsd: { type: 'number' },
            maxRuns: { type: 'number', description: 'See scheduler_create_task for semantics — how many more total firings before this task self-deletes.' },
            enabled: { type: 'boolean' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'scheduler_delete_task',
        description: 'Permanently delete a scheduled task.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser',
        description:
          "Local Playwright-driven browser automation, multiplexed by `action`. Gated by Settings -> Automation -> Browser automation: policy 'off' blocks every action, 'ask' queues mutating actions (click/type/fill/select/press_key/scroll/drag/submit/evaluate) for user approval with a screenshot preview, 'auto' executes them immediately. Read-only actions (open/close/list_tabs/navigate/snapshot/screenshot/inspect/wait_for/wait) never need approval as long as the policy isn't 'off'. Workflow: open a tab, navigate, then snapshot before acting — the snapshot returns an accessibility-tree-like list of interactive elements each tagged with a stable ref like 'e3'; pass that ref (not a CSS selector) to click/type/fill/select/press_key/scroll/drag/submit. Re-snapshot after any navigation or significant DOM change before reusing old refs, since they can go stale. Use screenshot sparingly (it costs real tokens) — prefer snapshot for deciding what to do next, and screenshot mainly to visually confirm a result or read something not well captured as text. When snapshot's role/name text isn't enough to tell elements apart (e.g. several similar-looking buttons), use `inspect` to run read-only JavaScript in the page and reason your way to the right one — call `klenny.ref(el)` on any element you find (or just return it/a NodeList directly, which auto-refs) to get back a ref string, then act on that ref with click/fill/etc. exactly like a snapshot ref; inspect can never itself click, submit, navigate, or write anything — mutation attempts are rejected. inspect works in subagents/scheduled tasks too. To pause while something runs on the page: prefer `wait_for` (polls for a ref/selector to appear, or falls back to waiting for the page's load state) since it returns as soon as its condition is met; use the plain `wait` action (fixed-duration sleep, e.g. duration_ms: 120000 for two minutes, capped at 5 minutes) only when there's nothing concrete to poll for, such as a server-side job with no visible DOM change. evaluate (raw, unrestricted JS in the page — can mutate/submit/navigate) is disabled by default and never available to subagents; prefer `inspect` for understanding a page and the ref-based actions for acting on it, and only reach for evaluate when the user has enabled it and no other action can do the job. For logins, 2FA, or anything requiring a human's judgment, stop and use ask_question rather than trying to power through. If a CAPTCHA appears in an interactive session (the browser window is visible to the user), don't fail — use ask_question to have the user solve it in the visible window, then re-snapshot and continue; in a headless subagent/scheduled run there's no one to solve it, so report it as a blocking failure instead.",
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'open',
                'close',
                'list_tabs',
                'navigate',
                'snapshot',
                'screenshot',
                'click',
                'type',
                'fill',
                'select',
                'press_key',
                'scroll',
                'drag',
                'submit',
                'evaluate',
                'inspect',
                'wait_for',
                'wait'
              ]
            },
            tab: { type: 'string', description: 'Agent-chosen label for the browser tab (defaults to "main"). Use distinct labels to work with multiple tabs in the same session.' },
            url: { type: 'string', description: 'Used by navigate (and optionally open, to navigate immediately after creating the tab).' },
            ref: { type: 'string', description: 'Element ref from the most recent snapshot or from an inspect call\'s klenny.ref()/auto-ref result (e.g. "e3"). Required by click/type/fill/select/press_key/drag/submit; optional scoping hint for scroll.' },
            text: { type: 'string', description: 'Used by type/fill (text to enter) and submit (optional text to fill before submitting).' },
            value: { type: 'string', description: 'Option value/label used by select.' },
            key: { type: 'string', description: 'Key name used by press_key, e.g. "Enter", "Escape", "Tab".' },
            dx: { type: 'number', description: 'Horizontal scroll delta in pixels, used by scroll.' },
            dy: { type: 'number', description: 'Vertical scroll delta in pixels, used by scroll.' },
            targetRef: { type: 'string', description: 'Destination element ref used by drag.' },
            code: {
              type: 'string',
              description:
                'JavaScript to run in the page. Used by both `inspect` (read-only — reads/queries only; mutation attempts like fetch/click()/innerHTML=/etc. are rejected, available everywhere including subagents) and `evaluate` (unrestricted — can mutate the page; disabled by default, never available to subagents, needs "Allow JavaScript evaluation" in Settings). Prefer `inspect` for figuring out which element is which; call klenny.ref(el) or just return the element/NodeList to get back a ref usable with click/fill/etc.'
            },
            selector: { type: 'string', description: 'Optional CSS selector used by wait_for instead of a ref.' },
            timeout_ms: { type: 'number', description: 'Timeout for wait_for, in milliseconds (default 5000, capped at 300000/5 minutes).' },
            duration_ms: { type: 'number', description: 'Fixed pause duration for the `wait` action, in milliseconds (default 5000, capped at 300000/5 minutes). Use this to pause for something running server-side with no DOM change to poll for, e.g. duration_ms: 120000 to wait two minutes.' }
          },
          required: ['action']
        }
      }
    }
  ]

  const planAllowed = new Set<ToolName>([
    'read_file',
    'grep',
    'glob',
    'web_search',
    'fetch_url',
    'list_skills',
    'read_skill',
    'read_memory',
    'ask_question',
    'task',
    'save_plan',
    'codebase_search',
    'list_projects',
    'read_other_project_file',
    'grep_other_project',
    'glob_other_project',
    'read_other_project_memory'
  ])

  const agentAllowed = new Set<ToolName>([
    'read_file',
    'write_file',
    'edit_file',
    'multi_edit',
    'delete_file',
    'grep',
    'glob',
    'run_command',
    'web_search',
    'fetch_url',
    'list_skills',
    'read_skill',
    'read_memory',
    'write_memory',
    'task',
    'ask_question',
    'codebase_search',
    'list_projects',
    'read_other_project_file',
    'grep_other_project',
    'glob_other_project',
    'read_other_project_memory',
    'open_settings_panel',
    'gmail_list_messages',
    'gmail_get_message',
    'gmail_send_message',
    'discord_post_message',
    'scheduler_create_task',
    'scheduler_list_tasks',
    'scheduler_update_task',
    'scheduler_delete_task',
    'browser'
  ])

  const allowed = mode === 'plan' ? planAllowed : agentAllowed
  let defs = all.filter((t) => allowed.has(t.function.name as ToolName))

  if (restrictTo && restrictTo !== 'all') {
    const restrictSet = new Set<ToolName>(restrictTo)
    // Always keep 'task' out for restricted (non-'all') subagent types — sub-subagents
    // are not supported — and always allow ask_question to be filtered out separately
    // by the caller for headless (subagent) runs.
    defs = defs.filter((t) => restrictSet.has(t.function.name as ToolName))
  }

  // Coding tools (file r/w, run_command, codebase_search) need a real workspace to operate on
  // — hide them entirely on the ephemeral Assistant tab / whenever no project is open, per the
  // Personal Assistant Platform plan's tool-gating design (CODING_ONLY_TOOLS in shared/types.ts).
  if (!hasWorkspace) {
    const codingOnly = new Set<ToolName>(CODING_ONLY_TOOLS)
    defs = defs.filter((t) => !codingOnly.has(t.function.name as ToolName))
  }

  // codebase_search is only ever surfaced when the feature is fully configured (enabled,
  // embeddings model chosen, OpenRouter key present) — the model should never see a tool
  // call that's guaranteed to fail because the caller forgot to check availability first.
  if (!codebaseSearchAvailable) {
    defs = defs.filter((t) => t.function.name !== 'codebase_search')
  }

  return defs
}
