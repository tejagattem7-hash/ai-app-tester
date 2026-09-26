import { Navigate, Route, Routes } from "react-router-dom"
import { AppLayout } from "@/app/AppLayout"
import { NewTestPage } from "@/pages/NewTestPage"
import { TestPlanPage } from "@/pages/TestPlanPage"
import { TestReportPage } from "@/pages/TestReportPage"
import { TestRunningPage } from "@/pages/TestRunningPage"

export function App() {
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
