"""Personal course graph and study suggestions. JSON in / JSON out, no dependencies.

Course structure and review evidence are the authority. Similar titles are only
candidate associations; they never merge concepts or establish prerequisites.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import quote

VERSION = 1
MAX_CONCEPTS = 600
MAX_LINKS = 1000
RELATIONS = {"related", "prerequisite", "applies_to"}
PHASES = {"not_started", "preview", "learning", "reviewing", "mastered"}

# Explicit map for the bundled course. These are study-order suggestions, not
# additional completion gates. Each edge refers to content present in course.js.
PREREQUISITES = [
    ("kp1", "kp3", "条件表达式会读取变量。", "Conditions read variables."),
    ("kp2", "kp3", "比较与逻辑运算产生布尔值。", "Comparisons and logic produce Boolean values."),
    ("kp1", "kp4", "循环中需要读取和更新变量。", "Loops read and update variables."),
    ("kp3", "kp4", "while 使用条件表达式控制重复。", "A while loop uses a condition to control repetition."),
    ("kp1", "kp5", "函数参数和返回值依赖变量绑定。", "Parameters and return values use variable binding."),
    ("kp2", "kp6", "列表与字典组织不同类型的值。", "Lists and dictionaries organize typed values."),
    ("kp5", "kp7", "实例方法建立在函数定义与调用之上。", "Instance methods build on function definition and calls."),
]


def text(value, limit=500):
    return str(value or "")[:limit]


def node_id(kind, course_id, local_id=""):
    return kind + ":" + quote(course_id, safe="") + (":" + quote(local_id, safe="") if local_id else "")


def edge_id(source, target, relation):
    return "edge-" + hashlib.sha256((source + "\0" + target + "\0" + relation).encode()).hexdigest()[:24]


def date_ms(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp() * 1000
    except (ValueError, TypeError, OverflowError):
        return None


def make_edge(source, target, relation, provenance, note="", confirmed=True, **extra):
    return {"id": edge_id(source, target, relation), "source": source, "target": target,
            "relation": relation, "provenance": provenance, "note": note,
            "confirmed": confirmed, **extra}


def status_of(record, now):
    rec = record if isinstance(record, dict) else {}
    assessment = rec.get("assessment") or {}
    passed = assessment.get("passed") is True and assessment.get("mode") == "review"
    due_at = (rec.get("review") or {}).get("dueAt")
    due = date_ms(due_at)
    phase = rec.get("phase") if rec.get("phase") in PHASES else "not_started"
    history = rec.get("quizHistory") or []
    coding = [e for e in (rec.get("practiceEvidence") or []) if isinstance(e, dict) and e.get("kind") == "coding_attempt"]
    recent = sorted(history[-5:] + coding[-5:], key=lambda e: str(e.get("at") or ""))[-5:]
    failures = sum(1 for item in recent if isinstance(item, dict) and item.get("correct") is False)
    evidence = [e for e in (rec.get("transferEvidence") or [])
                if isinstance(e, dict) and e.get("verified") is True and e.get("kind") == "independent_transfer"]
    status = "review_due" if due is not None and due <= now else "review_passed" if passed else (
        "practicing" if rec.get("quizTotal", 0) or coding or evidence or phase != "not_started" else "not_started")
    return {"status": status, "phase": phase, "reviewPassed": passed,
            "reviewDueAt": text(due_at, 80) or None,
            "reviewPassedAt": text(assessment.get("at") or assessment.get("completedAt"), 80) or None,
            "quizTotal": max(0, int(rec.get("quizTotal") or 0)),
            "quizCorrect": max(0, int(rec.get("quizCorrect") or 0)),
            "codingAttempts": len(coding), "codingCorrect": sum(e.get("correct") is True for e in coding),
            "recentFailures": failures, "recentSampleSize": len(recent),
            "independentChecks": len(evidence),
            "evidenceRuleVersions": sorted({text(e.get("ruleVersion") or "legacy", 40) for e in evidence}),
            "lastActivity": text(rec.get("lastActivity"), 80) or None}


def build(payload):
    en = payload.get("lang") == "en"
    now = payload.get("now") or datetime.now(timezone.utc).timestamp() * 1000
    nodes, edges, course_rows = [], [], []
    by_id, normalized = {}, defaultdict(list)
    total_concepts = 0
    notes = {n.get("nodeId"): text(n.get("text"), 2000) for n in payload.get("notes", []) if isinstance(n, dict)}
    for item in payload.get("courses", [])[:64]:
        view = item.get("course") or {}
        cid = text(view.get("id"), 160)
        if not cid or node_id("course", cid) in by_id:
            continue
        course_node = {"id": node_id("course", cid), "kind": "course", "courseId": cid,
                       "title": text(view.get("title"), 180), "summary": text(view.get("description"), 1000)}
        nodes.append(course_node)
        by_id[course_node["id"]] = course_node
        course_row = {"id": cid, "title": course_node["title"], "concepts": 0, "includedConcepts": 0}
        course_rows.append(course_row)
        records = (item.get("learning") or {}).get("kps") or {}
        for ci, chapter in enumerate((view.get("chapters") or [])[:200]):
            chapter_key = text(chapter.get("id") or str(ci), 160)
            chapter_node = {"id": node_id("chapter", cid, chapter_key), "kind": "chapter", "courseId": cid,
                            "title": text(chapter.get("title"), 180), "parent": course_node["id"]}
            chapter_concepts = []
            for point in (chapter.get("knowledgePoints") or [])[:2000]:
                kid = text(point.get("id"), 160)
                if not kid:
                    continue
                ident = node_id("concept", cid, kid)
                if ident in by_id:
                    continue
                total_concepts += 1
                course_row["concepts"] += 1
                if sum(row["includedConcepts"] for row in course_rows) >= MAX_CONCEPTS:
                    continue
                title = text(point.get("title"), 180)
                sources = []
                for source in (point.get("sources") or [])[:8]:
                    if isinstance(source, dict):
                        sources.append({k: text(source[k], 400) for k in ("docId", "title", "chapter", "section", "page", "chunkId") if k in source})
                    elif isinstance(source, str):
                        sources.append({"title": text(source, 400)})
                node = {"id": ident, "kind": "concept", "courseId": cid, "kpId": kid,
                        "title": title, "parent": chapter_node["id"], "courseTitle": course_node["title"],
                        "chapterTitle": chapter_node["title"], "summary": text(point.get("summary"), 1200),
                        "keyPoints": [text(v, 300) for v in (point.get("keyPoints") or [])[:8]],
                        "sources": sources, "note": notes.get(ident, ""),
                        "progress": status_of(records.get(kid), now),
                        "href": "/?course=" + quote(cid, safe="") + "&kp=" + quote(kid, safe="")}
                if cid == "python-intro" and kid in {"kp3", "kp4", "kp5"}:
                    family = {"kp3": "parity", "kp4": "loop-sum", "kp5": "function-return"}[kid]
                    node["practiceHref"] = "/learning-lab.html?course=python-intro&family=" + family
                nodes.append(node)
                by_id[ident] = node
                chapter_concepts.append(node)
                course_row["includedConcepts"] += 1
                key = re.sub(r"[\W_]+", "", title.casefold())
                if len(key) >= 3:
                    normalized[key].append(node)
            if chapter_concepts:
                nodes.append(chapter_node)
                by_id[chapter_node["id"]] = chapter_node
                edges.append(make_edge(course_node["id"], chapter_node["id"], "contains", "course_outline"))
                edges.extend(make_edge(chapter_node["id"], n["id"], "contains", "course_outline") for n in chapter_concepts)

    for a, b, zh_note, en_note in PREREQUISITES:
        source, target = node_id("concept", "python-intro", a), node_id("concept", "python-intro", b)
        if source in by_id and target in by_id:
            edges.append(make_edge(source, target, "prerequisite", "curated_course_map", en_note if en else zh_note))
    user_pairs = set()
    for link in payload.get("links", [])[:MAX_LINKS]:
        a, b = link.get("source"), link.get("target")
        if a in by_id and b in by_id and by_id[a]["kind"] == by_id[b]["kind"] == "concept" and link.get("relation") in RELATIONS:
            user_pairs.add(frozenset((a, b)))
            edges.append(make_edge(a, b, link["relation"], "personal", text(link.get("note"), 500),
                                   id=text(link.get("id"), 100), editable=True))
    # Exact title matches remain suggestions, with both course identities kept.
    candidates = 0
    for group in normalized.values():
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                if a["courseId"] == b["courseId"] or frozenset((a["id"], b["id"])) in user_pairs or candidates >= 100:
                    continue
                edges.append(make_edge(a["id"], b["id"], "related", "title_match",
                    "Same title in different courses; confirm the meaning before linking." if en else "不同课程中标题相同，含义是否一致需要你确认。", False))
                candidates += 1

    prerequisites = defaultdict(list)
    for edge in edges:
        if edge["relation"] == "prerequisite" and edge["confirmed"]:
            prerequisites[edge["target"]].append(edge["source"])
    recommendations = []
    for node in nodes:
        if node["kind"] != "concept":
            continue
        progress = node["progress"]
        pending = [by_id[n] for n in prerequisites[node["id"]] if not by_id[n]["progress"]["reviewPassed"]]
        node["suggestedPrerequisites"] = [n["id"] for n in pending]
        reason, priority = None, 0
        if progress["status"] == "review_due":
            reason, priority = ("A scheduled review is due." if en else "已到记录中的复习时间。"), 100
        elif progress["recentFailures"]:
            reason, priority = ("Recent attempts include errors; revisit the evidence." if en else "最近的作答中有错误，建议结合记录再练习。"), 80
        elif progress["status"] == "practicing":
            reason, priority = ("Continue this topic; a review check has not yet passed." if en else "继续当前知识点，尚未通过复习验证。"), 50
        elif progress["status"] == "not_started" and not pending:
            reason, priority = ("A starting point with no unfinished suggested prerequisites." if en else "可以从这里开始，已知建议先学项中没有待验证项。"), 20
        if reason:
            recommendations.append({"nodeId": node["id"], "title": node["title"], "courseId": node["courseId"],
                                    "reason": reason, "priority": priority, "href": node["href"]})
    recommendations.sort(key=lambda v: -v["priority"])
    concepts = [n for n in nodes if n["kind"] == "concept"]
    return {"ok": True, "version": VERSION, "nodes": nodes, "edges": edges, "courses": course_rows,
            "recommendations": recommendations[:6],
            "summary": {"concepts": len(concepts), "totalConcepts": max(total_concepts, payload.get("totalAvailableConcepts", 0)),
                        "courses": len(course_rows), "totalCourses": max(len(course_rows), payload.get("totalAvailableCourses", 0)),
                        "reviewPassed": sum(n["progress"]["reviewPassed"] for n in concepts),
                        "reviewDue": sum(n["progress"]["status"] == "review_due" for n in concepts),
                        "personalLinks": sum(e["provenance"] == "personal" for e in edges),
                        "suggestedLinks": candidates,
                        "truncated": max(total_concepts, payload.get("totalAvailableConcepts", 0)) > len(concepts)
                            or payload.get("totalAvailableCourses", 0) > len(course_rows)},
            "notice": "Connections suggest a study route; only recorded assessments determine progress." if en else
                      "关联用于组织学习路径；学习状态来自真实作答和复习验证，连线本身不会改变成绩。"}


def validate_link(payload):
    graph = build(payload)
    nodes = {n["id"]: n for n in graph["nodes"] if n["kind"] == "concept"}
    link = payload.get("link") or {}
    source, target = link.get("source"), link.get("target")
    relation = link.get("relation")
    if source not in nodes or target not in nodes:
        return {"ok": False, "code": "unknown_concept"}
    if source == target or relation not in RELATIONS:
        return {"ok": False, "code": "invalid_relation"}
    if not isinstance(link.get("note", ""), str) or len(link.get("note", "")) > 500:
        return {"ok": False, "code": "note_too_long"}
    if relation == "prerequisite":
        adjacency = defaultdict(list)
        for edge in graph["edges"]:
            if edge["relation"] == "prerequisite" and edge["confirmed"]:
                adjacency[edge["source"]].append(edge["target"])
        stack, visited = [target], set()
        while stack:
            ident = stack.pop()
            if ident == source:
                return {"ok": False, "code": "prerequisite_cycle"}
            if ident not in visited:
                visited.add(ident)
                stack.extend(adjacency[ident])
    if relation == "related" and source > target:
        source, target = target, source
    return {"ok": True, "link": {"id": edge_id(source, target, relation), "source": source, "target": target,
             "sourceCourse": nodes[source]["courseId"], "targetCourse": nodes[target]["courseId"],
             "relation": relation, "note": link.get("note", "").strip()}}


def main():
    raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError("request_too_large")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or not isinstance(payload.get("courses", []), list):
        raise ValueError("invalid_request")
    command = payload.get("command", "build")
    if command not in {"build", "validate_link"}:
        raise ValueError("invalid_command")
    result = validate_link(payload) if command == "validate_link" else build(payload)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        print(json.dumps({"ok": False, "code": "invalid_graph_input", "error": str(error)[:200]}))
        sys.exit(1)
