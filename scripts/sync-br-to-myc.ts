import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

type BrDependency = {
  issue_id?: string
  depends_on_id?: string
  type?: string
}

type BrIssue = {
  id: string
  title: string
  description?: string
  acceptance_criteria?: string
  notes?: string
  status?: string
  priority?: number
  issue_type?: string
  created_at?: string
  updated_at?: string
  closed_at?: string
  close_reason?: string
  dependencies?: BrDependency[]
}

type MycEpic = {
  id: number
  title: string
  description: string | null
  status: "open" | "closed"
}

type MycTask = {
  id: number
  title: string
  description: string | null
  status: "open" | "closed"
  priority: string
  epic_id: number | null
}

type MycExport = {
  epics: MycEpic[]
  tasks: MycTask[]
}

type SyncMap = {
  version: number
  brToMycEpic: Record<string, number>
  brToMycTask: Record<string, number>
  linkedDependencies: string[]
  syncedAt?: string
}

const projectRoot = process.cwd()
const beadsJsonlPath = join(projectRoot, ".beads", "issues.jsonl")
const myceliumDir = join(projectRoot, ".mycelium")
const syncMapPath = join(myceliumDir, "br-sync-map.json")

function runCommand(args: string[]): string {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd: projectRoot,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`Command failed (${args.join(" ")}): ${result.stderr || result.stdout}`)
  }
  return (result.stdout || "").trim()
}

function runJson<T>(args: string[]): T {
  const output = runCommand(args)
  return JSON.parse(output) as T
}

function loadBrIssues(): BrIssue[] {
  return readFileSync(beadsJsonlPath, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as BrIssue)
}

function loadSyncMap(): SyncMap {
  if (!existsSync(syncMapPath)) {
    return {
      version: 1,
      brToMycEpic: {},
      brToMycTask: {},
      linkedDependencies: [],
    }
  }
  return JSON.parse(readFileSync(syncMapPath, "utf8")) as SyncMap
}

function saveSyncMap(map: SyncMap) {
  mkdirSync(myceliumDir, { recursive: true })
  map.syncedAt = new Date().toISOString()
  writeFileSync(syncMapPath, JSON.stringify(map, null, 2) + "\n")
}

function brPriorityToMyc(priority: number | undefined): "low" | "medium" | "high" | "critical" {
  switch (priority) {
    case 0:
      return "critical"
    case 1:
      return "high"
    case 2:
      return "medium"
    case 3:
    case 4:
    default:
      return "low"
  }
}

function buildDescription(issue: BrIssue): string {
  const parts = [
    issue.description?.trim(),
    issue.acceptance_criteria?.trim() ? `## Acceptance Criteria\n${issue.acceptance_criteria.trim()}` : null,
    issue.notes?.trim() ? `## Notes\n${issue.notes.trim()}` : null,
    [
      "## Synced Metadata",
      `- source: br`,
      `- br_id: ${issue.id}`,
      `- br_type: ${issue.issue_type ?? "task"}`,
      `- br_status: ${issue.status ?? "open"}`,
      `- br_priority: ${issue.priority ?? 2}`,
      issue.created_at ? `- br_created_at: ${issue.created_at}` : null,
      issue.updated_at ? `- br_updated_at: ${issue.updated_at}` : null,
      issue.closed_at ? `- br_closed_at: ${issue.closed_at}` : null,
      issue.close_reason ? `- br_close_reason: ${issue.close_reason}` : null,
    ].filter(Boolean).join("\n"),
  ].filter(Boolean)

  return parts.join("\n\n")
}

function pruneLinkedDependenciesForTask(taskId: number, syncMap: SyncMap) {
  const needle = String(taskId)
  syncMap.linkedDependencies = syncMap.linkedDependencies.filter(edge => {
    const [from, to] = edge.split("->")
    return from !== needle && to !== needle
  })
}

function reconcileTypeChanges(issues: BrIssue[], syncMap: SyncMap, exported: MycExport): boolean {
  let changed = false

  for (const issue of issues) {
    const mappedEpicId = syncMap.brToMycEpic[issue.id]
    const mappedTaskId = syncMap.brToMycTask[issue.id]

    if (issue.issue_type === "epic") {
      if (mappedTaskId) {
        const existingTask = exported.tasks.find(task => task.id === mappedTaskId)
        if (existingTask) {
          runCommand(["myc", "task", "delete", String(mappedTaskId), "--force", "--format", "json"])
        }
        pruneLinkedDependenciesForTask(mappedTaskId, syncMap)
        delete syncMap.brToMycTask[issue.id]
        changed = true
      }
      continue
    }

    if (mappedEpicId) {
      const existingEpic = exported.epics.find(epic => epic.id === mappedEpicId)
      if (existingEpic) {
        runCommand(["myc", "epic", "delete", String(mappedEpicId), "--force", "--format", "json"])
      }
      delete syncMap.brToMycEpic[issue.id]
      changed = true
    }
  }

  return changed
}

function getParentEpicId(issue: BrIssue, epicMap: Record<string, number>, allIssues: Map<string, BrIssue>): number | null {
  for (const dep of issue.dependencies ?? []) {
    if (dep.type !== "parent-child" || !dep.depends_on_id) continue
    const parent = allIssues.get(dep.depends_on_id)
    if (parent?.issue_type === "epic") return epicMap[parent.id] ?? null
  }
  return null
}

