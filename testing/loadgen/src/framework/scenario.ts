const registry = new Map<string, () => Promise<unknown>>()

export function registerScenario(name: string, fn: () => Promise<unknown>) {
  registry.set(name.toLowerCase(), fn)
}

export function listScenarios(): string[] {
  return Array.from(registry.keys()).sort()
}

export async function runScenario(name: string) {
  const key = name.toLowerCase()
  const fn = registry.get(key)
  if (!fn) {
    const known = listScenarios().join(", ")
    throw new Error(`Unknown SCENARIO: ${name}. Valid: ${known}`)
  }
  return await fn()
}
