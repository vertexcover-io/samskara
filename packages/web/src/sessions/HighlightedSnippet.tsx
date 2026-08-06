import { splitHighlights } from "./highlight.js"

export const HighlightedSnippet = ({ snippet }: { readonly snippet: string }) => (
  <>
    {splitHighlights(snippet).map((segment) =>
      segment.match ? (
        <mark key={segment.start} className="bg-hl/60 text-ink not-italic">
          {segment.text}
        </mark>
      ) : (
        <span key={segment.start}>{segment.text}</span>
      ),
    )}
  </>
)
