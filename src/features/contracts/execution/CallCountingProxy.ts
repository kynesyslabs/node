/**
 * Proxy wrapper to count function calls for fee calculation
 * Intercepts all method calls on contract instances
 */

import type { CallCounter } from "./ExecutionContext"

/**
 * Creates a proxy that counts function calls for fee calculation
 * Every method call increments the counter (used for 1 DEM per call fee)
 */
export function createCallCountingProxy<T extends object>(
    target: T,
    callCounter: CallCounter,
    excludeMethods: Set<string> = new Set(),
): T {
    // Add standard methods to exclude from call counting
    const defaultExcludedMethods = new Set([
        "constructor",
        "__initialize",
        "__getEvents",
        "__getStateChanges",
        "__incrementCallCount",
        "__getCallCount",
        // Standard Object methods
        "toString",
        "valueOf",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
    ])

    // Combine default and user-provided exclusions
    const allExcludedMethods = new Set([
        ...defaultExcludedMethods,
        ...excludeMethods,
    ])

    return new Proxy(target, {
        get(obj: T, prop: string | symbol): any {
            const value = (obj as any)[prop]

            // Only proxy function properties
            if (typeof value === "function") {
                // Check if this method should be excluded from counting
                if (typeof prop === "string" && allExcludedMethods.has(prop)) {
                    return value.bind(obj)
                }

                // Check if method name starts with double underscore (internal methods)
                if (typeof prop === "string" && prop.startsWith("__")) {
                    return value.bind(obj)
                }

                // Return wrapped function that increments call counter
                return function (...args: any[]) {
                    // Increment call counter for fee calculation
                    callCounter.count++

                    // Also increment the contract's internal counter if it's a DemosContract
                    if (
                        typeof (obj as any).__incrementCallCount === "function"
                    ) {
                        (obj as any).__incrementCallCount()
                    }

                    console.log(
                        `[CallCountingProxy] Function '${String(
                            prop,
                        )}' called. Total calls: ${callCounter.count}`,
                    )

                    // Call original method
                    return value.apply(obj, args)
                }
            }

            // Return non-function properties as-is
            return value
        },

        set(obj: T, prop: string | symbol, value: any): boolean {
            // Allow setting properties without counting
            (obj as any)[prop] = value
            return true
        },
    })
}

/**
 * Utility to check if a method should be counted
 * Exported for testing purposes
 */
export function shouldCountMethodCall(methodName: string): boolean {
    // Don't count internal methods (starting with _)
    if (methodName.startsWith("_")) {
        return false
    }

    // Don't count standard Object methods
    const standardMethods = [
        "constructor",
        "toString",
        "valueOf",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
    ]

    return !standardMethods.includes(methodName)
}
