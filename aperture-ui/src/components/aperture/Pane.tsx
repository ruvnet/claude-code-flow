import { memo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PaneSpec } from "@/lib/aperture/types";

interface Props {
  spec: PaneSpec;
  lines: string[];
  active?: boolean;
}

// React.memo so that an inbound message touching one pane doesn't
// re-render the other 25. The parent uses immutable per-pane arrays
// (the `lines` reference only changes when that pane's content changes),
// so the default shallow prop check is correct.
export const Pane = memo(PaneInner);

function PaneInner({ spec, lines, active = false }: Props) {
  const empty = lines.length === 0;
  return (
    <Card
      className={cn(
        "flex flex-col min-h-0 border-zinc-800 bg-zinc-950/60 text-zinc-200",
        active && "ring-1 ring-cyan-500/40"
      )}
      data-pane-id={spec.id}
    >
      <div className="flex items-baseline justify-between border-b border-zinc-800 px-3 py-1 text-[10px] uppercase tracking-wider text-cyan-300/80">
        <span>{spec.title}</span>
        <span className="text-zinc-500 font-mono">{spec.id}</span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 py-2 font-mono text-xs leading-5">
          {empty ? (
            <div className="text-zinc-500">(no data — try {spec.hint})</div>
          ) : (
            lines.map((l, i) => <div key={i}>{l}</div>)
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}
