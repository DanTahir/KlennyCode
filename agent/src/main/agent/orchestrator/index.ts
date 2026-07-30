// Barrel for the orchestrator module. Split by concern into state.ts (shared mutable
// state/types), approval-previews.ts (approval-dialog previews + spend cap), system-prompt.ts
// (system prompt assembly), loop.ts (the core agentLoop/executeTool/dispatchTool/runSubagent
// mutual-recursion cluster), turn-lifecycle.ts (runUserTurn/continueTurn/stopGeneration/etc.),
// and scheduled-and-discord.ts (unattended scheduled-task and Discord-bridge entry points) — see
// each file for details. This file re-exports everything so existing imports
// (`from './agent/orchestrator'` / `from './orchestrator'`) keep working unchanged.
export { runUserTurn, approvePlan, continueTurn, stopGeneration, resolveQuestion, clearTabState, getPendingQuestions } from './turn-lifecycle'
export { runScheduledTask, runDiscordSubagent } from './scheduled-and-discord'
