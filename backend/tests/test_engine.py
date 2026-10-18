"""引擎核心场景（PRD §3.1 / §8 / §9 / §10 / §17）。"""

from __future__ import annotations

import pytest

from app.engine.engine import engine
from app.engine.errors import ApiError
from app.models import NodeInstance, Task, Version
from app.seed import contract_approval, expense_approval, leave_approval

from .helpers import do, expect_error, make_instance, open_tasks, publish_flow, reload

SNAPSHOTS = [leave_approval(), contract_approval(), expense_approval()]

FORM_VALUES = {
    "leave_form": {"leave_days": 3, "leave_reason": "回家"},
    "contract_form": {"contract_no": "HT-1", "party": "供应商", "amount": 680000},
    "expense_form": {"amount": 6800, "items": "机票"},
}


def ensure_flows(session):
    for snap in SNAPSHOTS:
        publish_flow(session, snap["key"], snap)


# ------------------------------------------------------------------ S1


def test_s1_parallel_join_and_script(session):
    ensure_flows(session)
    inst = make_instance(session, "leave_approval", FORM_VALUES["leave_form"])
    assert inst.status == "RUNNING"

    mgr = open_tasks(session, inst, "u_lisi")[0]
    do(session, mgr, data={"mgr_comment": "同意"})
    inst = reload(session, inst)
    # 天数 > 2：并行分叉出两条分支（HR 并签 + VP 或签）
    assert {t.node_id for t in open_tasks(session, inst)} == {"hr", "vp"}

    hr = open_tasks(session, inst, "u_wangfang")[0]
    vp = open_tasks(session, inst, "u_zhangwei")[0]
    do(session, vp, data={"vp_comment": "批"})
    inst = reload(session, inst)
    assert inst.status == "RUNNING"  # join 还差 HR 那条

    do(session, hr)
    inst = reload(session, inst)
    assert inst.status == "COMPLETED" and inst.outcome == "completed"
    versions = session.get(Version, inst.version_id)
    from app.engine.context import process_vars

    values = process_vars(session, inst.id)
    assert values["allowance"] == 1500 and values["leave_left"] == 12
    assert versions.snapshot_json["key"] == "leave_approval"


def test_xor_takes_default_when_days_small(session):
    ensure_flows(session)
    inst = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"})
    do(session, open_tasks(session, inst, "u_lisi")[0], data={"mgr_comment": "ok"})
    inst = reload(session, inst)
    # 不多走并行分支：直接进脚本节点
    assert inst.status == "COMPLETED"
    assert {ni.node_id for ni in session.query(NodeInstance).filter_by(instance_id=inst.id)} == {
        "start", "mgr", "gw_days", "calc", "end",
    }


# ------------------------------------------------------------------ 签核


def _sign_flow(session, key: str, sign_mode: str, **extra):
    snap = {
        "key": key,
        "name": f"签核测试-{sign_mode}",
        "variables": [{"name": "v", "type": "string"}],
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "sign", "type": "approval", "name": "会签", "assignee": {"type": "role", "code": "owner"},
             "signMode": sign_mode, "rejectStrategy": "terminate", **extra},
            {"id": "end", "type": "end"},
        ],
        "edges": [{"id": "a", "from": "start", "to": "sign"}, {"id": "b", "from": "sign", "to": "end"}],
    }
    publish_flow(session, key, snap)


def test_any_sign_first_approve_wins(session):
    _sign_flow(session, "t_any", "any")
    inst = make_instance(session, "t_any", {"v": "1"})
    tasks = open_tasks(session, inst)
    assert len(tasks) == 2
    do(session, tasks[0])
    inst = reload(session, inst)
    assert inst.status == "COMPLETED"
    statuses = {t.assignee: t.status for t in session.query(Task).filter_by(instance_id=inst.id)}
    assert sorted(statuses.values()) == ["CANCELLED", "COMPLETED"]


def test_any_sign_reject_does_not_finish(session):
    _sign_flow(session, "t_any2", "any")
    inst = make_instance(session, "t_any2", {"v": "1"})
    a, b = open_tasks(session, inst)
    do(session, a, verdict="reject")
    inst = reload(session, inst)
    assert inst.status == "RUNNING"  # 否决不终结，别人还能救
    do(session, b)
    inst = reload(session, inst)
    assert inst.status == "COMPLETED"


