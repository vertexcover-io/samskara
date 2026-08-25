import { useEffect, useRef, useState } from "react"

let counter = 0

const loadMermaid = async () => {
  const { default: mermaid } = await import("mermaid")
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "strict",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  })
  return mermaid
}

export const Mermaid = ({ chart }: { chart: string }) => {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  counter += 1
  const id = useRef(`mermaid-${counter}`)

  useEffect(() => {
    let active = true
    setSvg(null)
    setFailed(false)

    loadMermaid()
      .then((mermaid) => mermaid.render(id.current, chart))
      .then((result) => {
        if (active) setSvg(result.svg)
      })
      .catch(() => {
        if (active) setFailed(true)
      })

    return () => {
      active = false
    }
  }, [chart])

  if (failed) {
    return (
      <pre className="overflow-x-auto border border-dashed border-err/50 bg-panel p-3 font-mono text-[0.72rem] text-ink-2">
        {chart}
      </pre>
    )
  }

  if (svg === null) {
    return (
      <p className="border border-dashed border-rule bg-panel p-3 font-mono text-[0.72rem] text-faded">
        Rendering diagram…
      </p>
    )
  }

  return (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className="overflow-x-auto border border-rule bg-panel p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid renders to SVG under securityLevel strict
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
