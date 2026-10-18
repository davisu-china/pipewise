"""种子数据：组织、表单、三个演示流程（S1 请假 / S2 合同 / S4 报销）。

幂等：按 key upsert；已发布的定义不重复发布。
运行：`.venv/bin/python -m app.seed`
"""

from __future__ import annotations

import os

from sqlalchemy import select

from .db import Base, SessionLocal, engine
from .engine.publishing import create_version
from .models import Dept, Definition, Form, FormVersion, User, Webhook

# ---------------------------------------------------------------- 组织

DEPTS = [
    {"id": "d_rd", "name": "研发部", "leader_id": "u_zhangwei"},
    {"id": "d_hr", "name": "人力资源部", "leader_id": "u_wangfang"},
    {"id": "d_fin", "name": "财务部", "leader_id": "u_liumin"},
    {"id": "d_legal", "name": "法务部", "leader_id": "u_chenli"},
    {"id": "d_risk", "name": "风控部", "leader_id": "u_zhouqiang"},
]

USERS = [
    {"id": "u_admin", "name": "系统管理员", "dept_id": None, "manager_id": None, "roles": ["admin"], "token": "tok_admin"},
    {"id": "u_designer", "name": "流程设计师", "dept_id": None, "manager_id": None, "roles": ["designer"], "token": "tok_designer"},
    {"id": "u_zhangwei", "name": "张伟", "dept_id": "d_rd", "manager_id": None, "roles": ["user", "director"], "token": "tok_zhangwei"},
    {"id": "u_lisi", "name": "李四", "dept_id": "d_rd", "manager_id": "u_zhangwei", "roles": ["user", "owner"], "token": "tok_lisi"},
    {"id": "u_zhangsan", "name": "张三", "dept_id": "d_rd", "manager_id": "u_lisi", "roles": ["user"], "token": "tok_zhangsan"},
    {"id": "u_wangfang", "name": "王芳", "dept_id": "d_hr", "manager_id": None, "roles": ["user", "hr", "owner"], "token": "tok_wangfang"},
    {"id": "u_liumin", "name": "刘敏", "dept_id": "d_fin", "manager_id": None, "roles": ["user", "finance"], "token": "tok_liumin"},
    {"id": "u_chenli", "name": "陈立", "dept_id": "d_legal", "manager_id": None, "roles": ["user", "legal"], "token": "tok_chenli"},
    {"id": "u_zhouqiang", "name": "周强", "dept_id": "d_risk", "manager_id": None, "roles": ["user", "risk"], "token": "tok_zhouqiang"},
]

# ---------------------------------------------------------------- 表单

LEAVE_FORM = {
    "key": "leave_form",
    "name": "请假单",
    "fields": [
        {"name": "leave_days", "label": "请假天数", "type": "number", "required": True, "min": 0.5, "max": 60},
        {"name": "leave_reason", "label": "请假事由", "type": "textarea", "required": True, "max_length": 500},
        {"name": "mgr_comment", "label": "主管意见", "type": "textarea"},
        {"name": "vp_comment", "label": "部门负责人意见", "type": "textarea"},
        {"name": "allowance", "label": "差旅补贴（脚本计算）", "type": "number"},
        {"name": "leave_left", "label": "剩余年假（脚本计算）", "type": "number"},
    ],
}

CONTRACT_FORM = {
    "key": "contract_form",
    "name": "采购合同审批单",
    "fields": [
        {"name": "contract_no", "label": "合同编号", "type": "text", "required": True, "max_length": 64},
        {"name": "party", "label": "供应商", "type": "text", "required": True, "max_length": 128},
        {"name": "amount", "label": "合同金额（元）", "type": "amount", "required": True, "min": 0},
        {"name": "legal_comment", "label": "法务意见", "type": "textarea"},
        {"name": "finance_comment", "label": "财务意见", "type": "textarea"},
        {"name": "risk_comment", "label": "风控意见", "type": "textarea"},
        {"name": "owner_comment", "label": "业务负责人意见", "type": "textarea"},
    ],
}

EXPENSE_FORM = {
    "key": "expense_form",
    "name": "费用报销单",
    "fields": [
        {"name": "amount", "label": "报销金额", "type": "amount", "required": True, "min": 0},
        {"name": "items", "label": "费用明细", "type": "textarea", "required": True, "max_length": 1000},
        {"name": "supervisor_comment", "label": "主管意见", "type": "textarea"},
        {"name": "hr_no", "label": "HR 备案号", "type": "text"},
        {"name": "director_comment", "label": "总监批注", "type": "textarea"},
        {
            "name": "decision",
            "label": "审批结论",
            "type": "select",
            "options": [{"label": "同意", "value": "approve"}, {"label": "否决", "value": "reject"}],
        },
    ],
}

