import { customType } from "drizzle-orm/pg-core"

export const vector = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`
    },
    fromDriver(value: string): number[] {
      return value
        .slice(1, -1)
        .split(",")
        .map((n) => Number(n))
    },
  })
