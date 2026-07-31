import type { ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Code } from "./Code.js"
import { Mermaid } from "./Mermaid.js"

const textOf = (node: ReactNode): string => {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  return ""
}

const languageOf = (className: unknown): string | null => {
  const match = /language-([\w-]+)/.exec(typeof className === "string" ? className : "")
  return match?.[1] ?? null
}

export const Markdown = ({ source }: { source: string }) => (
  <div className="min-w-0 text-[0.8125rem] leading-relaxed">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="mt-5 border-b border-rule pb-1 text-[1.125rem] font-semibold first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mt-5 text-[1rem] font-semibold first:mt-0">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-4 text-[0.875rem] font-semibold first:mt-0">{children}</h3>
        ),
        p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
        ul: ({ children }) => <ul className="mt-2 list-disc pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="mt-2 list-decimal pl-5">{children}</ol>,
        li: ({ children }) => <li className="mt-1">{children}</li>,
        a: ({ href, children }) => (
          <a href={href} className="text-custody underline decoration-dotted">
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="mt-3 border-l-2 border-custody bg-panel px-3 py-2 italic text-ink-soft">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse border border-rule text-[0.75rem]">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-rule bg-panel px-2 py-1 text-left font-semibold">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-rule px-2 py-1 align-top">{children}</td>
        ),
        hr: () => <hr className="mt-4 border-rule" />,
        code: ({ className, children }) => {
          const language = languageOf(className)
          if (language === null) {
            return (
              <code className="rounded-xs border border-rule bg-panel px-[0.35em] py-[0.1em] font-mono text-[0.82em] text-custody">
                {children}
              </code>
            )
          }
          if (language === "mermaid") return <Mermaid chart={textOf(children).trim()} />
          return <code className={`font-mono text-[0.72rem] ${className ?? ""}`}>{children}</code>
        },
        pre: ({ children }) => {
          const only = Array.isArray(children) ? children[0] : children
          const props =
            typeof only === "object" && only !== null && "props" in only
              ? (only.props as { className?: string; children?: ReactNode })
              : {}
          const language = languageOf(props.className)
          if (language === "mermaid") return <>{children}</>
          return (
            <div className="mt-3 overflow-hidden rounded-xs border border-rule">
              {language === null ? null : (
                <p className="border-b border-rule bg-panel-2 px-3 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-faded">
                  {language}
                </p>
              )}
              {language === null ? (
                <pre className="overflow-x-auto bg-panel p-3 font-mono text-[0.72rem] leading-relaxed">
                  {children}
                </pre>
              ) : (
                <Code source={textOf(props.children)} language={language} path={null} />
              )}
            </div>
          )
        },
      }}
    >
      {source}
    </ReactMarkdown>
  </div>
)
