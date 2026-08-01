import { useEffect, useRef, useState } from 'react'

/** Accessible "+" attach button that opens a small popover menu with "Attach image" and
 *  "Attach document" options. Deliberately a real <button> + role="menu" popover rather than a
 *  disguised <select> — a <select> can't host two distinct file-picker triggers with different
 *  `accept` filters as "options" (selecting an option isn't itself an action you can hook a file
 *  dialog to without a very hacky onChange dance), and a real menu is what screen readers and
 *  keyboard users actually expect for "choose one of these actions" as opposed to "choose one of
 *  these values". */
export function AttachMenu({
  onAttachImage,
  onAttachDocument,
  disabled
}: {
  onAttachImage: () => void
  onAttachDocument: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    firstItemRef.current?.focus()

    const onDocPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onDocKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onDocKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="text-xs px-2 py-1 border border-klenny-border rounded disabled:opacity-50"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        + Attach
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Attach a file"
          className="absolute bottom-full left-0 mb-1 min-w-[160px] bg-klenny-panel2 border border-klenny-border rounded-md shadow-lg py-1 z-20"
        >
          <button
            ref={firstItemRef}
            type="button"
            role="menuitem"
            className="w-full text-left text-xs px-3 py-1.5 hover:bg-klenny-panel"
            onClick={() => {
              setOpen(false)
              onAttachImage()
            }}
          >
            🖼️ Attach image
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full text-left text-xs px-3 py-1.5 hover:bg-klenny-panel"
            onClick={() => {
              setOpen(false)
              onAttachDocument()
            }}
          >
            📄 Attach document
          </button>
        </div>
      )}
    </div>
  )
}
