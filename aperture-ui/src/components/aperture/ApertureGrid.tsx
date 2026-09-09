import { Pane } from "./Pane";
import { PANE_ORDER, type Pane as PaneId } from "@/lib/aperture/types";

interface Props {
  panes: Record<PaneId, string[]>;
  activeId?: PaneId;
}

/// 4-column responsive grid; collapses to 2 columns ≤1100px and 1 column
/// ≤600px to mirror the SvelteKit host's breakpoints.
export function ApertureGrid({ panes, activeId }: Props) {
  return (
    <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 [grid-auto-rows:14rem]">
      {PANE_ORDER.map((spec) => (
        <Pane
          key={spec.id}
          spec={spec}
          lines={panes[spec.id]}
          active={activeId === spec.id}
        />
      ))}
    </div>
  );
}