FORMS = [LEAVE_FORM, CONTRACT_FORM, EXPENSE_FORM]


def _hidden(*names: str) -> dict:
    return {n: {"access": "hidden"} for n in names}


def _ro(*names: str) -> dict:
    return {n: {"access": "readonly"} for n in names}


def _editable(name: str, required: bool = False) -> dict:
    return {name: {"access": "editable", "required": required}}


def leave_approval() -> dict:
    nodes = [
        {
            "id": "start", "type": "start", "name": "发起申请", "position": {"x": 80, "y": 200},
            "formRef": "leave_form",
            "fieldPermissions": {
                "leave_days": {"access": "editable", "required": True},
                "leave_reason": {"access": "editable", "required": True},
                **_hidden("mgr_comment", "vp_comment", "allowance", "leave_left"),
            },
        },
        {
            "id": "mgr", "type": "approval", "name": "直属主管审批", "position": {"x": 300, "y": 200},
            "assignee": {"type": "managerOf", "level": 1}, "signMode": "any", "rejectStrategy": "to_start",
            "formRef": "leave_form",
            "fieldPermissions": {
                **_ro("leave_days", "leave_reason"), **_editable("mgr_comment", True),
                **_hidden("vp_comment", "allowance", "leave_left"),
            },
        },
        {"id": "gw_days", "type": "exclusive_gateway", "name": "天数 > 2？", "position": {"x": 520, "y": 200}},
        {"id": "fork", "type": "parallel_gateway", "gatewayDirection": "fork", "name": "并行", "position": {"x": 700, "y": 60}},
        {
            "id": "hr", "type": "approval", "name": "HR 备案", "position": {"x": 880, "y": 20},
            "assignee": {"type": "role", "code": "hr"}, "signMode": "all", "rejectStrategy": "to_start",
        },
        {
            "id": "vp", "type": "approval", "name": "部门负责人审批", "position": {"x": 880, "y": 160},
            "assignee": {"type": "managerOf", "level": 2}, "signMode": "any", "rejectStrategy": "to_start",
            "formRef": "leave_form",
            "fieldPermissions": {
                **_ro("leave_days", "leave_reason", "mgr_comment"), **_editable("vp_comment", True),
                **_hidden("allowance", "leave_left"),
            },
        },
        {"id": "join", "type": "parallel_gateway", "gatewayDirection": "join", "name": "汇聚", "position": {"x": 1060, "y": 90}},
        {
            "id": "calc", "type": "script", "name": "计算补贴/剩余年假", "position": {"x": 1240, "y": 200},
            "script": (
                "def run(ctx, local, env, logger, now):\n"
                "    days = ctx.get('leave_days', 0)\n"
                "    rate = 500\n"
                "    allowance = days * rate\n"
                "    left = max(0, 15 - days)\n"
                "    logger.info(f'allowance={allowance} left={left}')\n"
                "    return {'allowance': allowance, 'leave_left': left}\n"
            ),
        },
        {"id": "end", "type": "end", "name": "结束", "position": {"x": 1420, "y": 200}},
    ]
    edges = [
        {"id": "e1", "from": "start", "to": "mgr"},
        {"id": "e2", "from": "mgr", "to": "gw_days"},
        {"id": "e3", "from": "gw_days", "to": "fork", "condition": "ctx.leave_days > 2"},
        {"id": "e4", "from": "gw_days", "to": "calc", "condition": "true"},
        {"id": "e5", "from": "fork", "to": "hr"},
        {"id": "e6", "from": "fork", "to": "vp"},
        {"id": "e7", "from": "hr", "to": "join"},
        {"id": "e8", "from": "vp", "to": "join"},
        {"id": "e9", "from": "join", "to": "calc"},
        {"id": "e10", "from": "calc", "to": "end"},
    ]
    variables = [
        {"name": "leave_days", "type": "number", "required": True},
        {"name": "leave_reason", "type": "string", "required": True},
        {"name": "mgr_comment", "type": "string"},
        {"name": "vp_comment", "type": "string"},
        {"name": "allowance", "type": "number"},
        {"name": "leave_left", "type": "number"},
    ]
    return {"key": "leave_approval", "name": "请假审批", "variables": variables, "nodes": nodes, "edges": edges}


