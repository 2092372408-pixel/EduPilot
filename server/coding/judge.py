"""Trusted teaching harness. Static precheck remains mandatory; not an OS sandbox.

Only the server supplies spec/legacy checks. Student output is captured
separately, so printing a protocol-looking line can never award a pass.
"""
import ast
import json
import math
import sys

IS_FINITE = math.isfinite
SET_TRACE, GET_TRACE = sys.settrace, sys.gettrace


def encode_plain(value):
    """Serialize only trusted/plain values without mutable imported JSON globals.

    Student code may legitimately import json and reassign its attributes. Using
    that shared module after execution would let it forge the result packet.
    """
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) in (int, float):
        if type(value) is float and not IS_FINITE(value):
            return "null"
        return str(value)
    if type(value) is str:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return '"' + "".join("\\u%04x" % ord(char) if ord(char) < 32 else char for char in escaped) + '"'
    if type(value) is list:
        return "[" + ",".join(encode_plain(item) for item in value) + "]"
    if type(value) is dict:
        return "{" + ",".join(encode_plain(str(key)) + ":" + encode_plain(item) for key, item in value.items()) + "}"
    raise TypeError("Result packet contains a non-plain value")


class LimitedOutput:
    encoding = "utf-8"

    def __init__(self, limit=2000):
        self.text = ""
        self.limit = limit

    def write(self, value):
        self.text += str(value)[:max(0, self.limit - len(self.text))]
        return len(value)

    def flush(self):
        pass


def safe_value(value, depth=0):
    """Bound plain values without calling a student's __repr__ method."""
    kind = type(value)
    if value is None or kind in (bool, int):
        return value
    if kind is float:
        return value if IS_FINITE(value) else "<non-finite number>"
    if kind is str:
        return value[:180]
    if depth < 2 and kind in (list, tuple):
        return [safe_value(item, depth + 1) for item in value[:10]]
    if depth < 2 and kind is dict:
        return {str(key)[:40]: safe_value(item, depth + 1)
                for key, item in list(value.items())[:10] if type(key) in (str, int)}
    return "<non-scalar value>"


def scoped_nodes(tree, function=None):
    """Ignore unrelated/nested bodies when checking required constructs."""
    if function:
        roots = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == function]
        if not roots:
            return []
        pending = list(roots[0].body)
    else:
        pending = list(tree.body)
    result = []
    while pending:
        node = pending.pop()
        result.append(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        pending.extend(ast.iter_child_nodes(node))
    return result


def expression_origins(node, env):
    """Small, conservative data flow for the explicitly taught accumulator form."""
    if node is None:
        return set()
    if isinstance(node, ast.Name):
        return set(env.get(node.id, {"var:" + node.id}))
    if isinstance(node, (ast.Lambda, ast.FunctionDef, ast.ClassDef)):
        return set()
    origins = set()
    for child in ast.iter_child_nodes(node):
        origins.update(expression_origins(child, env))
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
        origins.update("add:" + item[5:] for item in list(origins) if item.startswith("loop:"))
    return origins


def accumulation_plan(tree, rule):
    """Recognise ordinary += / x=x+term forms, aliases and final scaling.

    This is a bounded teaching rule, not a proof of arbitrary Python semantics.
    Runtime traces also require the relevant loop and update to execute.
    """
    function = rule.get("function")
    roots = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == function] if function else []
    body = roots[0].body if roots else ([] if function else tree.body)
    loops = sorted((node for node in scoped_nodes(tree, function) if isinstance(node, ast.For)),
                   key=lambda node: (node.lineno, node.col_offset))
    loop_ids = {id(node): str(index) for index, node in enumerate(loops)}
    updates = {key: [] for key in loop_ids.values()}
    returned = []

    def merge(*environments):
        return {key: set().union(*(env.get(key, set()) for env in environments))
                for key in set().union(*(set(env) for env in environments))}

    def assign(target, origins, statement, env, active):
        if isinstance(target, ast.Name):
            origins = set(origins)
            for key in active:
                if {"var:" + target.id, "loop:" + key, "add:" + key} <= origins:
                    origins.add("acc:" + key)
                    if statement not in updates[key]:
                        updates[key].append(statement)
            env[target.id] = origins | {"var:" + target.id}
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                assign(item, origins, statement, env, active)

    def block(statements, env, active):
        env = {key: set(value) for key, value in env.items()}
        for statement in statements:
            if isinstance(statement, ast.Assign):
                origins = expression_origins(statement.value, env)
                for target in statement.targets:
                    assign(target, origins, statement, env, active)
            elif isinstance(statement, ast.AnnAssign) and statement.value is not None:
                assign(statement.target, expression_origins(statement.value, env), statement, env, active)
            elif isinstance(statement, ast.AugAssign):
                origins = expression_origins(statement.target, env) | expression_origins(statement.value, env)
                if isinstance(statement.op, (ast.Add, ast.Sub)):
                    origins.update("add:" + item[5:] for item in list(origins) if item.startswith("loop:"))
                assign(statement.target, origins, statement, env, active)
            elif isinstance(statement, ast.For):
                key = loop_ids.get(id(statement))
                if key is None:
                    continue
                before = {name: set(value) for name, value in env.items()}
                body_env = {name: set(value) for name, value in env.items()}
                assign(statement.target, {"loop:" + key}, statement, body_env, [])
                env = merge(before, block(statement.body, body_env, active + [key]))
                env = block(statement.orelse, env, active)
            elif isinstance(statement, ast.If):
                env = merge(block(statement.body, env, active), block(statement.orelse, env, active))
            elif isinstance(statement, (ast.While, ast.With)):
                env = merge(env, block(statement.body, env, active))
                env = block(getattr(statement, "orelse", []), env, active)
            elif isinstance(statement, ast.Return):
                returned.append(expression_origins(statement.value, env))
                break
            elif isinstance(statement, (ast.Break, ast.Continue, ast.Raise)):
                break
        return env

    env = block(body, {}, [])
    outputs = [env.get(rule["output"], set())] if rule.get("output") else returned
    origins = set().union(*outputs) if outputs else set()
    candidates = []
    for node in loops:
        key = loop_ids[id(node)]
        if "acc:" + key in origins and updates[key]:
            candidates.append({"node": node, "key": key, "updates": updates[key]})
    return {"loops": loops, "candidates": candidates}


