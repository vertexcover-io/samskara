import { rowFrameClass } from "./SessionRow.js"

const keysFor = (rows: number): ReadonlyArray<string> =>
  Array.from({ length: rows }, (_, index) => `skeleton-${index}`)

export const SessionListSkeleton = ({ rows }: { readonly rows: number }) => (
  <div data-testid="list-skeleton" className="animate-pulse">
    <div className="mb-3 h-4 w-40 bg-rule-soft" />
    <ul className="grid grid-cols-1 gap-1.5">
      {keysFor(rows).map((key) => (
        <li key={key} className={rowFrameClass}>
          <div className="h-4 w-2/3 bg-rule-soft" />
          <div className="mt-1 h-3 w-1/3 bg-rule-soft" />
        </li>
      ))}
    </ul>
  </div>
)
