import { FileText, Globe, Search, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Which icon represents an `AcpToolCall.kind`. Shared by every place that renders a tool
 * call — AgentAcpPanel, PlanningPanel, and the ticket card face — because they are all
 * labelling the same ACP concept and previously carried three near-identical copies of
 * this switch (which had already drifted: PlanningPanel's was missing the `fetch` case).
 */
export function toolKindIcon(kind: string): LucideIcon {
  switch (kind) {
    case "edit":
    case "delete":
    case "move": {
      return FileText;
    }
    case "execute": {
      return Terminal;
    }
    case "search": {
      return Search;
    }
    case "fetch": {
      return Globe;
    }
    default: {
      return Terminal;
    }
  }
}
