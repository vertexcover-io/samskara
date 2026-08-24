import { type ApiResult, client, request } from "./client.js"
import type { LogoutAck, PairingCode } from "./types.js"

export const requestPairingCode = (): Promise<ApiResult<PairingCode>> =>
  request(() => client.api.auth["cli-code"].$post())

export const logout = (): Promise<ApiResult<LogoutAck>> =>
  request(() => client.api.auth.logout.$post())
