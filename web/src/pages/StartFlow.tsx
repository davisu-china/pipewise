import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Play } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errText, useLoad } from "@/lib/hooks";
import type { Definition, FlowSnapshot, FormField, FormSchema } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { FormFields } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface VariableDef {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
}

interface StartNode {
  type?: string;
  formRef?: string;
  fieldPermissions?: Record<string, { access?: string; required?: boolean }>;
}

export function StartFlow() {
  const { key = "" } = useParams();
  const nav = useNavigate();
  const { data, loading, error } = useLoad(async () => {
    const def = await api.get<Definition>(`/definitions/${key}`);
    const schemas = await api.get<{ items: Record<string, FormSchema> }>(`/definitions/${key}/form-schemas`);
    let snapshot: FlowSnapshot | null = null;
    if (def.currentVersion) {
      const version = await api.get<{ snapshot: FlowSnapshot }>(`/definitions/${key}/versions/${def.currentVersion}`);
      snapshot = version.snapshot;
    }
    return { def, schemas: schemas.items, snapshot };
  }, [key]);

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [businessKey, setBusinessKey] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const fields = buildFields(data?.snapshot || null, data?.schemas || {});

  useEffect(() => {
    const init: Record<string, unknown> = {};
    for (const f of fields) if (f.name) init[f.name] = f.value;
    setValues(init);
    // fields 由 data 派生，只随 data 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function submit() {
    if (!businessKey.trim()) {
      toast.error("请填写业务单号");
      return;
    }
    const variables: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.access === "editable" && f.name && values[f.name] !== undefined) variables[f.name] = values[f.name];
    }
    setBusy(true);
    try {
      const inst = await api.post<{ id: number }>(
        "/instances",
        { key, businessKey: businessKey.trim(), title: title.trim(), variables },
        { "Idempotency-Key": businessKey.trim() },
      );
      toast.success("已发起");
      nav(`/instances/${inst.id}`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <>
        <PageHeader title="发起流程" actions={<BackLink />} />
        <EmptyState>加载失败：{error}</EmptyState>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title="发起流程" actions={<BackLink />} />
        <EmptyState>加载中…</EmptyState>
      </>
    );
  }

  if (!data.def.currentVersion) {
    return (
      <>
        <PageHeader title={`发起：${data.def.name}`} actions={<BackLink />} />
        <EmptyState>该流程还没有已发布版本，先由管理员发布。</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`发起：${data.def.name}`}
        description={`${key} · 使用当前版本 v${data.def.currentVersion}`}
        actions={<BackLink />}
      />

      <Card>
        <CardContent className="space-y-5 pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="business-key">业务单号 *</Label>
              <Input
                id="business-key"
                placeholder="业务单号（唯一，用于幂等与反查）"
                value={businessKey}
                onChange={(e) => setBusinessKey(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="title">标题</Label>
              <Input id="title" placeholder="标题（待办列表展示）" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>

          <div className="border-t pt-4">
            {fields.length ? (
              <FormFields fields={fields} values={values} onChange={setValues} />
            ) : (
              <p className="text-sm text-muted-foreground">这个流程的发起节点没有需要填写的字段。</p>
            )}
          </div>
        </CardContent>
        <CardFooter className="border-t pt-4">
          <Button disabled={busy} onClick={submit}>
            <Play /> 发起流程
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}

function buildFields(snapshot: FlowSnapshot | null, schemas: Record<string, FormSchema>): FormField[] {
  if (!snapshot) return [];
  const start = snapshot.nodes.find((n) => n.type === "start") as StartNode | undefined;
  const schema = start?.formRef ? schemas[start.formRef] : undefined;
  if (schema) {
    const perms = start?.fieldPermissions || {};
    return schema.fields
      .filter((f) => f.type !== "static" && f.name)
      .map<FormField>((f) => {
        const perm = perms[f.name] || { access: "readonly" };
        const access = (perm.access || "readonly") as FormField["access"];
        return {
          name: f.name,
          label: f.label || f.name,
          type: f.type,
          access,
          required: !!perm.required && access === "editable",
          value: f.default ?? null,
          options: f.options,
          placeholder: f.placeholder,
          help: f.help,
          min: f.min,
          max: f.max,
          max_length: f.max_length,
          pattern: f.pattern,
          text: f.text,
        };
      })
      .filter((f) => f.access !== "hidden");
  }

  const variables = (snapshot.variables || []) as VariableDef[];
  return variables
    .filter((v) => v.name)
    .map<FormField>((v) => ({
      name: v.name,
      label: `${v.name}${v.required ? " *" : ""}（${v.type || "string"}）`,
      type: variableType(v.type),
      access: "editable",
      required: !!v.required,
      value: v.default ?? null,
    }));
}

function variableType(type?: string): string {
  switch (type) {
    case "number":
      return "number";
    case "amount":
      return "amount";
    case "bool":
      return "switch";
    case "date":
      return "date";
    case "json":
      return "textarea";
    default:
      return "text";
  }
}

function BackLink() {
  return (
    <Button variant="outline" asChild>
      <Link to="/definitions">
        <ArrowLeft /> 返回
      </Link>
    </Button>
  );
}