def test_all_sign_needs_everyone_and_veto(session):
    _sign_flow(session, "t_all", "all")
    inst = make_instance(session, "t_all", {"v": "1"})
    a, b = open_tasks(session, inst)
    do(session, a)
    inst = reload(session, inst)
    assert inst.status == "RUNNING"
    do(session, b)
    inst = reload(session, inst)
    assert inst.status == "COMPLETED"

    inst2 = make_instance(session, "t_all", {"v": "2"})
    a, b = open_tasks(session, inst2)
    do(session, a, verdict="reject")
    inst2 = reload(session, inst2)
    assert inst2.status == "COMPLETED" and inst2.outcome == "rejected"
    assert [t.status for t in session.query(Task).filter_by(instance_id=inst2.id)] == ["COMPLETED", "CANCELLED"]


def test_race_first_verdict_wins(session):
    _sign_flow(session, "t_race", "race")
    inst = make_instance(session, "t_race", {"v": "1"})
    a, b = open_tasks(session, inst)
    do(session, a, verdict="reject")  # 第一个否决也定音
    inst = reload(session, inst)
    assert inst.status == "COMPLETED" and inst.outcome == "rejected"
    expect_error(lambda: do(session, b), "TASK_ALREADY_DONE")


def test_add_sign_participates_in_decision(session):
    _sign_flow(session, "t_addsign", "all")
    inst = make_instance(session, "t_addsign", {"v": "1"})
    a, b = open_tasks(session, inst)
    do(session, a)
    from app.models import Task

    session.add(Task(instance_id=inst.id, node_instance_id=b.node_instance_id, node_id="sign",
                     kind="approval", assignee="u_chenli", status="CREATED"))
    session.flush()
    inst = reload(session, inst)
    assert inst.status == "RUNNING"  # 加签后又要等新任务
    do(session, open_tasks(session, inst, "u_chenli")[0])
    do(session, b)
    assert reload(session, inst).status == "COMPLETED"


# ------------------------------------------------------------------ 表单


def test_form_permission_matrix_and_unauthorized_drop(session):
    ensure_flows(session)
    inst = make_instance(session, "expense_approval", FORM_VALUES["expense_form"])
    mgr = open_tasks(session, inst, "u_lisi")[0]

    # 只读字段写新值 + 隐藏字段提交 → 丢弃，不报错
    do(session, mgr, data={"supervisor_comment": "同意", "amount": 99999, "hr_no": "HACK"})
    from app.engine.context import process_vars

    values = process_vars(session, inst.id)
    assert values["amount"] == "6800.00" or float(values["amount"]) == 6800
    assert "hr_no" not in values
    assert values["supervisor_comment"] == "同意"

    inst = reload(session, inst)
    hr = open_tasks(session, inst, "u_wangfang")[0]
    expect_error(lambda: do(session, hr, data={}), "FORM_VALIDATION_FAILED")  # 备案号必填
    do(session, hr, data={"hr_no": "HR-1"})
    inst = reload(session, inst)
    d = open_tasks(session, inst, "u_zhangwei")[0]
    expect_error(lambda: do(session, d, data={"director_comment": "批"}), "FORM_VALIDATION_FAILED")
    do(session, d, data={"director_comment": "批", "decision": "approve"})
    assert reload(session, inst).status == "COMPLETED"


def test_form_validation_failure_does_not_advance(session):
    ensure_flows(session)
    inst = make_instance(session, "expense_approval", FORM_VALUES["expense_form"])
    mgr = open_tasks(session, inst, "u_lisi")[0]
    expect_error(lambda: do(session, mgr, data={"supervisor_comment": ""}), "FORM_VALIDATION_FAILED")
    inst = reload(session, inst)
    assert inst.status == "RUNNING"
    assert [t.status for t in open_tasks(session, inst)] == ["CREATED"]  # 任务没被消费


# ------------------------------------------------------------------ 退回/生命周期