def contract_approval() -> dict:
    nodes = [
        {
            "id": "start", "type": "start", "name": "发起合同", "position": {"x": 80, "y": 240},
            "formRef": "contract_form",
            "fieldPermissions": {
                "contract_no": {"access": "editable", "required": True},
                "party": {"access": "editable", "required": True},
                "amount": {"access": "editable", "required": True},
                **_hidden("legal_comment", "finance_comment", "risk_comment", "owner_comment"),
            },
        },
        {"id": "gw_amount", "type": "exclusive_gateway", "name": "金额 > 50 万？", "position": {"x": 300, "y": 240}},
        {"id": "fork", "type": "parallel_gateway", "gatewayDirection": "fork", "name": "三方并签", "position": {"x": 500, "y": 100}},
        {
            "id": "legal", "type": "approval", "name": "法务会签", "position": {"x": 680, "y": 20},
            "assignee": {"type": "role", "code": "legal"}, "signMode": "all", "rejectStrategy": "terminate",
            "formRef": "contract_form",
            "fieldPermissions": {
                **_ro("contract_no", "party", "amount"), **_editable("legal_comment", True),
                **_hidden("finance_comment", "risk_comment", "owner_comment"),
            },
        },
        {
            "id": "finance", "type": "approval", "name": "财务会签", "position": {"x": 680, "y": 120},
            "assignee": {"type": "role", "code": "finance"}, "signMode": "all", "rejectStrategy": "terminate",
            "formRef": "contract_form",
            "fieldPermissions": {
                **_ro("contract_no", "party", "amount"), **_editable("finance_comment", True),
                **_hidden("legal_comment", "risk_comment", "owner_comment"),
            },
        },
        {
            "id": "risk", "type": "approval", "name": "风控会签", "position": {"x": 680, "y": 220},
            "assignee": {"type": "role", "code": "risk"}, "signMode": "all", "rejectStrategy": "terminate",
            "formRef": "contract_form",
            "fieldPermissions": {
                **_ro("contract_no", "party", "amount"), **_editable("risk_comment", True),
                **_hidden("legal_comment", "finance_comment", "owner_comment"),
            },
        },
        {"id": "join", "type": "parallel_gateway", "gatewayDirection": "join", "name": "三方汇聚", "position": {"x": 880, "y": 120}},
        {"id": "end_ok", "type": "end", "name": "审批通过", "position": {"x": 1060, "y": 60}},
        {
            "id": "owner_race", "type": "approval", "name": "业务负责人竞签", "position": {"x": 500, "y": 380},
            "assignee": {"type": "role", "code": "owner"}, "signMode": "race", "rejectStrategy": "terminate",
            "formRef": "contract_form",
            "fieldPermissions": {
                **_ro("contract_no", "party", "amount"), **_editable("owner_comment"),
                **_hidden("legal_comment", "finance_comment", "risk_comment"),
            },
        },
        {"id": "end_race", "type": "end", "name": "竞签结束", "position": {"x": 720, "y": 400}},
    ]
    edges = [
        {"id": "c1", "from": "start", "to": "gw_amount"},
        {"id": "c2", "from": "gw_amount", "to": "fork", "condition": "ctx.amount > 500000"},
        {"id": "c3", "from": "gw_amount", "to": "owner_race", "condition": "true"},
        {"id": "c4", "from": "fork", "to": "legal"},
        {"id": "c5", "from": "fork", "to": "finance"},
        {"id": "c6", "from": "fork", "to": "risk"},
        {"id": "c7", "from": "legal", "to": "join"},
        {"id": "c8", "from": "finance", "to": "join"},
        {"id": "c9", "from": "risk", "to": "join"},
        {"id": "c10", "from": "join", "to": "end_ok"},
        {"id": "c11", "from": "owner_race", "to": "end_race"},
    ]
    variables = [
        {"name": "contract_no", "type": "string", "required": True},
        {"name": "party", "type": "string", "required": True},
        {"name": "amount", "type": "amount", "required": True},
        {"name": "legal_comment", "type": "string"},
        {"name": "finance_comment", "type": "string"},
        {"name": "risk_comment", "type": "string"},
        {"name": "owner_comment", "type": "string"},
    ]
    return {"key": "contract_approval", "name": "采购合同审批", "variables": variables, "nodes": nodes, "edges": edges}


