import type { BadgeTone } from "@/lib/format";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "border-slate-700/80 bg-slate-800/70 text-slate-300",
  gold: "border-gold-500/40 bg-gold-500/15 text-gold-300",
  emerald: "border-emerald-500/35 bg-emerald-500/15 text-emerald-300",
  sky: "border-sky-500/35 bg-sky-500/15 text-sky-300",
  amber: "border-amber-500/35 bg-amber-500/15 text-amber-300",
  rose: "border-rose-500/35 bg-rose-500/15 text-rose-300",
  violet: "border-violet-500/35 bg-violet-500/15 text-violet-300",
};

interface StatusBadgeProps {
  label: string;
  tone?: BadgeTone;
  className?: string;
}

export function StatusBadge({
  label,
  tone = "neutral",
  className = "",
}: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
    >
      {label}
    </span>
  );
}
