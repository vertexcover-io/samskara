import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { tokenPath } from "./paths.js"

export const readToken = async (): Promise<string | null> => {
  try {
    const token = (await readFile(tokenPath(), "utf8")).trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

export const storeToken = async (token: string): Promise<string> => {
  const path = tokenPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, token, { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

export const deleteToken = async (): Promise<void> => {
  await rm(tokenPath(), { force: true })
}
