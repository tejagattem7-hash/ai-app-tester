import { FlaskConical, History, Plus } from "lucide-react"
import { NavLink, Outlet } from "react-router-dom"
import { cn } from "@/lib/utils"

const links = [
  { to: "/", label: "New test", icon: Plus },
  { to: "/report", label: "Latest report", icon: History },
]

export function AppLayout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 md:px-8">
          <div className="flex shrink-0 items-center gap-3"><div className="rounded-lg bg-slate-950 p-1.5 text-white shadow-sm"><FlaskConical className="size-4" /></div><span className="text-sm font-semibold tracking-tight text-slate-950 sm:text-base">AI App Tester</span></div>
          <nav aria-label="Main navigation" className="flex items-center gap-1">{links.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} aria-label={label} className={({ isActive }) => cn("inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors sm:px-3", isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900")}><Icon className="size-4" /><span className="hidden sm:inline">{label}</span></NavLink>)}</nav>
        </div>
      </header>
      <main><div className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14"><Outlet /></div></main>
    </div>
  )
}