def expense_approval() -> dict:
    nodes = [
        {
            "id": "start", "type": "start", "name": "填写报销单", "position": {"x": 80, "y": 200},
            "formRef": "expense_form",
            "fieldPermissions": {
                "amount": {"access": "editable", "required": True},
                "items": {"access": "editable", "required": True},
                **_hidden("supervisor_comment", "hr_no", "director_comment", "decision"),
            },
        },
        {
            "id": "mgr", "type": "approval", "name": "主管审批", "position": {"x": 300, "y": 200},
            "assignee": {"type": "managerOf", "level": 1}, "signMode": "any", "rejectStrategy": "to_start",
            "formRef": "expense_form",
            "fieldPermissions": {
                **_ro("amount", "items"), **_editable("supervisor_comment", True),
                **_hidden("hr_no", "director_comment", "decision"),
            },
        },
        {
            "id": "hr", "type": "form", "name": "HR 备案", "position": {"x": 520, "y": 200},
            "assignee": {"type": "role", "code": "hr"},
            "formRef": "expense_form",
            "fieldPermissions": {
                **_ro("amount", "items", "supervisor_comment"), **_editable("hr_no", True),
                **_hidden("director_comment", "decision"),
            },
        },
        {
            "id": "director", "type": "approval", "name": "总监审批", "position": {"x": 740, "y": 200},
            "assignee": {"type": "managerOf", "level": 2}, "signMode": "any", "rejectStrategy": "terminate",
            "formRef": "expense_form",
            "fieldPermissions": {
                **_ro("amount", "items", "supervisor_comment", "hr_no"),
                **_editable("director_comment", True), **_editable("decision", True),
            },
        },
        {"id": "end", "type": "end", "name": "结束", "position": {"x": 960, "y": 200}},
    ]
    edges = [
        {"id": "x1", "from": "start", "to": "mgr"},
        {"id": "x2", "from": "mgr", "to": "hr"},
        {"id": "x3", "from": "hr", "to": "director"},
        {"id": "x4", "from": "director", "to": "end"},
    ]
    variables = [
        {"name": "amount", "type": "amount", "required": True},
        {"name": "items", "type": "string", "required": True},
        {"name": "supervisor_comment", "type": "string"},
        {"name": "hr_no", "type": "string"},
        {"name": "director_comment", "type": "string"},
        {"name": "decision", "type": "string"},
    ]
    return {"key": "expense_approval", "name": "费用报销审批", "variables": variables, "nodes": nodes, "edges": edges}


DEFINITIONS = [leave_approval(), contract_approval(), expense_approval()]


def seed() -> None:
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    try:
        for d in DEPTS:
            if session.get(Dept, d["id"]) is None:
                session.add(Dept(**d))
        session.flush()
        for u in USERS:
            row = session.get(User, u["id"])
            if row is None:
                session.add(User(**u, active=True))
            else:
                row.name, row.dept_id, row.manager_id, row.roles, row.token = (
                    u["name"], u["dept_id"], u["manager_id"], u["roles"], u["token"]
                )
        session.flush()

        for schema in FORMS:
            form = session.execute(select(Form).where(Form.key == schema["key"])).scalar_one_or_none()
            if form is None:
                form = Form(
                    key=schema["key"],
                    name=schema["name"],
                    category="通用",
                    draft_schema={**schema, "version": 1},
                    draft_rev=1,
                )
                session.add(form)
                session.flush()
                session.add(
                    FormVersion(
                        form_id=form.id,
                        version=1,
                        schema_json={**schema, "version": 1},
                        status="PUBLISHED",
                        published_by="u_admin",
                    )
                )
                session.flush()
                print(f"  + 表单 {schema['key']} v1")

        for snap in DEFINITIONS:
            d = session.execute(select(Definition).where(Definition.key == snap["key"])).scalar_one_or_none()
            if d is None:
                d = Definition(
                    key=snap["key"],
                    name=snap["name"],
                    category="演示",
                    description=f"种子流程：{snap['name']}",
                    draft_json=snap,
                    draft_rev=1,
                    created_by="u_designer",
                )
                session.add(d)
                session.flush()
            if d.current_version_id is None:
                v = create_version(session, d, "u_admin", publish=True)
                print(f"  + 流程 {snap['key']} v{v.version}")
            else:
                print(f"  = 流程 {snap['key']} 已存在（v{draft_version(session, d)}）")

        port = os.getenv("PORT", "8100")
        sink_url = os.getenv("PIPEWISE_SINK_URL", f"http://127.0.0.1:{port}/api/v1/dev/webhook-sink")
        if not session.execute(select(Webhook).where(Webhook.url == sink_url)).scalar_one_or_none():
            session.add(Webhook(url=sink_url, secret="demo-secret"))
            print(f"  + webhook → {sink_url}")

        session.commit()
        print("种子完成。演示账号 token 见 app/seed.py 的 USERS。")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def draft_version(session, d: Definition) -> int:
    from .models import Version

    v = session.get(Version, d.current_version_id)
    return v.version if v else 0


if __name__ == "__main__":
    seed()
