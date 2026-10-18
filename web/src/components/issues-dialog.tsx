import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Issue } from "@/lib/types";

export function IssuesDialog({ open, onOpenChange, issues }: { open: boolean; onOpenChange: (v: boolean) => void; issues: Issue[] }) {
  const errors = issues.filter((i) => i.level === "error");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {errors.length ? <XCircle className="h-5 w-5 text-destructive" /> : <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
            校验结果
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {issues.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有发现问题。</p>
          ) : (
            issues.map((i, idx) => (
              <div
                key={idx}
                className={
                  i.level === "error"
                    ? "rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
                    : "rounded-md border border-amber-300/50 bg-amber-50 p-3 text-sm"
                }
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className={i.level === "error" ? "mt-0.5 h-4 w-4 shrink-0 text-destructive" : "mt-0.5 h-4 w-4 shrink-0 text-amber-600"} />
                  <div>
                    <div className="font-medium">{i.level === "error" ? "错误" : "警告"} · {i.code}</div>
                    <div className="mt-0.5 text-muted-foreground">{i.message}</div>
                    {(i.node || i.edge) && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {i.node ? `节点：${i.node}` : ""} {i.edge ? `边：${i.edge}` : ""}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
