export default function GlobalLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="h-3 w-28 rounded bg-slate-800/80" />
          <div className="h-7 w-56 rounded-lg bg-slate-800" />
        </div>
        <div className="h-9 w-36 rounded-xl bg-slate-800" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="exec-card h-24 p-4 flex flex-col justify-between"
          >
            <div className="h-3 w-24 rounded bg-slate-800" />
            <div className="h-6 w-16 rounded bg-slate-800/90" />
          </div>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="exec-card h-64 p-4 space-y-3">
            <div className="h-32 w-full rounded-xl bg-slate-800/70" />
            <div className="h-4 w-3/4 rounded bg-slate-800" />
            <div className="h-3 w-1/2 rounded bg-slate-800/80" />
          </div>
        ))}
      </div>
    </div>
  );
}
