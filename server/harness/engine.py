"""Pure learning-run rules. JSON in/out; no network, model, or database access.

The JavaScript host owns I/O. Keeping policy and evidence decisions here lets
the same versioned rules be exercised independently of the model provider.
"""
import json
import math
import sys

RULE_VERSION = "learning-harness-2"
MAX_INPUT = 2_000_000


def number(value, default=0):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else default


def failure(code, reason):
    return {"ok": False, "code": code, "reason": reason, "ruleVersion": RULE_VERSION}


def authorize(data):
    action = str(data.get("action", ""))
    actor = data.get("actor", "agent")
    if actor not in {"agent", "student", "verifier", "system"}:
        return failure("actor_forbidden", "Unknown action actor.")
    if data.get("scopeId") != data.get("targetScopeId", data.get("scopeId")):
        return failure("scope_mismatch", "The action belongs to a different learning scope.")
    if data.get("generation") != data.get("currentGeneration", data.get("generation")):
        return failure("stale_generation", "This learning scope has changed.")
    if data.get("taskId") and data.get("currentTaskId") and data["taskId"] != data["currentTaskId"]:
        return failure("stale_task", "The practice task has changed.")
    if data.get("taskVersion") is not None and data.get("currentTaskVersion") is not None and data["taskVersion"] != data["currentTaskVersion"]:
        return failure("stale_task", "The practice version has changed.")
    permitted = {
        "submit": {"student"}, "submit_code": {"student"},
        "record_grade": {"verifier", "system"}, "write_evidence": {"verifier", "system"}, "update_score": {"verifier", "system"},
        "reset": {"student", "system"}, "delete_course": {"student", "system"},
    }
    if action in permitted and actor not in permitted[action]:
        return failure("actor_forbidden", "Only the trusted user or verifier route may perform this action.")
    if actor == "agent" and action in {"check_answer", "update_progress"} and data.get("diagnosticActive"):
        return failure("actor_forbidden", "Diagnostic evidence is committed by the student submission route.")
    if data.get("requiresUserIntent") and not data.get("userIntent"):
        return failure("user_intent_required", "This action requires a matching user request.")
    allowed = data.get("allowedActions")
    if isinstance(allowed, list) and action not in allowed:
        return failure("unknown_action", "This action is outside the current tool set.")
    return {"ok": True, "ruleVersion": RULE_VERSION}


def eligibility(data):
    task = data.get("task") or data
    assistance = data.get("assistance") or task.get("assistance") or {}
    result = data.get("result") or task.get("result") or {}
    attempts = task.get("attempts", [])
    attempt = data.get("attemptNumber", data.get("attempt", len(attempts) if isinstance(attempts, list) else attempts))
    state = assistance.get("state", assistance.get("status", "unknown"))
    reasons = []
    if task.get("purpose") != "transfer": reasons.append("not_transfer")
    if task.get("wasUnseen") is not True: reasons.append("previously_seen_or_unknown")
    if (task.get("validation") or {}).get("ok") is not True: reasons.append("task_not_validated")
    if number(attempt, -1) != 1: reasons.append("not_first_submission")
    if state != "known_none": reasons.append("assistance_not_known_none")
    if number(assistance.get("hintsUsed")) > 0 or assistance.get("answerExposed") or number(assistance.get("chatHelpCount")) > 0:
        reasons.append("system_assistance")
    verified = data.get("verified", result.get("verified"))
    passed = number(data.get("passed", result.get("passed")), -1)
    total = number(data.get("total", result.get("total")), 0)
    if verified is not True or total <= 0 or passed != total: reasons.append("not_verified_pass")
    if data.get("stale") or data.get("taskVersion") is not None and data.get("currentTaskVersion") is not None and data["taskVersion"] != data["currentTaskVersion"]:
        reasons.append("stale_task")
    return {"ok": True, "eligible": not reasons, "independent": not reasons, "reasons": reasons, "ruleVersion": RULE_VERSION}


def reserve_budget(data):
    budget = dict(data.get("budget") or {})
    now = number(data.get("now"))
    if now >= number(budget.get("deadline"), now):
        return failure("deadline_exceeded", "The run deadline has passed.")
    kind = data.get("kind")
    fields = {"model": ("modelCalls", "maxModelCalls"), "tool": ("toolCalls", "maxToolCalls"), "repair": ("repairs", "maxRepairAttempts")}
    if kind not in fields: return failure("invalid_budget_kind", "Unknown budget category.")
    used, limit = fields[kind]
    if number(budget.get(used)) >= number(budget.get(limit)):
        return failure("budget_exhausted", "The execution budget is exhausted.")
    reserve = max(0, int(number(data.get("reserveTokens")))) if kind == "model" else 0
    if reserve + number(budget.get("tokensUsed")) + number(budget.get("tokensReserved")) > number(budget.get("maxEstimatedTokens"), 1000000):
        return failure("budget_exhausted", "The estimated token budget is exhausted.")
    budget[used] = number(budget.get(used)) + 1
    budget["tokensReserved"] = number(budget.get("tokensReserved")) + reserve
    return {"ok": True, "budget": budget, "reservedTokens": reserve, "ruleVersion": RULE_VERSION}


def transition(data):
    previous, target = data.get("status"), data.get("target")
    allowed = {"running": {"completed", "failed", "cancelled", "interrupted", "blocked"}, "interrupted": {"cancelled"}}
    if target not in allowed.get(previous, set()):
        return failure("invalid_transition", "The run status cannot change this way.")
    return {"ok": True, "status": target, "ruleVersion": RULE_VERSION}


COMMANDS = {"authorize": authorize, "eligibility": eligibility, "reserve_budget": reserve_budget, "transition": transition}


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT: raise ValueError("request_too_large")
    request = json.loads(raw)
    command = request.get("command")
    if command not in COMMANDS: raise ValueError("unknown_command")
    data = request.get("payload", {})
    if not isinstance(data, dict): raise ValueError("invalid_payload")
    print(json.dumps(COMMANDS[command](data), ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError) as exc:
        print(json.dumps(failure("invalid_request", str(exc)[:120])))
        sys.exit(1)
