import { type ApiResult, client, request } from "./client.js"
import type { AuthMethods, LogoutAck, PairingCode } from "./types.js"

export const fetchAuthMethods = (): Promise<ApiResult<AuthMethods>> =>
  request(() => client.api.auth.methods.$get())

export const localLogin = (secret: string) =>
  request(() => client.api.auth.local.$post({ json: { secret } }))

export const requestPairingCode = (): Promise<ApiResult<PairingCode>> =>
  request(() => client.api.auth["cli-code"].$post())

export const logout = (): Promise<ApiResult<LogoutAck>> =>
  request(() => client.api.auth.logout.$post())
