import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import { useEffect } from "react"
import { clearAuthWorkflow } from "@/lib/auth-workflow"
import { AppLayout } from "@/app/AppLayout"
import { NewTestPage } from "@/pages/NewTestPage"
import { TestPlanPage } from "@/pages/TestPlanPage"
import { TestReportPage } from "@/pages/TestReportPage"
import { TestRunningPage } from "@/pages/TestRunningPage"

export function App() {
  const { pathname } = useLocation()
  useEffect(() => {
    if (!["/plan", "/running"].includes(pathname)) clearAuthWorkflow()
  }, [pathname])
  useEffect(() => {
    const leave = () => clearAuthWorkflow()
    window.addEventListener("pagehide", leave)
    return () => window.removeEventListener("pagehide", leave)
  }, [])
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<NewTestPage />} />
        <Route path="plan" element={<TestPlanPage />} />
        <Route path="running" element={<TestRunningPage />} />
        <Route path="report" element={<TestReportPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
