import type { ToolName } from '@shared/types'
import type { ToolDef } from '../../openrouter/client'

export function getToolDefinitions(mode: 'agent' | 'plan'): ToolDef[] {
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
        description: 'Search files with regex using ripgrep.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
            case_insensitive: { type: 'boolean' }
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
        description: 'Search the web for documentation or errors.',
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
        description: 'Fetch a URL and return readable text.',
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
        description: 'Spawn a subagent with isolated context. Returns a summary only.',
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
        description: 'Save a plan artifact (plan mode only).',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            title: { type: 'string' },
            markdown: { type: 'string' }
          },
          required: ['slug', 'title', 'markdown']
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
    'ask_question',
    'task',
    'save_plan'
  ])

  const agentAllowed = new Set<ToolName>([
    'read_file',
    'write_file',
    'edit_file',
    'delete_file',
    'grep',
    'glob',
    'run_command',
    'web_search',
    'fetch_url',
    'list_skills',
    'read_skill',
    'write_memory',
    'task',
    'ask_question'
  ])

  const allowed = mode === 'plan' ? planAllowed : agentAllowed
  return all.filter((t) => allowed.has(t.function.name as ToolName))
}
