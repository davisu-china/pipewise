"""端到端验收脚本：S1 请假 / S2 合同（并签+竞签）/ S4 报销（字段权限矩阵）。

前提：服务已启动且跑过 `python -m app.seed`。
    python scripts/demo.py            # 默认 http://127.0.0.1:8100/api/v1
    PIPEWISE_API=http://host:8100/api/v1 python scripts/demo.py

每一步都有断言；任何一步不符合预期会以非零码退出（可直接当冒烟用）。
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.getenv("PIPEWISE_API", "http://127.0.0.1:8100/api/v1")
T = {
    "zhangsan": "tok_zhangsan",
    "lisi": "tok_lisi",
    "zhangwei": "tok_zhangwei",
    "wangfang": "tok_wangfang",
    "liumin": "tok_liumin",
    "chenli": "tok_chenli",
    "zhouqiang": "tok_zhouqiang",
    "admin": "tok_admin",
}

failures = 0


def req(method: str, path: str, body=None, token: str | None = None, headers: dict | None = None):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        resp = urllib.request.urlopen(r, timeout=30)
        return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:300]}


def check(label: str, cond: bool, extra="") -> None:
    global failures
    if cond:
        print(f"  ✅ {label}")
    else:
        failures += 1
        print(f"  ❌ {label}  {extra}")


def pending(token: str, iid: int | None = None) -> list[dict]:
    q = "/tasks?assignee=me&status=pending" + (f"&instanceId={iid}" if iid else "")
    _, out = req("GET", q, token=token)
    return out.get("items", [])


def first_task(token: str, iid: int) -> dict:
    items = pending(token, iid)
    assert items, f"{token} 在实例 {iid} 上没有待办"
    return items[0]


def inst(iid: int, token: str) -> dict:
    _, out = req("GET", f"/instances/{iid}", token=token)
    return out


def create(key: str, token: str, variables: dict, title: str) -> dict:
    bk = f"DEMO-{int(time.time() * 1000)}"
    st, out = req(
        "POST", "/instances",
        {"key": key, "businessKey": bk, "title": title, "variables": variables},
        token=token, headers={"Idempotency-Key": bk},
    )
    assert st == 200, out
    return out


def s1_leave() -> None:
    print("\n== S1 请假审批：或签 → 条件分支 → 并行（并签+或签）→ 汇聚 → 脚本 → 结束 ==")
    inst1 = create("leave_approval", T["zhangsan"],
                   {"leave_days": 3, "leave_reason": "回家"}, "张三请假 3 天")
    iid = inst1["id"]
    check("创建后停在「直属主管审批」",
          [n["nodeName"] for n in inst1["currentNodes"]] == ["直属主管审批"], inst1["currentNodes"])

    mgr = first_task(T["lisi"], iid)
    st, _ = req("GET", f"/tasks/{mgr['id']}/form", token=T["lisi"])
    form = _["form"]
    check("主管表单：金额/天数是只读、主管意见可编辑必填",
          {(f["name"], f["access"], f["required"]) for f in form["fields"]} ==
          {("leave_days", "readonly", False), ("leave_reason", "readonly", False), ("mgr_comment", "editable", True)})

    st, out = req("POST", f"/tasks/{mgr['id']}/submit-form",
                  {"verdict": "approve", "comment": "同意", "data": {"mgr_comment": "同意，注意交接"}}, token=T["lisi"])
    check("主管通过", st == 200, out)
    nodes = [n["nodeName"] for n in inst(iid, T["zhangsan"])["currentNodes"]]
    check("天数>2 走进并行分支（HR 备案 + 部门负责人）", set(nodes) == {"HR 备案", "部门负责人审批"}, nodes)

    vp = first_task(T["zhangwei"], iid)
    hr = first_task(T["wangfang"], iid)
    st, _ = req("POST", f"/tasks/{vp['id']}/submit-form",
                {"verdict": "approve", "comment": "批准", "data": {"vp_comment": "批准"}}, token=T["zhangwei"])
    check("VP 通过（并行分支 1）", st == 200)
    check("汇聚还在等 HR", inst(iid, T["zhangsan"])["status"] == "RUNNING")

    st, _ = req("POST", f"/tasks/{hr['id']}/complete", {"verdict": "approve", "comment": "已备案"}, token=T["wangfang"])
    check("HR 通过（并行分支 2）→ 汇聚", st == 200)
    final = inst(iid, T["zhangsan"])
    check("实例完成", final["status"] == "COMPLETED" and final["outcome"] == "completed", final["status"])
    check("脚本算出补贴/剩余年假",
          final["variables"].get("allowance") == 1500 and final["variables"].get("leave_left") == 12,
          final["variables"])


def s2_contract() -> None:
    print("\n== S2 采购合同：>50 万三方并签 / <50 万竞签 ==")
    big = create("contract_approval", T["zhangsan"],
                 {"contract_no": "HT-001", "party": "供应商A", "amount": 680000}, "采购合同 68 万")
    iid = big["id"]
    check(">50 万进三方并签", {n["nodeName"] for n in big["currentNodes"]} == {"法务会签", "财务会签", "风控会签"})

    for who, field in (("chenli", "legal_comment"), ("liumin", "finance_comment")):
        t = first_task(T[who], iid)
        st, _ = req("POST", f"/tasks/{t['id']}/submit-form",
                    {"verdict": "approve", "comment": "ok", "data": {field: "同意"}}, token=T[who])
        check(f"{who} 会签通过", st == 200)
    check("还差风控：实例仍在跑", inst(big["id"], T["zhangsan"])["status"] == "RUNNING")
    t = first_task(T["zhouqiang"], iid)
    req("POST", f"/tasks/{t['id']}/submit-form",
        {"verdict": "approve", "comment": "ok", "data": {"risk_comment": "同意"}}, token=T["zhouqiang"])
    check("三方并签完成后实例结束", inst(big["id"], T["zhangsan"])["status"] == "COMPLETED")

    veto = create("contract_approval", T["zhangsan"],
                  {"contract_no": "HT-002", "party": "供应商B", "amount": 800000}, "一票否决示例")
    iid = veto["id"]
    t = first_task(T["chenli"], iid)
    req("POST", f"/tasks/{t['id']}/submit-form",
        {"verdict": "reject", "comment": "条款有问题", "data": {"legal_comment": "不通过"}}, token=T["chenli"])
    v = inst(veto["id"], T["zhangsan"])
    check("法务否决 → 整单否决、其余任务回收",
          v["status"] == "COMPLETED" and v["outcome"] == "rejected" and
          sorted(t["status"] for t in v["tasks"]) == ["CANCELLED", "CANCELLED", "COMPLETED"])

    small = create("contract_approval", T["zhangsan"],
                   {"contract_no": "HT-003", "party": "小店", "amount": 6800}, "小额采购竞签")
    iid = small["id"]
    owners = pending(T["lisi"], iid) + pending(T["wangfang"], iid)
    check("竞签同时发给两个业务负责人", len(owners) == 2)
    winner = owners[0]
    other = owners[1]
    st, _ = req("POST", f"/tasks/{winner['id']}/submit-form",
                {"verdict": "approve", "comment": "我拍板", "data": {"owner_comment": "同意"}},
                token=T["lisi"] if winner["assignee"] == "u_lisi" else T["wangfang"])
    check("第一个处理者定音", st == 200)
    st, out = req("POST", f"/tasks/{other['id']}/submit-form",
                  {"verdict": "approve", "data": {"owner_comment": "我也同意"}},
                  token=T["lisi"] if other["assignee"] == "u_lisi" else T["wangfang"])
    check("第二个人再提交被拒（竞签已结束）", st == 409, out)


def s4_expense() -> None:
    print("\n== S4 费用报销：同一张表单在 5 个节点上权限不同 ==")
    e = create("expense_approval", T["zhangsan"], {"amount": 6800, "items": "机票 5000 / 酒店 1800"}, "报销 6800")
    iid = e["id"]
    mgr = first_task(T["lisi"], iid)
    _, f = req("GET", f"/tasks/{mgr['id']}/form", token=T["lisi"])
    access = {x["name"]: x["access"] for x in f["form"]["fields"]}
    check("主管节点：金额只读、主管意见可编辑、HR 备案号不可见",
          access == {"amount": "readonly", "items": "readonly", "supervisor_comment": "editable"}, access)

    st, out = req("POST", f"/tasks/{mgr['id']}/submit-form",
                  {"verdict": "approve", "comment": "ok", "data": {"supervisor_comment": ""}}, token=T["lisi"])
    check("主管意见必填：空值被拒", st == 400 and out["error"]["code"] == "FORM_VALIDATION_FAILED", out)

    st, _ = req("POST", f"/tasks/{mgr['id']}/submit-form",
                {"verdict": "approve", "comment": "ok",
                 "data": {"supervisor_comment": "同意报销", "amount": 99999, "hr_no": "HACK"}}, token=T["lisi"])
    check("越权字段被静默丢弃（不报错）", st == 200)
    v = inst(e["id"], T["zhangsan"])
    check("金额未被篡改、隐藏字段未写入",
          float(v["variables"]["amount"]) == 6800 and "hr_no" not in v["variables"], v["variables"])

    hr = first_task(T["wangfang"], iid)
    _, f = req("GET", f"/tasks/{hr['id']}/form", token=T["wangfang"])
    access = {x["name"]: x["access"] for x in f["form"]["fields"]}
    check("HR 节点：备案号可编辑、金额只读", access.get("hr_no") == "editable" and access.get("amount") == "readonly", access)
    st, _ = req("POST", f"/tasks/{hr['id']}/submit-form",
                {"data": {"hr_no": "HR-2026-001"}, "comment": "备案"}, token=T["wangfang"])
    check("HR 提交", st == 200)

    d = first_task(T["zhangwei"], iid)
    _, f = req("GET", f"/tasks/{d['id']}/form", token=T["zhangwei"])
    access = {x["name"]: x["access"] for x in f["form"]["fields"]}
    check("总监节点：结论/批注可编辑", access.get("decision") == "editable" and access.get("director_comment") == "editable", access)
    st, _ = req("POST", f"/tasks/{d['id']}/submit-form",
                {"verdict": "approve", "data": {"director_comment": "批准", "decision": "approve"}}, token=T["zhangwei"])
    check("总监通过 → 实例完成", st == 200 and inst(e["id"], T["zhangsan"])["status"] == "COMPLETED")


def extras() -> None:
    print("\n== 其它验收：幂等 / 退回重提 / 试跑 / 越权 ==")
    bk = f"DEMO-DUP-{int(time.time())}"
    st1, a = req("POST", "/instances",
                 {"key": "leave_approval", "businessKey": bk, "variables": {"leave_days": 1, "leave_reason": "x"}},
                 token=T["zhangsan"], headers={"Idempotency-Key": bk})
    st2, b = req("POST", "/instances",
                 {"key": "leave_approval", "businessKey": bk, "variables": {"leave_days": 1, "leave_reason": "x"}},
                 token=T["zhangsan"], headers={"Idempotency-Key": bk})
    check("同一 businessKey 重复创建是幂等的", a["id"] == b["id"])
    st, _ = req("POST", f"/instances/{a['id']}/withdraw", {}, token=T["zhangsan"])
    check("发起人可撤回", st == 200 and inst(a["id"], T["zhangsan"])["status"] == "TERMINATED")

    r = create("expense_approval", T["zhangsan"], {"amount": 100, "items": "打车"}, "退回重提示例")
    iid = r["id"]
    t = first_task(T["lisi"], iid)
    req("POST", f"/tasks/{t['id']}/submit-form",
        {"verdict": "reject", "comment": "补发票", "data": {"supervisor_comment": "退回"}}, token=T["lisi"])
    resub = pending(T["zhangsan"], r["id"])
    check("退回发起人生成「重提单」", len(resub) == 1 and resub[0]["kind"] == "resubmit")
    _, rf = req("GET", f"/tasks/{resub[0]['id']}/form", token=T["zhangsan"])
    values = {x["name"]: x["value"] for x in rf["form"]["fields"]}
    st, _ = req("POST", f"/tasks/{resub[0]['id']}/submit-form",
                {"data": {"amount": values.get("amount") or 100, "items": "打车（补发票）"}, "comment": "补好了"},
                token=T["zhangsan"])
    check("重提后回到主管审批", st == 200 and [n["nodeName"] for n in inst(r["id"], T["zhangsan"])["currentNodes"]] == ["主管审批"])

    st, out = req("POST", "/definitions/leave_approval/dry-run",
                  {"variables": {"leave_days": 3, "leave_reason": "试跑"}}, token="tok_designer")
    check("试跑跑通且不落库",
          st == 200 and out["finished"] and out["trace"][0]["nodeName"] == "发起申请", out)
    st, _ = req("GET", f"/instances/{r['id']}", token=T["zhouqiang"])
    check("无关用户看不到别人的实例", st == 403)


def main() -> None:
    print(f"PipeWise 端到端验收 → {BASE}")
    s1_leave()
    s2_contract()
    s4_expense()
    extras()
    print()
    if failures:
        print(f"❌ {failures} 项不符合预期")
        sys.exit(1)
    print("✅ 全部通过")


if __name__ == "__main__":
    main()
