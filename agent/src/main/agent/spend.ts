// Daily spend tracking, shared between the orchestrator (chat completions) and the codebase
// index manager (embeddings) — extracted so both can roll costs into the same running total
// without either needing to import the other (orchestrator.ts pulls in Electron at module
// scope, which would make codeindex/manager.ts's tests require Electron transitively).

let dailySpend = 0
let dailySpendDate = new Date().toDateString()

function rolloverIfNewDay(): void {
  const today = new Date().toDateString()
  if (today !== dailySpendDate) {
    dailySpendDate = today
    dailySpend = 0
  }
}

export function trackDailySpend(cost: number): void {
  rolloverIfNewDay()
  dailySpend += cost
}

export function getDailySpend(): number {
  rolloverIfNewDay()
  return dailySpend
}
