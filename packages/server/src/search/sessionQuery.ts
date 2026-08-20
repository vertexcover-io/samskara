import { type SQL, sql } from "drizzle-orm"

export type SearchOperand = {
  readonly value: string
  readonly phrase: boolean
  readonly excluded: boolean
  readonly prefix: boolean
}

export type SearchBranch = {
  readonly operands: ReadonlyArray<SearchOperand>
}

export type SessionQuery = {
  readonly branches: ReadonlyArray<SearchBranch>
}

export class SessionQueryError extends Error {
  readonly code = "invalidSearchQuery"

  constructor() {
    super("Invalid search query")
  }
}

const isTermCharacter = (value: string): boolean => /[\p{L}\p{N}_]/u.test(value)
const isWhitespace = (value: string): boolean => /\s/u.test(value)
const codePoints = (value: string): ReadonlyArray<string> => Array.from(value)

const fail = (): never => {
  throw new SessionQueryError()
}

const normalizedLexemeCount = (value: string): number =>
  // `simple` accepts letters and decimal digits, while underscores split lexemes and superscript
  // numbers (for example `¹`) do not become lexemes. This guards all positions before PostgreSQL
  // sees an empty tsquery; final unquoted terms additionally need exactly one lexeme for `:*`.
  value.match(/[\p{L}\p{M}\p{Nd}]+/gu)?.length ?? 0

const validatePhrase = (value: string): string => {
  const phrase = value.trim()
  if (phrase === "" || !/[\p{L}\p{N}_]/u.test(phrase) || normalizedLexemeCount(phrase) === 0) fail()
  return phrase
}

const validateTerm = (value: string): string => {
  if (value === "" || !/[\p{L}\p{N}_]/u.test(value) || normalizedLexemeCount(value) === 0) fail()
  return value
}

/**
 * Parses a deliberately small search grammar. Punctuation never reaches PostgreSQL as tsquery
 * syntax; terms and phrases become query parameters in `compileSessionQuery`.
 */
export const parseSessionQuery = (input: string): SessionQuery => {
  const value = input.trim()
  const characters = codePoints(value)
  if (characters.length === 0 || characters.length > 200) fail()

  const branches: Array<Array<Omit<SearchOperand, "prefix">>> = [[]]
  let index = 0
  let atOperandStart = true

  const addOperand = (operand: Omit<SearchOperand, "prefix">): void => {
    const branch = branches.at(-1)
    if (branch === undefined) fail()
    branch?.push(operand)
    atOperandStart = false
  }

  while (index < characters.length) {
    const character = characters[index]
    if (character === undefined) return fail()

    if (isWhitespace(character)) {
      index += 1
      atOperandStart = true
      continue
    }

    let excluded = false
    if (character === "-" && atOperandStart) {
      const next = characters[index + 1]
      if (next === undefined || isWhitespace(next)) return fail()
      if (next === '"' || isTermCharacter(next)) {
        excluded = true
        index += 1
      } else {
        index += 1
        continue
      }
    }

    const start = characters[index]
    if (start === '"') {
      index += 1
      const phraseStart = index
      while (index < characters.length && characters[index] !== '"') index += 1
      if (index === characters.length) fail()
      const phrase = validatePhrase(characters.slice(phraseStart, index).join(""))
      index += 1
      addOperand({ value: phrase, phrase: true, excluded })
      continue
    }

    if (start !== undefined && isTermCharacter(start)) {
      const termStart = index
      while (index < characters.length && isTermCharacter(characters[index] ?? "")) index += 1
      const term = validateTerm(characters.slice(termStart, index).join(""))
      if (!excluded && atOperandStart && term.toLocaleLowerCase("en-US") === "or") {
        const branch = branches.at(-1)
        if (branch === undefined || branch.length === 0) fail()
        branches.push([])
        atOperandStart = true
      } else {
        addOperand({ value: term, phrase: false, excluded })
      }
      continue
    }

    index += 1
    atOperandStart = true
  }

  if (branches.some((branch) => branch.length === 0)) fail()

  return {
    branches: branches.map((branch) => {
      if (!branch.some((operand) => !operand.excluded)) fail()
      const finalPositiveTerm = [...branch]
        .reverse()
        .find((operand) => !operand.excluded && !operand.phrase)
      if (finalPositiveTerm !== undefined && normalizedLexemeCount(finalPositiveTerm.value) !== 1)
        fail()
      return {
        operands: branch.map((operand) => ({
          ...operand,
          prefix: operand === finalPositiveTerm,
        })),
      }
    }),
  }
}

const operandSql = (operand: SearchOperand): SQL => {
  const normalized = operand.phrase
    ? sql`phraseto_tsquery('simple'::regconfig, ${operand.value})`
    : sql`plainto_tsquery('simple'::regconfig, ${operand.value})`

  // `:*` only applies to trusted, normalized one-lexeme input. PostgreSQL's `!!` is not a
  // tsquery operator, so negation is composed with `!!query` / `query && query` syntax instead.
  const prefixed = operand.prefix
    ? sql`to_tsquery('simple'::regconfig, ${normalized}::text || ':*')`
    : normalized
  return operand.excluded ? sql`!!(${prefixed})` : prefixed
}

/** Builds a parameterized tsquery from the parsed grammar without admitting user SQL/operators. */
export const compileSessionQuery = (query: SessionQuery): SQL => {
  const branches = query.branches.map(
    (branch) => sql`(${sql.join(branch.operands.map(operandSql), sql` && `)})`,
  )
  return sql`(${sql.join(branches, sql` || `)})`
}