class TraceLoops(ast.NodeTransformer):
    """Insert traced line markers; no counter API enters the student's namespace."""
    def __init__(self, plans, first_line):
        self.line_tokens = {}
        self.next_line = first_line
        self.loops, self.updates = {}, {}
        for rule_id, plan in plans.items():
            for candidate in plan["candidates"]:
                token = rule_id + ":" + candidate["key"]
                self.loops.setdefault(id(candidate["node"]), []).append("loop:" + token)
                for update in candidate["updates"]:
                    self.updates.setdefault(id(update), []).append("update:" + token)

    def markers(self, tokens):
        result = []
        for token in tokens:
            self.next_line += 1
            self.line_tokens[self.next_line] = token
            result.append(ast.Pass(lineno=self.next_line, col_offset=0,
                                   end_lineno=self.next_line, end_col_offset=0))
        return result

    def visit_For(self, node):
        self.generic_visit(node)
        node.body = self.markers(self.loops.get(id(node), [])) + node.body
        return node

    def visit_Assign(self, node):
        self.generic_visit(node)
        return self.markers(self.updates.get(id(node), [])) + [node]

    visit_AugAssign = visit_Assign
    visit_AnnAssign = visit_Assign


def constraint_result(tree, rule, plan=None, trace_counts=None):
    nodes = scoped_nodes(tree, rule.get("function"))
    kind = rule["kind"]
    matches = []
    if kind == "require_node":
        matches = [node for node in nodes if type(node).__name__ in rule["nodes"]]
        passed = bool(matches)
    elif kind == "forbid_call":
        # The stated exercise constraint also reserves the builtin's name. A load
        # covers aliases, containers and higher-order calls without fragile alias chasing.
        matches = [node for node in ast.walk(tree) if
                   (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in rule["names"])
                   or (isinstance(node, ast.Attribute) and node.attr in rule["names"])]
        passed = not matches
    elif kind == "loop_accumulator":
        plan = plan or accumulation_plan(tree, rule)
        counts = trace_counts or {}
        iterations = sum(counts.get("loop:" + rule["id"] + ":" + item["key"], 0) for item in plan["candidates"])
        updates = sum(counts.get("update:" + rule["id"] + ":" + item["key"], 0) for item in plan["candidates"])
        return {"id": rule["id"], "desc": rule["desc"], "pass": bool(plan["candidates"] and iterations and updates),
                "evidence": {"kind": "constraint", "rule": kind,
                             "line": plan["loops"][0].lineno if plan["loops"] else None,
                             "expected": "An executed for loop updates the accumulator used by the result",
                             "actual": {"dependentLoops": len(plan["candidates"]), "iterations": iterations, "updates": updates},
                             "diagnosisId": "loop_missing" if not plan["loops"] else "constraint_violation"}}
    else:
        raise ValueError("Unknown trusted constraint kind")
    return {
        "id": rule["id"], "desc": rule["desc"], "pass": passed,
        "evidence": {"kind": "constraint", "rule": kind,
                     "line": getattr(matches[0], "lineno", None) if matches else None,
                     "expected": rule.get("nodes", rule.get("names")), "actual": bool(matches),
                     "diagnosisId": rule.get("diagnosisId", "constraint_violation")},
    }


def normalized_output(value):
    return "\n".join(line.rstrip() for line in str(value).replace("\r\n", "\n").strip().split("\n"))


