import klennyImg from '../assets/klenny.jpg'
import { useAppStore } from '../store/useAppStore'

interface WelcomeScreenProps {
  onOpenWorkspace: () => void
  onOpenSettings: () => void
}

export function WelcomeScreen({ onOpenWorkspace, onOpenSettings }: WelcomeScreenProps) {
  const { workspace, settings } = useAppStore()
  const needsApiKey = !settings?.hasApiKey
  const needsWorkspace = !workspace

  return (
    <div className="flex-1 flex items-center justify-center p-8 bg-klenny-bg">
      <div className="max-w-lg w-full text-center space-y-6">
        <img src={klennyImg} alt="Klenny Code" className="w-24 h-24 rounded-full object-cover mx-auto border-2 border-klenny-accent/40" />
        <div>
          <h1 className="text-2xl font-semibold text-klenny-accent">Welcome to Klenny Code</h1>
          <p className="text-klenny-muted text-sm mt-2">
            A desktop coding agent powered by OpenRouter. Open a project folder, add your API key, and start chatting.
          </p>
        </div>

        <div className="space-y-3 text-left">
          <Step
            done={!needsApiKey}
            number={1}
            title="Add your OpenRouter API key"
            detail="Required to call frontier models (Claude, GPT, Gemini, etc.)"
            action={needsApiKey ? 'Add API key' : 'API key configured'}
            onAction={needsApiKey ? onOpenSettings : undefined}
            disabled={!needsApiKey}
          />
          <Step
            done={!needsWorkspace}
            number={2}
            title="Open a project folder"
            detail="Point Klenny Code at a git repo or any codebase directory"
            action={needsWorkspace ? 'Open project folder' : workspace ?? 'Project open'}
            onAction={needsWorkspace ? onOpenWorkspace : onOpenWorkspace}
            disabled={false}
            primary={!needsWorkspace ? false : !needsApiKey ? false : needsWorkspace}
          />
          <Step
            done={!needsApiKey && !needsWorkspace}
            number={3}
            title="Start chatting"
            detail="Use Agent mode to edit code, or Plan mode to research first"
            action={!needsApiKey && !needsWorkspace ? 'Ready — send a message below' : 'Complete steps 1 & 2 first'}
            disabled
          />
        </div>

        {!needsWorkspace && !needsApiKey && (
          <p className="text-sm text-klenny-accent">You're all set. Type a message in the chat input below.</p>
        )}
      </div>
    </div>
  )
}

function Step({
  done,
  number,
  title,
  detail,
  action,
  onAction,
  disabled,
  primary
}: {
  done: boolean
  number: number
  title: string
  detail: string
  action: string
  onAction?: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <div className={`border rounded-lg p-4 ${done ? 'border-green-500/30 bg-green-500/5' : 'border-klenny-border bg-klenny-panel'}`}>
      <div className="flex items-start gap-3">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${done ? 'bg-green-500/20 text-green-400' : 'bg-klenny-panel2 text-klenny-muted'}`}>
          {done ? '✓' : number}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{title}</div>
          <div className="text-xs text-klenny-muted mt-0.5">{detail}</div>
          {onAction && !disabled ? (
            <button
              className={`mt-2 px-3 py-1.5 rounded-md text-sm font-medium ${
                primary ? 'bg-klenny-accent text-black hover:bg-klenny-accent2' : 'border border-klenny-border hover:bg-klenny-panel2'
              }`}
              onClick={onAction}
            >
              {action}
            </button>
          ) : (
            <div className={`mt-2 text-xs ${done ? 'text-green-400' : 'text-klenny-muted'}`}>{action}</div>
          )}
        </div>
      </div>
    </div>
  )
}
