/**
 * Latest parsed course rows, shared between the planner tools and the panel
 * schedule view. Module-level mutable store for our standalone plugin (the
 * repo's store discipline governs in-repo packages; this stays plugin-local).
 * @module dsh-course-selector/plans
 */
export interface PlanRowInfo {
  index: number
  code: string
  name: string
  credits: string
  teacher: string
  time: string
  location: string
  capacity: string
  enrolled: string
  status: string
  score?: string
}

let current: PlanRowInfo[] = []
let updatedAt = 0

export function setPlan(rows: readonly PlanRowInfo[]): void {
  current = [...rows]
  updatedAt = Date.now()
}

export function getPlan(): { rows: PlanRowInfo[]; updatedAt: number } {
  return { rows: current, updatedAt }
}