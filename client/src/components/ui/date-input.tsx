import * as React from "react"
import { format, isValid, parse } from "date-fns"
import { CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

// A date field whose calendar opens in a Popover, taking and returning the same "yyyy-MM-dd"
// string as <input type="date"> so it drops in for one. The native picker is drawn by the browser
// itself and can't be rotated, so on a kiosk-rotated page it opened upright; this one turns with
// the page like every other popup (see lib/portalRotation).
export function DateInput({
  value,
  onChange,
  className,
  placeholder = "Pick a date",
  clearable = true,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  /** Show a Clear button in the calendar. Turn off where the page already has its own clear/reset control, or the field can't be empty. */
  clearable?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const parsed = value ? parse(value, "yyyy-MM-dd", new Date()) : undefined
  const selected = parsed && isValid(parsed) ? parsed : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("justify-start gap-1.5 px-2.5 font-normal", !selected && "text-muted-foreground", className)}
        >
          <CalendarIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
          {selected ? format(selected, "dd-MM-yyyy") : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          // Re-clicking the selected day makes react-day-picker report undefined; treat that as
          // "keep it" rather than silently clearing — clearing is the explicit button below.
          onSelect={(day) => {
            if (day) onChange(format(day, "yyyy-MM-dd"))
            setOpen(false)
          }}
          initialFocus
        />
        {clearable && selected && (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
