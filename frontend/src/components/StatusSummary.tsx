import { Bug, CircleCheck, Lightbulb } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

const items = [
  { label: "Passed", value: 2, icon: CircleCheck, color: "text-emerald-600", background: "bg-emerald-50" },
  { label: "Bugs", value: 1, icon: Bug, color: "text-rose-600", background: "bg-rose-50" },
  { label: "Improvements", value: 1, icon: Lightbulb, color: "text-amber-600", background: "bg-amber-50" },
]

export function StatusSummary() {
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
