export interface FileSystem {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  stat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number }>
}
