import type { PendingDocument } from '@shared/types'

/** Renders the row of not-yet-sent attachments above the composer textarea — image thumbnails
 *  and document chips, each with its own remove (×) button. Shared by images and documents so
 *  removal behaves identically for both instead of two divergent one-off implementations. */
export function PendingAttachmentRow({
  images,
  documents,
  onRemoveImage,
  onRemoveDocument
}: {
  images: string[]
  documents: PendingDocument[]
  onRemoveImage: (index: number) => void
  onRemoveDocument: (index: number) => void
}) {
  if (images.length === 0 && documents.length === 0) return null

  return (
    <div className="flex gap-2 mb-2 flex-wrap">
      {images.map((img, i) => (
        <div key={`img-${i}`} className="relative group">
          <img src={img} alt="attachment" className="h-16 rounded border border-klenny-border" />
          <button
            type="button"
            aria-label={`Remove image ${i + 1}`}
            title="Remove"
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-klenny-panel2 border border-klenny-border text-xs leading-none flex items-center justify-center hover:bg-red-500/80 hover:text-white"
            onClick={() => onRemoveImage(i)}
          >
            ×
          </button>
        </div>
      ))}
      {documents.map((doc, i) => (
        <div
          key={`doc-${i}`}
          className="relative flex items-center gap-1.5 h-16 max-w-[180px] px-3 rounded border border-klenny-border bg-klenny-panel2 text-xs"
          title={doc.filename}
        >
          <span className="text-base">📄</span>
          <div className="flex flex-col overflow-hidden">
            <span className="truncate">{doc.filename}</span>
            <span className="text-klenny-muted">
              {(doc.sizeBytes / 1024).toFixed(0)} KB{doc.truncated ? ' · truncated' : ''}
            </span>
          </div>
          <button
            type="button"
            aria-label={`Remove ${doc.filename}`}
            title="Remove"
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-klenny-panel2 border border-klenny-border text-xs leading-none flex items-center justify-center hover:bg-red-500/80 hover:text-white"
            onClick={() => onRemoveDocument(i)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
