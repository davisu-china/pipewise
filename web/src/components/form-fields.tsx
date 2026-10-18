import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { FormField } from "@/lib/types";
import { cn } from "@/lib/utils";

export type Values = Record<string, unknown>;

/**
 * Schema 驱动的表单渲染。**字段的可见性与可编辑性完全由服务端返回的
 * access/required 决定**（服务端按「节点 × 字段」权限矩阵算好），前端不做判断。
 */
export function FormFields({
  fields,
  values,
  onChange,
  errors = {},
}: {
  fields: FormField[];
  values: Values;
  onChange: (next: Values) => void;
  errors?: Record<string, string>;
}) {
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });

  return (
    <div className="space-y-4">
      {fields.map((f, idx) => {
        if (f.type === "static" || !f.name) {
          return (
            <p key={`static-${idx}`} className="text-sm text-muted-foreground">
              {f.text || f.label}
            </p>
          );
        }
        const name = f.name;
        const value = values[name];
        const editable = f.access === "editable";
        const err = errors[name];
        return (
          <div key={name} className="space-y-1.5">
            <Label htmlFor={`f-${name}`} className="flex items-center gap-2">
              {f.label || name}
              {f.required ? <span className="text-destructive">*</span> : null}
              {f.access === "readonly" ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">只读</span> : null}
            </Label>
            <FieldInput field={f} value={value} editable={editable} onChange={(v) => set(name, v)} />
            {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
            {err ? <p className="text-xs text-destructive">{err}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

function FieldInput({ field, value, editable, onChange }: { field: FormField; value: unknown; editable: boolean; onChange: (v: unknown) => void }) {
  const id = `f-${field.name}`;
  const common = { id, disabled: !editable } as const;

  switch (field.type) {
    case "textarea":
      return <Textarea {...common} value={str(value)} onChange={(e) => onChange(e.target.value)} maxLength={field.max_length || undefined} />;
    case "number":
    case "rating":
      return (
        <Input
          {...common}
          type="number"
          min={field.min ?? (field.type === "rating" ? 0 : undefined)}
          max={field.max ?? (field.type === "rating" ? 10 : undefined)}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "amount":
      return (
        <Input
          {...common}
          type="number"
          step="0.01"
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
    case "date":
      return <Input {...common} type="date" value={str(value)} onChange={(e) => onChange(e.target.value)} />;
    case "datetime":
      return <Input {...common} type="datetime-local" value={str(value).slice(0, 16)} onChange={(e) => onChange(e.target.value)} />;
    case "switch":
      return (
        <div className="flex h-9 items-center">
          <Switch id={id} checked={!!value} disabled={!editable} onCheckedChange={(v) => onChange(v)} />
          <span className="ml-2 text-sm text-muted-foreground">{value ? "是" : "否"}</span>
        </div>
      );
    case "select":
      return (
        <Select value={value === null || value === undefined ? "" : String(value)} onValueChange={(v) => onChange(v || null)} disabled={!editable}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            {(field.options || []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "multi_select": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-4 py-1">
          {(field.options || []).map((o) => (
            <label key={o.value} className={cn("flex items-center gap-2 text-sm", !editable && "opacity-60")}>
              <Checkbox
                checked={arr.includes(o.value)}
                disabled={!editable}
                onCheckedChange={(checked) => onChange(checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    default:
      return <Input {...common} value={str(value)} maxLength={field.max_length || undefined} onChange={(e) => onChange(e.target.value)} />;
  }
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
