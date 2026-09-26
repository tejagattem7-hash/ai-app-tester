import { FlaskConical, History, Plus, Settings } from "lucide-react"
import { NavLink, Outlet } from "react-router-dom"
import { cn } from "@/lib/utils"

const links = [
  { to: "/", label: "New test", icon: Plus },
  { to: "/report", label: "Latest report", icon: History },
]

export function AppLayout() {
  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-slate-200 bg-white p-5 lg:flex lg:flex-col">
        <div className="flex items-center gap-3 px-2 py-3"><div className="rounded-xl bg-slate-950 p-2 text-white"><FlaskConical className="size-5" /></div><span className="font-semibold tracking-tight text-slate-950">AI App Tester</span></div>
        <nav className="mt-8 space-y-1">{links.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium", isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900")}><Icon className="size-4" />{label}</NavLink>)}</nav>
        <div className="mt-auto flex items-center gap-3 rounded-xl border border-slate-200 p-3"><div className="flex size-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">AT</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">Demo workspace</p><p className="text-xs text-slate-400">Frontend prototype</p></div><Settings className="size-4 text-slate-400" /></div>
      </aside>
      <header className="border-b border-slate-200 bg-white px-5 py-4 lg:hidden"><div className="flex items-center gap-3"><FlaskConical className="size-5" /><span className="font-semibold">AI App Tester</span></div></header>
      <main className="lg:pl-64"><div className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14"><Outlet /></div></main>
    </div>
  )
}
