"""快照校验（PRD §5.5）。"""

from app.engine.graph import validate_snapshot
from app.seed import contract_approval, expense_approval, leave_approval

FORMS = {
    "leave_form": {"fields": [{"name": n} for n in ("leave_days", "leave_reason", "mgr_comment", "vp_comment", "allowance", "leave_left")]},
    "contract_form": {"fields": [{"name": n} for n in ("contract_no", "party", "amount", "legal_comment", "finance_comment", "risk_comment", "owner_comment")]},
    "expense_form": {"fields": [{"name": n} for n in ("amount", "items", "supervisor_comment", "hr_no", "director_comment", "decision")]},
}


def errors(issues):
    return [i for i in issues if i["level"] == "error"]


def test_seed_flows_are_valid():
    for snap in (leave_approval(), contract_approval(), expense_approval()):
        assert errors(validate_snapshot(snap, FORMS)) == [], snap["key"]


def test_requires_single_start():
    snap = leave_approval()
    snap["nodes"].append({"id": "start2", "type": "start"})
    codes = {i["code"] for i in errors(validate_snapshot(snap, FORMS))}
    assert "E_START_COUNT" in codes


def test_xor_needs_default_edge():
    snap = leave_approval()
    for e in snap["edges"]:
        if e["id"] == "e4":
            e["condition"] = "ctx.leave_days > 100"
    codes = {i["code"] for i in errors(validate_snapshot(snap, FORMS))}
    assert "E_XOR_DEFAULT" in codes


def test_fork_cannot_have_condition():
    snap = leave_approval()
    for e in snap["edges"]:
        if e["id"] == "e5":
            e["condition"] = "ctx.leave_days > 1"
    codes = {i["code"] for i in errors(validate_snapshot(snap, FORMS))}
    assert "E_FORK_COND" in codes


def test_unknown_node_type_rejected():
    snap = leave_approval()
    snap["nodes"].append({"id": "svc", "type": "service"})
    snap["edges"].append({"id": "e99", "from": "mgr", "to": "svc"})
    codes = {i["code"] for i in errors(validate_snapshot(snap, FORMS))}
    assert "E_NODE_TYPE_UNSUPPORTED" in codes


def test_script_syntax_checked():
    snap = leave_approval()
    for n in snap["nodes"]:
        if n["id"] == "calc":
            n["script"] = "def run(ctx, local, env, logger, now):\n    return {\n"
    codes = {i["code"] for i in errors(validate_snapshot(snap, FORMS))}
    assert "E_SCRIPT_SYNTAX" in codes


def test_unreachable_node_flagged():
    snap = leave_approval()
    snap["nodes"].append({"id": "orphan", "type": "end", "name": "孤立"})
    codes = {i["code"] for i in errors(validate_snapshot(snap, FORMS))}
    assert "E_NO_IN" in codes or "E_UNREACHABLE" in codes
