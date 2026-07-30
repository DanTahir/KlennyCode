import type { ToolName } from '@shared/types'
import { ASSISTANT_TOOLS, CODING_ONLY_TOOLS, DOCX_TOOLS, GMAIL_READ_TOOLS, GMAIL_SEND_TOOLS, DISCORD_TOOLS } from '@shared/types'
import type { ToolDef } from '../../openrouter/client'

/** Gating inputs for the option-dependent tool families (docx/Gmail/Discord) — everything here
 *  defaults "closed" (undefined ~= false/not-connected) so a caller that forgets to pass one of
 *  these never accidentally over-shares a tool the user hasn't actually enabled/connected. See
 *  DOCX_TOOLS/GMAIL_TOOLS/DISCORD_TOOLS doc comments in shared/types.ts for the exact rules. */
export interface ToolGatingOptions {
  /** AppSettings.docxAvailableInCoding — only matters on project-kind tabs; Assistant tabs
   *  always get docx tools (as part of ASSISTANT_TOOLS) regardless of this flag. */
  docxAvailableInCoding?: boolean
  /** AppSettings.hasGmailToken */
  gmailConnected?: boolean
  /** settings.automationPermissions['gmail.read'] === 'auto' */
  gmailReadAllowed?: boolean
  /** settings.automationPermissions['gmail.send'] === 'auto' */
  gmailSendAllowed?: boolean
  /** AppSettings.gmailAvailableInCoding — only matters on project-kind tabs; the Assistant tab
   *  is gated purely on gmailConnected/gmailRead|SendAllowed above. */
  gmailAvailableInCoding?: boolean
  /** AppSettings.hasDiscordToken */
  discordConnected?: boolean
  /** settings.automationPermissions['discord.post'] === 'auto' */
  discordPostAllowed?: boolean
  /** AppSettings.discordAvailableInCoding — only matters on project-kind tabs; the Assistant tab
   *  is gated purely on discordConnected/discordPostAllowed above. */
  discordAvailableInCoding?: boolean
  /** (browserAutomation.policy ?? 'off') !== 'off' — every browser action is hard-blocked at
   *  dispatch time when the policy is 'off' (see loop.ts), so the tool is guaranteed to fail;
   *  hide it from the schema in that case rather than let the model call something that can
   *  only ever return an error. Applies identically to project and Assistant tabs — there is no
   *  isAssistant-specific override like docx's, since browser automation isn't scoped to a
   *  workspace either way. */
  browserAutomationAvailable?: boolean
}

