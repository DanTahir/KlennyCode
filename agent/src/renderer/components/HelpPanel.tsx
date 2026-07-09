import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import helpMd from '../help/content.md?raw'

export function HelpPanel() {
  return (
    <div className="flex-1 overflow-y-auto p-6 prose prose-invert max-w-3xl markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{helpMd}</ReactMarkdown>
    </div>
  )
}
