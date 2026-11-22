"""Aggregate a personal learning home from course outlines and saved evidence."""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from urllib.parse import quote

VERSION = 1
PHASES = {"not_started", "preview", "learning", "reviewing", "mastered"}


def obj(value):
    return value if isinstance(value, dict) else {}


def rows(value):
    return value if isinstance(value, list) else []


def text(value, limit=180):
    return value[:limit] if isinstance(value, str) else ""


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else 0


def zero(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0


def timestamp(value):
    try:
        date = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return date.replace(tzinfo=timezone.utc).timestamp() if date.tzinfo is None else date.timestamp()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def independent(evidence):
    item = obj(evidence)
    return (item.get("kind") == "independent_transfer" and item.get("verified") is True
            and number(item.get("attempt")) == 1 and item.get("assistanceState") == "known_none"
            and zero(item.get("hintsUsed")) and zero(item.get("chatHelpCount"))
            and item.get("answerExposed") is False
            and number(item.get("total")) > 0 and number(item.get("passed")) == number(item.get("total")))


def href(course_id, kp_id=None):
    url = "/?course=" + quote(course_id, safe="")
    return url + "&kp=" + quote(kp_id, safe="") if kp_id is not None else url


def build(payload):
    payload = obj(payload)
    now = timestamp(payload.get("now"))
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    profile = obj(payload.get("profile"))
    courses, domains = [], []
    course_ids = set()
    for item in rows(payload.get("courses")):
        item = obj(item)
        cid = text(item.get("id"), 160)
        if not cid or cid in course_ids:
            continue
        course_ids.add(cid)
        records = obj(item.get("records"))
        title = text(item.get("title"))
        course = {"id": cid, "title": title, "source": "builtin" if item.get("source") == "builtin" else "upload",
                  "learningReady": item.get("learningReady") is True,
                  "chapterCount": len(rows(item.get("chapters"))), "totalTopics": 0, "studiedTopics": 0,
                  "masteredTopics": 0, "reviewDue": 0, "independentChecks": 0,
                  "progressPercent": 0, "lastActivity": None, "href": href(cid), "nextTopic": None}
        seen_topics, seen_evidence = set(), set()
        topics, course_domains = [], []
        for index, chapter in enumerate(rows(item.get("chapters"))):
            chapter = obj(chapter)
            domain = {"id": cid + ":chapter:" + (text(chapter.get("id"), 160) or str(index)),
                      "courseId": cid, "courseTitle": title, "title": text(chapter.get("title")),
                      "totalTopics": 0, "studiedTopics": 0, "masteredTopics": 0,
                      "independentChecks": 0, "skills": []}
            for point in rows(chapter.get("knowledgePoints")):
                point = obj(point)
                kid = text(point.get("id"), 160)
                if not kid or kid in seen_topics:
                    continue
                seen_topics.add(kid)
                rec = obj(records.get(kid))
                assessment = obj(rec.get("assessment"))
                mastered = assessment.get("passed") is True and assessment.get("mode") == "review"
                phase = rec.get("phase") if rec.get("phase") in PHASES else "not_started"
                practices = [obj(e) for e in rows(rec.get("practiceEvidence")) if obj(e).get("kind") == "coding_attempt"]
                checks = []
                for evidence in rows(rec.get("transferEvidence")):
                    evidence = obj(evidence)
                    identity = text(evidence.get("id"), 180) or text(evidence.get("taskId"), 180)
                    if identity and identity not in seen_evidence and independent(evidence):
                        seen_evidence.add(identity)
                        checks.append(evidence)
                studied = mastered or phase != "not_started" or number(rec.get("quizTotal")) > 0 or bool(practices or checks)
                due_at = timestamp(obj(rec.get("review")).get("dueAt"))
                due = due_at is not None and due_at <= now
                dates = [text(rec.get("lastActivity"), 80), text(assessment.get("at"), 80)]
                dates.extend(text(e.get("at"), 80) for e in practices + checks)
                for date in dates:
                    at = timestamp(date)
                    if at is not None and (course["lastActivity"] is None or at > timestamp(course["lastActivity"])):
                        course["lastActivity"] = date
                skill = {"kpId": kid, "title": text(point.get("title")), "mastered": mastered,
                         "independentChecks": len(checks), "href": href(cid, kid)}
                domain["skills"].append(skill)
                topics.append({**skill, "due": due, "dueAt": due_at})
                for target in (course, domain):
                    target["totalTopics"] += 1
                    target["studiedTopics"] += int(studied)
                    target["masteredTopics"] += int(mastered)
                    target["independentChecks"] += len(checks)
                course["reviewDue"] += int(due)
            if domain["totalTopics"]:
                domain["status"] = "mastered" if domain["masteredTopics"] == domain["totalTopics"] else "learning" if domain["studiedTopics"] else "not_started"
                course_domains.append(domain)
        if course["totalTopics"]:
            course["progressPercent"] = math.floor(course["masteredTopics"] * 100 / course["totalTopics"] + 0.5)
        course["status"] = "completed" if course["totalTopics"] and course["masteredTopics"] == course["totalTopics"] else "learning" if course["studiedTopics"] else "not_started"
        due_topics = sorted((p for p in topics if p["due"]), key=lambda p: p["dueAt"])
        current = next((p for p in topics if p["kpId"] == item.get("currentKpId") and not p["mastered"]), None)
        next_topic = next(iter(due_topics), None) or current or next((p for p in topics if not p["mastered"]), None)
        if next_topic:
            course["nextTopic"] = {"id": next_topic["kpId"], "title": next_topic["title"], "href": next_topic["href"]}
        courses.append(course)
        domains.extend(course_domains)
    # Started courses stay easy to resume; unseen courses retain catalog order.
    courses.sort(key=lambda c: (c["status"] == "not_started", -(timestamp(c["lastActivity"]) or 0)))
    order = {c["id"]: index for index, c in enumerate(courses)}
    domains.sort(key=lambda d: order[d["courseId"]])
    summary = {"courses": len(courses), "activeCourses": sum(c["status"] == "learning" for c in courses),
               "completedCourses": sum(c["status"] == "completed" for c in courses)}
    for key in ("totalTopics", "studiedTopics", "masteredTopics", "reviewDue", "independentChecks"):
        summary[key] = sum(c[key] for c in courses)
    return {"ok": True, "version": VERSION,
            "generatedAt": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "profile": {"nickname": text(profile.get("nickname"), 20), "avatar": "edupilot"},
            "summary": summary, "courses": courses, "domains": domains}


if __name__ == "__main__":
    try:
        print(json.dumps(build(json.load(sys.stdin)), ensure_ascii=False, separators=(",", ":")))
    except (ValueError, TypeError, OverflowError):
        print(json.dumps({"ok": False, "code": "invalid_learning_home_input"}))
        sys.exit(1)