def run_spec(code, spec, execute, evaluate, compile_source):
    tree = ast.parse(code)
    plans = {rule["id"]: accumulation_plan(tree, rule) for rule in spec.get("constraints", [])
             if rule["kind"] == "loop_accumulator"}
    results = [constraint_result(tree, rule, plans.get(rule["id"])) for rule in spec.get("constraints", [])]
    tracer = TraceLoops(plans, max((getattr(node, "end_lineno", 0) or 0 for node in ast.walk(tree)), default=0) + 100)
    tree = ast.fix_missing_locations(tracer.visit(tree))
    compiled = compile_source(tree, "<student>", "exec")
    all_stdout = ""
    trace_counts = {}

    def trace(frame, event, _argument):
        if event == "line" and frame.f_code.co_filename == "<student>":
            token = tracer.line_tokens.get(frame.f_lineno)
            if token:
                trace_counts[token] = trace_counts.get(token, 0) + 1
        return trace
    # Compile/inspect before executing student code; AST objects never enter its namespace.
    for case in spec.get("cases", []):
        output, errors = LimitedOutput(), LimitedOutput()
        scope = {"__name__": "__student__"}
        exception = None
        actual = None
        previous_trace = GET_TRACE()
        try:
            sys.stdout, sys.stderr = output, errors
            if plans:
                SET_TRACE(trace)
            execute(compiled, scope)
            if case.get("function"):
                function = scope.get(case["function"])
                if not callable(function):
                    exception = {"type": "MissingFunction", "message": case["function"]}
                else:
                    actual = function(*case.get("args", []))
            if not exception and "checks" in case:
                actual = all(evaluate(expression, scope) is True for expression in case["checks"])
        except BaseException as error:
            exception = {"type": type(error).__name__, "message": str(error)[:160]}
        finally:
            if plans:
                SET_TRACE(previous_trace)
        if case.get("kind") == "stdout":
            actual = normalized_output(output.text)
            expected = normalized_output(case["expected"])
        else:
            expected = case.get("expected", True)
        compatible = type(actual) is type(expected) or (type(actual) in (int, float) and type(expected) in (int, float))
        passed = not exception and compatible and actual == expected
        results.append({
            "id": case["id"], "desc": case["desc"], "pass": bool(passed),
            "evidence": {"kind": case.get("kind", "return"), "input": case.get("args", []),
                         "expected": safe_value(expected), "actual": safe_value(actual),
                         "stdout": output.text[:180], **({"exception": exception} if exception else {})},
        })
        if not all_stdout:
            all_stdout = output.text
    # Constant-return detection is evidence for a narrow diagnosis, never a pass criterion.
    constants = []
    for name in {case.get("function") for case in spec.get("cases", []) if case.get("function")}:
        returns = [node for node in scoped_nodes(tree, name) if isinstance(node, ast.Return)]
        if returns and all(isinstance(node.value, ast.Constant) for node in returns) and all(
                type(node.value.value) is type(returns[0].value.value) and node.value.value == returns[0].value.value for node in returns):
            constants.append(name)
    for index, rule in enumerate(spec.get("constraints", [])):
        if rule["kind"] == "loop_accumulator":
            results[index] = constraint_result(tree, rule, plans[rule["id"]], trace_counts)
    # A range in an unrelated helper/dummy loop is not evidence about the
    # accumulator that produced the failing result.
    ranges = [item["node"].iter for plan in plans.values() for item in plan["candidates"]
              if isinstance(item["node"].iter, ast.Call) and isinstance(item["node"].iter.func, ast.Name)
              and item["node"].iter.func.id == "range" and len(item["node"].iter.args) >= 2]
    excludes_endpoint = any(isinstance(node.args[1], ast.Name) and node.args[1].id == "n" for node in ranges)
    return {"results": results, "stdout": all_stdout[:500], "constantReturnFunctions": constants,
            "excludesEndpoint": excludes_endpoint}


def main():
    request = json.loads(sys.stdin.read())
    original_out, original_err = sys.stdout, sys.stderr
    write, error_write = original_out.write, original_err.write
    evaluate, execute, compile_source = eval, exec, compile
    if request.get("spec"):
        try:
            result = run_spec(request["code"], request["spec"], execute, evaluate, compile_source)
        except BaseException as error:
            result = {"harnessError": type(error).__name__ + ": " + str(error)[:160]}
        finally:
            sys.stdout, sys.stderr = original_out, original_err
        write("EDUPILOT_RESULT:" + encode_plain(result) + "\n")
        return 0

    # Backward-compatible boolean checks for original runner callers.
    output, errors = LimitedOutput(8000), LimitedOutput(8000)
    scope = {"__name__": "__student__"}
    try:
        sys.stdout, sys.stderr = output, errors
        execute(compile_source(request["code"], "<student>", "exec"), scope)
        checks = [evaluate(expression, scope) is True for expression in request["checks"]]
    except BaseException as error:
        sys.stdout, sys.stderr = original_out, original_err
        write("EDUPILOT_CHECKS:ERROR\n" + output.text)
        error_write(type(error).__name__ + ": " + str(error))
        return 1
    finally:
        sys.stdout, sys.stderr = original_out, original_err
    write("EDUPILOT_CHECKS:" + "".join("1" if passed else "0" for passed in checks) + "\n" + output.text)
    error_write(errors.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
