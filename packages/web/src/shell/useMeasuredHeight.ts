import { useEffect, useRef, useState } from "react"

/**
 * Tracks an element's rendered height, so a pinned layer's size can be handed to whatever has to
 * clear it: a second sticky bar beneath the first, or a pane that stops short of the pinned
 * footer. A hardcoded offset would leave a gap -- or clip content -- at any other font size, and
 * whenever the element wraps onto a second line.
 */
export const useMeasuredHeight = <T extends HTMLElement>() => {
  const ref = useRef<T | null>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setHeight(node.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return { ref, height }
}
