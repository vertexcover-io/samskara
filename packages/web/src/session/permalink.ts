export const MESSAGE_PARAM = "m"
export const AGENT_PARAM = "agent"

export const messageLink = (
  origin: string,
  pathname: string,
  params: URLSearchParams,
  messageId: string,
): string => {
  const targeted = new URLSearchParams(params)
  targeted.set(MESSAGE_PARAM, messageId)
  return `${origin}${pathname}?${targeted}`
}
