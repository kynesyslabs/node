import log from "./logger"
import { getSharedState } from "./sharedState"

export type LoopTask = {
    name: string
    fn: () => Promise<void> | void
    intervalMs: () => number
    budgetMs: number
    runWhilePaused?: boolean
}

type TaskState = {
    task: LoopTask
    tickStartedAt: number | null
    lastCompletedAt: number | null
    iterations: number
}

const taskStates = new Map<string, TaskState>()
const stepMarkers = new Map<string, { step: string; since: number }>()

const STEP_BUDGET_MS = 180_000

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function markStep(scope: string, step: string | null): void {
    if (step === null) {
        stepMarkers.delete(scope)
    } else {
        stepMarkers.set(scope, { step, since: Date.now() })
    }
}

export function startLoopTask(task: LoopTask): Promise<void> {
    const state: TaskState = {
        task,
        tickStartedAt: null,
        lastCompletedAt: null,
        iterations: 0,
    }
    taskStates.set(task.name, state)

    const run = async () => {
        while (getSharedState.runMainLoop) {
            await sleep(task.intervalMs())

            if (
                (getSharedState.mainLoopPaused && !task.runWhilePaused) ||
                getSharedState.isShuttingDown
            ) {
                continue
            }

            state.tickStartedAt = Date.now()
            try {
                await task.fn()
            } catch (error) {
                log.error(
                    `[SCHEDULER] Task "${task.name}" tick failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                )
                console.error(error)
            } finally {
                state.tickStartedAt = null
                state.lastCompletedAt = Date.now()
                state.iterations++
            }
        }

        log.info(`[SCHEDULER] Task "${task.name}" loop stopped`)
    }

    return run()
}

export function reportWedgedLoops(): void {
    const now = Date.now()

    for (const [name, state] of taskStates) {
        if (state.tickStartedAt === null) {
            continue
        }
        const runningMs = now - state.tickStartedAt
        if (runningMs <= state.task.budgetMs) {
            continue
        }
        const marker = stepMarkers.get(name)
        const stepInfo = marker
            ? ` at step "${marker.step}" (${Math.round((now - marker.since) / 1000)}s)`
            : ""
        log.error(
            `[SCHEDULER] Task "${name}" tick running for ${Math.round(
                runningMs / 1000,
            )}s (budget ${Math.round(
                state.task.budgetMs / 1000,
            )}s) — possibly wedged${stepInfo}`,
        )
    }

    for (const [scope, marker] of stepMarkers) {
        if (taskStates.has(scope)) {
            continue
        }
        const runningMs = now - marker.since
        if (runningMs <= STEP_BUDGET_MS) {
            continue
        }
        log.error(
            `[SCHEDULER] Step "${scope}:${marker.step}" running for ${Math.round(
                runningMs / 1000,
            )}s — possibly wedged`,
        )
    }
}