function ensureEpic(issue: BrIssue, syncMap: SyncMap, exported: MycExport): number {
  const description = buildDescription(issue)
  const mappedId = syncMap.brToMycEpic[issue.id]
  const existing = mappedId ? exported.epics.find(epic => epic.id === mappedId) : null

  let epicId = mappedId
  if (!existing) {
    const created = runJson<MycEpic>([
      "myc", "epic", "create",
      "--title", issue.title,
      "--description", description,
      "--format", "json",
    ])
    epicId = created.id
    syncMap.brToMycEpic[issue.id] = epicId
  } else {
    runCommand([
      "myc", "epic", "update", String(existing.id),
      "--title", issue.title,
      "--description", description,
      "--format", "json",
    ])
  }

  const shouldBeClosed = issue.status === "closed"
  runCommand([
    "myc", "epic", "update", String(epicId),
    "--status", shouldBeClosed ? "closed" : "open",
    "--format", "json",
  ])

  return epicId
}

function ensureTask(issue: BrIssue, syncMap: SyncMap, exported: MycExport, epicId: number | null): number {
  const description = buildDescription(issue)
  const priority = brPriorityToMyc(issue.priority)
  const mappedId = syncMap.brToMycTask[issue.id]
  const existing = mappedId ? exported.tasks.find(task => task.id === mappedId) : null

  let taskId = mappedId
  if (!existing) {
    const args = [
      "myc", "task", "create",
      "--title", issue.title,
      "--description", description,
      "--priority", priority,
      "--format", "json",
    ]
    if (epicId) args.splice(args.length - 2, 0, "--epic", String(epicId))
    const created = runJson<MycTask>(args)
    taskId = created.id
    syncMap.brToMycTask[issue.id] = taskId
  } else {
    const args = [
      "myc", "task", "update", String(existing.id),
      "--title", issue.title,
      "--description", description,
      "--priority", priority,
      "--epic", String(epicId ?? 0),
      "--format", "json",
    ]
    runCommand(args)
  }

  runCommand([
    "myc", "task", "update", String(taskId),
    "--status", issue.status === "closed" ? "closed" : "open",
    "--format", "json",
  ])

  return taskId
}

function ensureDependencyLinks(issues: BrIssue[], syncMap: SyncMap, allIssues: Map<string, BrIssue>) {
  const knownLinks = new Set(syncMap.linkedDependencies)

  for (const issue of issues) {
    const blockedTaskId = syncMap.brToMycTask[issue.id]
    if (!blockedTaskId) continue

    for (const dep of issue.dependencies ?? []) {
      if (!dep.depends_on_id || dep.type === "parent-child") continue

      const dependencyIssue = allIssues.get(dep.depends_on_id)
      if (!dependencyIssue || dependencyIssue.issue_type === "epic") continue

      const blockingTaskId = syncMap.brToMycTask[dep.depends_on_id]
      if (!blockingTaskId) continue

      const edgeKey = `${blockingTaskId}->${blockedTaskId}`
      if (knownLinks.has(edgeKey)) continue

      runCommand([
        "myc", "task", "link", "blocks",
        "--task", String(blockingTaskId),
        String(blockedTaskId),
        "--format", "json",
      ])
      knownLinks.add(edgeKey)
    }
  }

  syncMap.linkedDependencies = Array.from(knownLinks).sort()
}

function main() {
  const issues = loadBrIssues().sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
  const allIssues = new Map(issues.map(issue => [issue.id, issue]))
  const syncMap = loadSyncMap()
  let exported = runJson<MycExport>(["myc", "export", "json"])

  if (reconcileTypeChanges(issues, syncMap, exported)) {
    exported = runJson<MycExport>(["myc", "export", "json"])
  }

  const epicIssues = issues.filter(issue => issue.issue_type === "epic")
  for (const epic of epicIssues) {
    ensureEpic(epic, syncMap, exported)
    exported = runJson<MycExport>(["myc", "export", "json"])
  }

  const taskIssues = issues.filter(issue => issue.issue_type !== "epic")
  for (const issue of taskIssues) {
    const epicId = getParentEpicId(issue, syncMap.brToMycEpic, allIssues)
    ensureTask(issue, syncMap, exported, epicId)
    exported = runJson<MycExport>(["myc", "export", "json"])
  }

  ensureDependencyLinks(taskIssues, syncMap, allIssues)
  saveSyncMap(syncMap)

  const finalExport = runJson<MycExport>(["myc", "export", "json"])
  const result = {
    synced_at: syncMap.syncedAt,
    br_issues: issues.length,
    br_epics: epicIssues.length,
    br_tasks: taskIssues.length,
    myc_epics: finalExport.epics.length,
    myc_tasks: finalExport.tasks.length,
    mapped_epics: Object.keys(syncMap.brToMycEpic).length,
    mapped_tasks: Object.keys(syncMap.brToMycTask).length,
    linked_dependencies: syncMap.linkedDependencies.length,
    map_path: syncMapPath,
  }
  console.log(JSON.stringify(result, null, 2))
}

main()
