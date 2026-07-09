import { useState } from 'react'
import type { PendingQuestion, QuestionAnswer } from '@shared/types'

export function QuestionCard({ question }: { question: PendingQuestion }) {
  const [answers, setAnswers] = useState<Record<string, { optionIds: string[]; otherText?: string }>>({})

  const toggle = (qId: string, optId: string, allowMultiple?: boolean) => {
    setAnswers((prev) => {
      const cur = prev[qId]?.optionIds ?? []
      let next: string[]
      if (allowMultiple) {
        next = cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId]
      } else {
        next = [optId]
      }
      return { ...prev, [qId]: { ...prev[qId], optionIds: next } }
    })
  }

  const submit = () => {
    const payload: QuestionAnswer[] = question.questions.map((q) => ({
      questionId: q.id,
      optionIds: answers[q.id]?.optionIds ?? [],
      otherText: answers[q.id]?.otherText
    }))
    void window.klenny.resolveQuestion(question.id, payload)
  }

  return (
    <div className="border border-blue-500/40 rounded-lg p-4 bg-klenny-panel2">
      <div className="font-medium mb-3">Klenny needs your input</div>
      <div className="space-y-4">
        {question.questions.map((q) => (
          <div key={q.id}>
            <div className="text-sm mb-2">{q.prompt}</div>
            <div className="space-y-1">
              {q.options.map((opt) => (
                <label key={opt.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type={q.allowMultiple ? 'checkbox' : 'radio'}
                    name={q.id}
                    checked={answers[q.id]?.optionIds.includes(opt.id) ?? false}
                    onChange={() => toggle(q.id, opt.id, q.allowMultiple)}
                  />
                  {opt.label}
                </label>
              ))}
              <input
                className="w-full mt-2 px-2 py-1 text-sm bg-klenny-bg border border-klenny-border rounded"
                placeholder="Other (optional)"
                value={answers[q.id]?.otherText ?? ''}
                onChange={(e) =>
                  setAnswers((prev) => ({
                    ...prev,
                    [q.id]: { optionIds: prev[q.id]?.optionIds ?? [], otherText: e.target.value }
                  }))
                }
              />
            </div>
          </div>
        ))}
      </div>
      <button className="mt-4 px-4 py-2 rounded bg-klenny-accent text-black text-sm" onClick={submit}>
        Submit answers
      </button>
    </div>
  )
}
