import { Badge } from "@/components/ui/badge";
import { statusTone } from "@/lib/format";

export function StatusBadge({ status, outcome, className }: { status?: string | null; outcome?: string | null; className?: string }) {
  const tone = statusTone(status);
  const suffix = outcome === "rejected" ? " · 否决" : "";
  return (
    <Badge variant={tone.variant} className={className}>
      {tone.label}
      {suffix}
    </Badge>
  );
}
