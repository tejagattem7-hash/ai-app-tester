import { CircleCheck, CircleX, ListChecks } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

export function StatusSummary({ total, passed, failed }: { total: number; passed: number; failed: number }) {
  const items = [
    { label: "Total", value: total, icon: ListChecks, color: "text-indigo-600", background: "bg-indigo-50" },
    { label: "Passed", value: passed, icon: CircleCheck, color: "text-emerald-600", background: "bg-emerald-50" },
    { label: "Failed", value: failed, icon: CircleX, color: "text-rose-600", background: "bg-rose-50" },
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {items.map(({ label, value, icon: Icon, color, background }) => (
        <Card key={label}>
          <CardContent className="flex items-center gap-4 p-5">
            <div className={`rounded-xl p-2.5 ${background}`}><Icon className={`size-5 ${color}`} /></div>
            <div><p className="text-2xl font-semibold text-slate-950">{value}</p><p className="text-sm text-slate-500">{label}</p></div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