export function getToolDefinitions(
  mode: 'agent' | 'plan',
  restrictTo?: ToolName[] | 'all',
  /** false (default) hides codebase_search entirely — the model never sees a tool it can't use, avoiding confusing failures when the feature isn't configured. */
  codebaseSearchAvailable = false,
  /** true (default) means coding tools that need a real project workspace (run_command,
   *  read_terminal, codebase_search — see CODING_ONLY_TOOLS in shared/types.ts) stay available.
   *  Pass false for any project tab with no workspace open. Ignored when `isAssistant` is true
   *  (Assistant tabs are gated by `isAssistant` alone, below — they never have a workspace but
   *  still get file tools, scoped to AppSettings.documentsDirectory instead). */
  hasWorkspace = true,
  /** true for the ephemeral Assistant tab (and any subagent spawned from one — see loop.ts's
   *  kind inheritance). Swaps in ASSISTANT_TOOLS as the allow-set instead of the mode's normal
   *  agent/plan set, so Assistant tabs only ever see exactly the tools ASSISTANT_TOOLS lists
   *  (file tools included, scoped to documentsDirectory; run_command/read_terminal/
   *  codebase_search/save_plan excluded) regardless of `restrictTo`/`hasWorkspace`. */
  isAssistant = false,
  /** docx/Gmail/Discord gating — see ToolGatingOptions. Every field defaults to false/absent
   *  when omitted, so existing callers (and tests) that don't pass this get none of those tools. */
  gating: ToolGatingOptions = {},
  /** false (default) hides update_checklist entirely — it's only meaningful once a plan has
   *  actually been approved into this tab (TabSession.activeChecklist is set); until then there's
   *  nothing for it to update, so the model should never see a tool call guaranteed to fail. */
  hasActiveChecklist = false
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
          'Batch multiple edit_file-style replacements, across one file or several, into a single call needing only one approval. Prefer this over separate edit_file calls whenever you already know all the changes you want to make. Validated as one all-or-nothing batch (if any old_string fails to match, nothing is written); edits apply in order, so a later edit can target text an earlier one just produced. Each edit follows edit_file\'s own rules: old_string must match file contents exactly (read_file first, no line-number prefixes). Top-level `path` is an optional default for any edit entry that omits its own `path`, so a batch can still span multiple files by giving those entries their own.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Optional default path applied to any edit entry that omits its own "path" — convenient when every edit targets the same file. Entries with their own "path" override this.'
            },
            edits: {
              type: 'array',
              description:
                'One or more edits to apply. Each may include its own "path" (needed when the batch spans multiple files); if omitted, it falls back to the top-level "path".',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  old_string: { type: 'string' },
                  new_string: { type: 'string' },
                  replace_all: { type: 'boolean', description: 'Replace every occurrence within that edit.' }
                },
                required: ['old_string', 'new_string']
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
        name: 'read_docx',
        description:
          'Read a Word .docx file into structured JSON: paragraphs (with per-run text/formatting), tables, headers/footers, images, comments, and tracked changes. Always read_docx before edit_docx on a given file so paraIndex/runIndex values line up with the current contents of the file.',
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
        name: 'write_docx',
        description:
          'Create a brand-new Word .docx from a structured spec (paragraphs, headings, runs with formatting, tables, images, page breaks, headers/footers). Overwrites path if it already exists — use edit_docx instead to modify an existing document while preserving everything not explicitly touched (comments, images, revisions, unknown formatting).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            orientation: { type: 'string', enum: ['portrait', 'landscape'] },
            header: {
              type: 'array',
              description: 'Paragraphs shown in the page header on every page.',
              items: { type: 'object' }
            },
            footer: {
              type: 'array',
              description: 'Paragraphs shown in the page footer on every page.',
              items: { type: 'object' }
            },
            children: {
              type: 'array',
              description:
                'Document body blocks in order. Each item is one of: {type:"paragraph", text|runs, heading (1-6), alignment, bullet, numbered, indentLevel, spacingBeforePt, spacingAfterPt}, {type:"image", path, widthPx, heightPx, alignment}, {type:"pageBreak"}, {type:"table", rows: [[{text|runs, colSpan, shading}]], headerRow, columnWidthsPct}. Runs are {text, bold, italic, underline, strike, font, sizePt, color, highlight, break}.',
              items: { type: 'object' }
            }
          },
          required: ['path', 'children']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_docx',
        description:
          'Apply one or more surgical edits to an existing Word .docx by directly patching its underlying XML — every paragraph/run/table/image/comment not explicitly touched survives byte-for-byte (unlike write_docx, which generates a whole new file). Always read_docx first so paraIndex/runIndex addressing matches the current contents of the file; if the file changed on disk since the last read_docx, edit_docx fails with a "stale" error and read_docx must be called again before retrying.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            ops: {
              type: 'array',
              description:
                'Each item is one of: {op:"setRunText", paraIndex, runIndex, text}, {op:"setRunFormat", paraIndex, runIndex, format:{bold,italic,underline,strike,font,sizePt,color,highlight}}, {op:"setParagraphFormat", paraIndex, alignment, style}, {op:"insertParagraph", afterParaIndex, text|runs, heading, alignment}, {op:"deleteParagraph", paraIndex}, {op:"insertTable", afterParaIndex, rows: [[{text|runs, colSpan}]], headerRow}, {op:"insertImage", afterParaIndex, path, widthPx, heightPx, description}, {op:"addComment", paraIndex, runIndexStart, runIndexEnd, text, author}. All ops accept an optional `part` (a header:/footer: key from read_docx, or omitted for the main document) to target headers/footers instead of the body.',
              items: { type: 'object' }
            }
          },
          required: ['path', 'ops']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_image',
        description:
          'Read an image file from disk (png/jpg/jpeg/gif/webp) and see it, exactly as if the user had pasted or attached it into the chat. Use this to look at screenshots, diagrams, design mockups, or any other image on the host filesystem. Accepts an absolute path (anywhere on the host) or a path relative to the open workspace.',
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
        name: 'read_terminal',
        description:
          'Read the user\'s interactive terminal panel log (plain text, ANSI stripped) — shows what the USER actually typed/ran, including past sessions (marked "=== Terminal session started/ended ==="), unlike run_command which only sees its own output. Use it to see context for a command or error the user mentioned without asking them to paste it.',
        parameters: {
          type: 'object',
          properties: {
            lines: { type: 'number', description: 'Number of most recent lines to return (default 200, max 5000).' }
          }
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
          'Read the full content of one auto-memory topic note by its exact title (as shown in the Auto-memory index). Not a file — memory notes live outside the workspace tree, so don\'t use read_file for this. Scope "assistant" (no topic needed) returns the full shared Assistant-window digest including this tab\'s own entry, unlike the auto-injected version which excludes it. For scope "project", pass `project` (a path/name from list_projects) to read a different project\'s memory instead of the current one; `project` is meaningless for scope "global"/"assistant".',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['project', 'global', 'assistant'] },
            topic: { type: 'string' },
            project: { type: 'string', description: 'Only for scope "project": path/name of a DIFFERENT known project (from list_projects). Omit for the current project.' }
          },
          required: ['scope']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_memory',
        description: 'Persist a memory note (topic + content). Always writes to the current workspace (scope "project") or the shared global store (scope "global") — there is no cross-project write; you can only ever write memory for the project you currently have open.',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['project', 'global'] },
            topic: {
              type: 'string',
              description:
                'Plain descriptive title, e.g. "Shell selection feature". Must NOT contain "/" or "\\" — the topic becomes a literal filename on disk, so a path separator is an illegal character and the call will fail.'
            },
            content: { type: 'string' }
          },
          required: ['scope', 'topic', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_memory',
        description:
          'Get a memory overview for a scope: the canonical KLENNY.md content plus the auto-memory index and the full list of auto-memory topic titles (use read_memory to load one topic\'s full content). For scope "project", pass `project` (a path/name from list_projects) to look at a DIFFERENT known project\'s memory instead of the current workspace\'s — omit it to mean the current project.',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['project', 'global'] },
            project: { type: 'string', description: 'Only for scope "project": path/name of a DIFFERENT known project (from list_projects). Omit for the current project.' }
          },
          required: ['scope']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_skill',
        description:
          'Create or overwrite a Cursor-style skill (a SKILL.md file with instructions you can later follow via read_skill). Use "project" scope for skills specific to this codebase (saved under .klenny/skills/ in the project), or "global" scope for skills useful across every project (saved under the global Klenny directory). Overwrites any existing skill with the same name in that scope.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short kebab-case skill identifier, e.g. "browser-automation". Used as the directory/file name.' },
            scope: { type: 'string', enum: ['project', 'global'], description: '"project" requires a workspace to be open.' },
            description: { type: 'string', description: 'One-line summary shown in the skills catalog — should help a future agent decide when to read this skill.' },
            body: { type: 'string', description: 'Full skill instructions in Markdown (the SKILL.md body, below the frontmatter).' }
          },
          required: ['name', 'scope', 'description', 'body']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_subagent',
        description:
          'Create or overwrite a custom subagent type (delegatable via the `task` tool). Use "project" scope for subagents specific to this codebase (saved under .klenny/agents/ in the project), or "global" scope for subagents useful across every project. Cannot overwrite the built-in subagent names (general-purpose, explore, plan-checker). Overwrites any existing custom subagent with the same name in that scope.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short kebab-case identifier, e.g. "bug-hunter". Used as the file name and the agent_type value passed to `task`.' },
            scope: { type: 'string', enum: ['project', 'global'], description: '"project" requires a workspace to be open.' },
            description: { type: 'string', description: 'One-line summary shown in the subagents catalog — should help a future agent decide when to delegate to this type.' },
            tools: {
              description: 'Either the literal string "all", or an array of tool names this subagent type is restricted to (e.g. ["read_file", "grep", "glob"]).',
              anyOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'string' } }]
            },
            model: { type: 'string', description: 'Optional OpenRouter model id override for this subagent type; omit to use the default subagent model.' },
            body: { type: 'string', description: 'Full system-prompt instructions for this subagent type, in Markdown (the file body, below the frontmatter).' }
          },
          required: ['name', 'scope', 'description', 'tools', 'body']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_subagent',
        description:
          'Read a subagent type\'s full definition by name (as listed in the Subagents catalog in the system prompt) — description, tool restriction, model override, and (for custom types) the full instruction body written via write_subagent. Use this before editing a custom subagent with write_subagent (which overwrites), or to inspect a built-in type\'s tool restriction.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact subagent type name, e.g. "explore" or a custom type\'s name.' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task',
        description:
          "Delegate a self-contained chunk of work to a subagent that runs in its own isolated context window and reports back only a final summary — keeps that exploration's tool calls and dead ends out of your own context. Pick agent_type from the Subagents catalog in the system prompt. Write `prompt` as a fully self-contained brief: the subagent sees nothing else from this conversation, so include all relevant context, files, and the exact question or outcome you need back.",
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
            },
            checklist: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Ordered list of the plan\'s major milestones (roughly 3-10 short items, one per big step of the Approach/Steps section — not every tiny sub-action). Shown to the user as a live-updating checklist once the plan is approved: call update_checklist to mark each item done as you actually finish it during implementation, and once more right before your closing summary. Testing should be its own item if the plan involves writing/updating tests and that isn\'t already covered by another item.'
            }
          },
          required: ['slug', 'title', 'markdown', 'checklist']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'update_checklist',
        description:
          "Mark items in the current plan's live-progress checklist as done/not-done, by 1-based index matching the order shown in the checklist widget. Call this as you actually finish each major milestone (not all at once at the end) so the user watches real progress, plus once more right before your final closing summary once everything is complete.",
        parameters: {
          type: 'object',
          properties: {
            updates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number', description: '1-based position of the item in the checklist.' },
                  done: { type: 'boolean' }
                },
                required: ['index', 'done']
              }
            }
          },
          required: ['updates']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_projects',
        description:
          'List other projects Klenny has previously opened on this machine (read-only, excludes the current workspace). Use this to discover exact project paths — e.g. before calling read_file/grep/glob with an absolute path into another project, or list_memory/read_memory with a `project` name — when the user says "port feature X from my other project Y".',
        parameters: { type: 'object', properties: {} }
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
          'Create a background task that runs as an unattended subagent on a cron schedule (e.g. "0 8 * * *" for every day at 8am). See the "Scheduling tasks" note elsewhere in this system prompt for the one-time-vs-recurring rule governing `maxRuns`.',
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
                'Cap on total firings before the task self-deletes — 1 for one-time, N for "run N times", omitted for indefinite recurrence. See the "Scheduling tasks" note for the full rule.'
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
          "Local Playwright-driven browser automation, multiplexed by `action`. Mutating actions (click/type/fill/select/press_key/scroll/drag/submit/evaluate) are queued for user approval with a screenshot preview under policy 'ask', or execute immediately under 'auto'; read-only actions (open/close/list_tabs/navigate/snapshot/screenshot/inspect/wait_for/wait) never need approval. Workflow: open a tab, navigate, then snapshot before acting — the snapshot returns interactive elements each tagged with a stable ref like 'e3'; pass that ref (not a CSS selector) to click/type/fill/select/press_key/scroll/drag/submit, and re-snapshot after any navigation or significant DOM change since old refs can go stale. Use screenshot sparingly (costs real tokens) — prefer snapshot, and screenshot mainly to visually confirm a result. When snapshot's role/name text isn't enough to tell similar elements apart, use `inspect` to run read-only JavaScript and call `klenny.ref(el)` on an element (or return it/a NodeList directly) to get back a usable ref; inspect can never itself click, submit, navigate, or mutate, and works in subagents too. Prefer `wait_for` (polls for a ref/selector, returns as soon as met) over `wait` (fixed-duration sleep, capped at 5 minutes) — only use `wait` when there's nothing concrete to poll for, like a server-side job with no visible DOM change. `evaluate` (unrestricted JS — can mutate/navigate) is disabled by default and never available to subagents; prefer `inspect` plus ref-based actions, and only reach for evaluate when the user has enabled it and nothing else can do the job. For logins, 2FA, or anything requiring a human's judgment, stop and use ask_question. If a CAPTCHA appears in an interactive session, use ask_question to have the user solve it in the visible window then re-snapshot and continue; in a headless subagent/scheduled run, report it as a blocking failure instead.",
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
                'JavaScript to run in the page. Used by `inspect` (read-only; mutation attempts like fetch/click()/innerHTML=/etc. are rejected) and `evaluate` (unrestricted — see the tool description for its gating). Call klenny.ref(el) or return the element/NodeList directly to get back a ref usable with click/fill/etc.'
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
    'read_image',
    'grep',
    'glob',
    'read_terminal',
    'web_search',
    'fetch_url',
    'list_skills',
    'read_skill',
    'read_memory',
    'list_memory',
    'read_subagent',
    'ask_question',
    'task',
    'save_plan',
    'codebase_search',
    'list_projects'
  ])

  const agentAllowed = new Set<ToolName>([
    'read_file',
    'write_file',
    'edit_file',
    'multi_edit',
    'delete_file',
    'read_image',
    'read_docx',
    'write_docx',
    'edit_docx',
    'grep',
    'glob',
    'run_command',
    'read_terminal',
    'web_search',
    'fetch_url',
    'list_skills',
    'read_skill',
    'read_memory',
    'write_memory',
    'list_memory',
    'write_skill',
    'write_subagent',
    'read_subagent',
    'task',
    'ask_question',
    'update_checklist',
    'codebase_search',
    'list_projects',
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

  // Assistant tabs get their own fixed allow-set (ASSISTANT_TOOLS, shared/types.ts) instead of
  // the mode's normal plan/agent set — this is what lets file tools (read/write/edit/multi_edit/
  // delete/grep/glob) reach Assistant tabs (scoped to documentsDirectory by the caller) while
  // still excluding workspace-only tools like run_command/read_terminal/codebase_search/save_plan.
  const assistantAllowed = new Set<ToolName>(ASSISTANT_TOOLS)
  const allowed = isAssistant ? assistantAllowed : mode === 'plan' ? planAllowed : agentAllowed
  let defs = all.filter((t) => allowed.has(t.function.name as ToolName))

  if (restrictTo && restrictTo !== 'all') {
    const restrictSet = new Set<ToolName>(restrictTo)
    // Always keep 'task' out for restricted (non-'all') subagent types — sub-subagents
    // are not supported — and always allow ask_question to be filtered out separately
    // by the caller for headless (subagent) runs.
    defs = defs.filter((t) => restrictSet.has(t.function.name as ToolName))
  }

  // Tools that need a real project workspace get hidden on a project-kind tab whenever no
  // project is open: CODING_ONLY_TOOLS (run_command/read_terminal/codebase_search) plus the file
  // tools, since on a project tab (unlike an Assistant tab) they have no fallback root to resolve
  // relative paths or sandbox mutations against — see resolveWorkspacePath/assertInRoot in
  // file-ops.ts, which only take an explicit `root` for Assistant-tab calls. This never applies
  // to Assistant tabs — they're already scoped to exactly ASSISTANT_TOOLS above, which routes
  // file tools through documentsDirectory regardless of hasWorkspace.
  if (!isAssistant && !hasWorkspace) {
    const needsWorkspace = new Set<ToolName>([
      ...CODING_ONLY_TOOLS,
      ...DOCX_TOOLS,
      'read_file',
      'write_file',
      'edit_file',
      'multi_edit',
      'delete_file',
      'read_image',
      'grep',
      'glob'
    ])
    defs = defs.filter((t) => !needsWorkspace.has(t.function.name as ToolName))
  }

  // codebase_search is only ever surfaced when the feature is fully configured (enabled,
  // embeddings model chosen, OpenRouter key present) — the model should never see a tool
  // call that's guaranteed to fail because the caller forgot to check availability first.
  if (!codebaseSearchAvailable) {
    defs = defs.filter((t) => t.function.name !== 'codebase_search')
  }

  // update_checklist: only ever offered once this tab actually has an active checklist to
  // update (see hasActiveChecklist's doc comment above) — never in plan mode (save_plan is what
  // creates the checklist in the first place) and never on an Assistant tab (not part of
  // ASSISTANT_TOOLS, same as save_plan).
  if (!hasActiveChecklist) {
    defs = defs.filter((t) => t.function.name !== 'update_checklist')
  }

  // Word .docx tools: always fine on the Assistant tab (already scoped to exactly
  // ASSISTANT_TOOLS above). On a project-kind tab, additionally require
  // AppSettings.docxAvailableInCoding — most coding projects have no use for Word documents,
  // so keep the tool off the model's radar there unless the user explicitly opts in.
  if (!isAssistant && !gating.docxAvailableInCoding) {
    defs = defs.filter((t) => !(DOCX_TOOLS as string[]).includes(t.function.name))
  }

  // Gmail tools: gated everywhere (Assistant tab included) on being connected and on the
  // relevant automation permission — a tool that's guaranteed to fail should never be offered.
  // On a project-kind tab, additionally require AppSettings.gmailAvailableInCoding.
  const gmailReadOk = Boolean(gating.gmailConnected && gating.gmailReadAllowed) && (isAssistant || Boolean(gating.gmailAvailableInCoding))
  const gmailSendOk = Boolean(gating.gmailConnected && gating.gmailSendAllowed) && (isAssistant || Boolean(gating.gmailAvailableInCoding))
  if (!gmailReadOk) {
    defs = defs.filter((t) => !(GMAIL_READ_TOOLS as string[]).includes(t.function.name))
  }
  if (!gmailSendOk) {
    defs = defs.filter((t) => !(GMAIL_SEND_TOOLS as string[]).includes(t.function.name))
  }

  // Discord tools: same pattern as Gmail — gated everywhere on being connected and on
  // automationPermissions['discord.post'], plus AppSettings.discordAvailableInCoding on a
  // project-kind tab.
  const discordOk = Boolean(gating.discordConnected && gating.discordPostAllowed) && (isAssistant || Boolean(gating.discordAvailableInCoding))
  if (!discordOk) {
    defs = defs.filter((t) => !(DISCORD_TOOLS as string[]).includes(t.function.name))
  }

  // Browser automation: hidden from both project and Assistant tabs whenever the policy is
  // 'off' (the default) — see browserAutomationAvailable's doc comment above. Plan mode never
  // included 'browser' in planAllowed in the first place, so this is a no-op there.
  if (!gating.browserAutomationAvailable) {
    defs = defs.filter((t) => t.function.name !== 'browser')
  }

  return defs
}
