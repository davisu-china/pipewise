"""HTTP 接口层：鉴权、权限、幂等、发布校验、试跑。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client(prepare_db):
    with TestClient(app) as c:
        yield c


def h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_requires_auth(client):
    assert client.get("/api/v1/definitions").status_code == 401
    assert client.get("/api/v1/definitions", headers=h("bad-token")).status_code == 401


def test_me_and_users(client):
    me = client.get("/api/v1/me", headers=h("tok_zhangsan")).json()
    assert me["id"] == "u_zhangsan" and me["roles"] == ["user"]
    users = client.get("/api/v1/users", headers=h("tok_zhangsan")).json()["items"]
    assert len(users) >= 9


def test_instance_flow_and_permissions(client):
    bk = f"API-{uuid.uuid4().hex[:8]}"
    r = client.post(
        "/api/v1/instances",
        headers={**h("tok_zhangsan"), "Idempotency-Key": bk},
        json={"key": "leave_approval", "businessKey": bk, "title": "API 测试",
              "variables": {"leave_days": 1, "leave_reason": "x"}},
    )
    assert r.status_code == 200, r.text
    inst = r.json()

    # 同一幂等键 → 回放同一响应
    r2 = client.post(
        "/api/v1/instances",
        headers={**h("tok_zhangsan"), "Idempotency-Key": bk},
        json={"key": "leave_approval", "businessKey": bk, "variables": {"leave_days": 1, "leave_reason": "x"}},
    )
    assert r2.json()["id"] == inst["id"]

    # 无关用户看不到实例
    assert client.get(f"/api/v1/instances/{inst['id']}", headers=h("tok_zhouqiang")).status_code == 403
    # 管理员能看
    assert client.get(f"/api/v1/instances/{inst['id']}", headers=h("tok_admin")).status_code == 200

    tasks = client.get("/api/v1/tasks?assignee=me&status=pending", headers=h("tok_lisi")).json()["items"]
    task = [t for t in tasks if t["instanceId"] == inst["id"]][0]
    # 别人不能提交
    r = client.post(f"/api/v1/tasks/{task['id']}/submit-form", headers=h("tok_wangfang"),
                    json={"verdict": "approve", "data": {"mgr_comment": "x"}})
    assert r.status_code == 403

    form = client.get(f"/api/v1/tasks/{task['id']}/form", headers=h("tok_lisi")).json()["form"]
    assert [f["name"] for f in form["fields"]] == ["leave_days", "leave_reason", "mgr_comment"]

    r = client.post(f"/api/v1/tasks/{task['id']}/submit-form", headers=h("tok_lisi"),
                    json={"verdict": "approve", "data": {"mgr_comment": "同意"}})
    assert r.status_code == 200, r.text
    # 双击：第二次 409
    r = client.post(f"/api/v1/tasks/{task['id']}/submit-form", headers=h("tok_lisi"),
                    json={"verdict": "approve", "data": {"mgr_comment": "再点一次"}})
    assert r.status_code == 409 and r.json()["error"]["code"] in ("TASK_ALREADY_DONE", "INSTANCE_NOT_RUNNING")


def test_snapshot_is_immutable_for_instances(client):
    """发布新版本不影响已跑实例（实例钉版本）。"""
    d = client.get("/api/v1/definitions/leave_approval", headers=h("tok_designer")).json()
    assert d["draftRev"] >= 1
    # 设计者不能直接发布
    assert client.post("/api/v1/definitions/leave_approval/publish", headers=h("tok_designer")).status_code == 403


def test_save_draft_validation_and_publish(client):
    key = f"api_flow_{uuid.uuid4().hex[:6]}"
    r = client.post("/api/v1/definitions", headers=h("tok_designer"),
                    json={"key": key, "name": "API 新建流程"})
    assert r.status_code == 200, r.text

    bad = {
        "key": key, "name": "坏图",
        "nodes": [{"id": "start", "type": "start"}],
        "edges": [],
    }
    r = client.put(f"/api/v1/definitions/{key}/draft", headers=h("tok_designer"), json={"snapshot": bad})
    assert r.status_code == 200
    issues = r.json()["issues"]
    assert any(i["level"] == "error" for i in issues)
    # 有 error 时发布必须被拒
    r = client.post(f"/api/v1/definitions/{key}/publish", headers=h("tok_admin"))
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_FAILED"

    good = {
        "key": key, "name": "好图", "variables": [],
        "nodes": [{"id": "start", "type": "start"}, {"id": "end", "type": "end"}],
        "edges": [{"id": "e1", "from": "start", "to": "end"}],
    }
    r = client.put(f"/api/v1/definitions/{key}/draft", headers=h("tok_designer"), json={"snapshot": good})
    assert not [i for i in r.json()["issues"] if i["level"] == "error"]
    r = client.post(f"/api/v1/definitions/{key}/publish", headers=h("tok_admin"))
    assert r.status_code == 200 and r.json()["status"] == "PUBLISHED"

    # 可以起了
    bk = f"API2-{uuid.uuid4().hex[:8]}"
    r = client.post("/api/v1/instances", headers=h("tok_zhangsan"),
                    json={"key": key, "businessKey": bk, "variables": {}})
    assert r.status_code == 200 and r.json()["status"] == "COMPLETED"


def test_dry_run_rolls_back(client):
    r = client.post("/api/v1/definitions/leave_approval/dry-run", headers=h("tok_designer"),
                    json={"variables": {"leave_days": 3, "leave_reason": "试跑"}})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["finished"] is True and out["steps"] >= 3
    names = [t["nodeName"] for t in out["trace"]]
    assert names[0] == "发起申请" and names[-1] == "结束"
    # 试跑不落库
    items = client.get("/api/v1/instances?definitionKey=leave_approval",
                       headers=h("tok_admin")).json()["items"]
    assert all("试跑" not in (i.get("title") or "") for i in items)


def test_forms_list_and_matrix(client):
    forms = client.get("/api/v1/forms", headers=h("tok_designer")).json()["items"]
    expense = [f for f in forms if f["key"] == "expense_form"][0]
    assert expense["published"]["version"] == 1
    assert {f["name"] for f in expense["published"]["schema"]["fields"]} >= {"amount", "hr_no", "decision"}
