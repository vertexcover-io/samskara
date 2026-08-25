import type { AgentPlugin } from "./types.js"

const registered = new Map<string, AgentPlugin>()

export const register = (plugin: AgentPlugin): void => {
  registered.set(plugin.source, plugin)
}

export const plugins = (): ReadonlyArray<AgentPlugin> => [...registered.values()]

export const pluginFor = (source: string): AgentPlugin | undefined => registered.get(source)