def test_reject_to_start_then_resubmit(session):
    ensure_flows(session)
    inst = make_instance(session, "expense_approval", FORM_VALUES["expense_form"])
    mgr = open_tasks(session, inst, "u_lisi")[0]
    do(session, mgr, verdict="reject", data={"supervisor_comment": "退回"})
    inst = reload(session, inst)
    assert inst.status == "RUNNING"
    resub = open_tasks(session, inst, "u_zhangsan")
    assert len(resub) == 1 and resub[0].kind == "resubmit"

    do(session, resub[0], data={"amount": 6800, "items": "机票（补发票）"})
    inst = reload(session, inst)
    assert inst.status == "RUNNING"
    assert {t.node_id for t in open_tasks(session, inst)} == {"mgr"}  # 从 start 重走


def test_withdraw_before_any_task_handled(session):
    ensure_flows(session)
    inst = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"})
    engine.withdraw(session, inst.id, "u_zhangsan")
    inst = reload(session, inst)
    assert inst.status == "TERMINATED" and inst.outcome == "terminated"
    assert open_tasks(session, inst) == []


def test_withdraw_too_late(session):
    ensure_flows(session)
    # 用 3 天（会进并行分支），保证主管批完实例仍在跑
    inst = make_instance(session, "leave_approval", {"leave_days": 3, "leave_reason": "x"})
    do(session, open_tasks(session, inst, "u_lisi")[0], data={"mgr_comment": "ok"})
    expect_error(lambda: engine.withdraw(session, inst.id, "u_zhangsan"), "WITHDRAW_TOO_LATE")


def test_suspend_blocks_task_actions(session):
    ensure_flows(session)
    inst = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"})
    engine.suspend(session, inst.id, "u_admin")
    task = open_tasks(session, inst, "u_lisi")[0]
    expect_error(lambda: do(session, task, data={"mgr_comment": "ok"}), "INSTANCE_SUSPENDED")
    engine.resume(session, inst.id, "u_admin")
    do(session, task, data={"mgr_comment": "ok"})
    assert reload(session, inst).status == "COMPLETED"


def test_terminate_cancels_tasks(session):
    ensure_flows(session)
    inst = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"})
    engine.terminate(session, inst.id, "u_admin", "测试终止")
    inst = reload(session, inst)
    assert inst.status == "TERMINATED"
    assert open_tasks(session, inst) == []


# ------------------------------------------------------------------ 幂等/保护


def test_same_business_key_is_deduplicated(session):
    ensure_flows(session)
    a = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"}, business_key="DUP-1")
    b = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"}, business_key="DUP-1")
    assert a.id == b.id


def test_task_double_submit(session):
    ensure_flows(session)
    inst = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"})
    task = open_tasks(session, inst, "u_lisi")[0]
    do(session, task, data={"mgr_comment": "ok"})
    expect_error(lambda: do(session, task, data={"mgr_comment": "again"}), "TASK_ALREADY_DONE")


def test_step_limit_protection(session):
    from app.config import settings

    snap = {
        "key": "t_loop",
        "name": "死循环",
        "variables": [],
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "a", "type": "exclusive_gateway"},
            {"id": "end", "type": "end"},
        ],
        "edges": [
            {"id": "e1", "from": "start", "to": "a"},
            {"id": "e2", "from": "a", "to": "a", "condition": "true"},
            {"id": "e3", "from": "a", "to": "end", "condition": "false"},
        ],
    }
    publish_flow(session, "t_loop", snap)
    old = settings.MAX_STEPS
    settings.MAX_STEPS = 30
    try:
        inst = make_instance(session, "t_loop", {})
        inst = reload(session, inst)
        assert inst.status == "FAILED"
    finally:
        settings.MAX_STEPS = old


def test_admin_interventions(session):
    ensure_flows(session)
    inst = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"})
    task = open_tasks(session, inst, "u_lisi")[0]
    engine.force_complete_task(session, task.id, "u_admin", "approve", "管理员代批")
    assert reload(session, inst).status == "COMPLETED"

    inst2 = make_instance(session, "leave_approval", {"leave_days": 1, "leave_reason": "x"})
    engine.set_variable(session, inst2.id, "leave_days", 9, "u_admin")
    from app.engine.context import process_vars

    assert process_vars(session, inst2.id)["leave_days"] == 9
