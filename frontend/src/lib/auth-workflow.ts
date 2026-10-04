import { useSyncExternalStore } from "react"
import type { TestPlan } from "@/types/planning"
import { cancelAuthWorkflow } from "./api"

// Memory only: never copy this record to navigation state, storage or reports.
let current: { id: string; plan: TestPlan } | undefined
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useAuthWorkflow = () => useSyncExternalStore(subscribe, () => current)
export function authWorkflowIdFor(plan: TestPlan): string | undefined {
  return current && JSON.stringify(current.plan) === JSON.stringify(plan) ? current.id : undefined
}
export function retainAuthWorkflow(id: string, plan: TestPlan): void {
  clearAuthWorkflow()
  current = { id, plan }
  listeners.forEach((listener) => listener())
}
export function clearAuthWorkflow(cancel = true): void {
  const previous = current
  current = undefined
  listeners.forEach((listener) => listener())
  if (cancel && previous) void cancelAuthWorkflow(previous.id)
}
