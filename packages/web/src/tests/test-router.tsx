import type { ReactNode } from "react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { AuthProvider } from "../auth/AuthProvider.js"

const LocationProbe = () => {
  const { pathname, search } = useLocation()
  return (
    <span data-testid="location" hidden>
      {pathname}
      {search}
    </span>
  )
}

type Props = {
  readonly initialEntries: ReadonlyArray<string>
  readonly children: ReactNode
}

export const TestRouter = ({ initialEntries, children }: Props) => (
  <AuthProvider>
    <MemoryRouter initialEntries={[...initialEntries]}>
      {children}
      <LocationProbe />
    </MemoryRouter>
  </AuthProvider>
)
