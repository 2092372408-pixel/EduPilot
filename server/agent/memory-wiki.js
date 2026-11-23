/**
 * agent/memory-wiki.js — Compact, evidence-linked navigation over long-term learning memory.
 *
 * Wiki pages summarize and point to archival memories / verified learning events.
 * They deliberately do not duplicate raw transcripts, textbook content or mastery state.
 */
const store = require('../store/memoryStore');
const courseRegistry = require('../kb/course-registry');
const { findKnowledgePoint } = require('../data/course');

function conceptTitle(courseId, kpId) {
  const builtin = findKnowledgePoint(kpId);
  if (builtin?.kp?.title) return builtin.kp.title;
  try {
    if (courseId && courseRegistry.isDynamicCourseId(courseId)) {
      const course = courseRegistry.getDynamicCourse(courseId);
      for (const chapter of courseRegistry.dynamicCourseView(course).chapters || []) {
        const point = (chapter.knowledgePoints || []).find(item => item.id === kpId);
        if (point) return point.title;
      }
    }
  } catch (_) { /* keep the stable concept id as fallback */ }
  return kpId;
}

function memoryView(memory) {
  return {
    id: memory.id,
    type: memory.type,
    text: memory.text,
    confidence: memory.confidence,
    status: memory.status,
    version: memory.version,
  };
}

function sync(sessionId) {
  const { uid, courseId: activeCourseId } = store.scopeOf(sessionId);
  const memories = store.listUserArchival(sessionId);
  const events = store.listUserLearningEvents(sessionId);
  const courseIds = new Set([activeCourseId].filter(Boolean));
  for (const memory of memories) {
    if (memory.storageScope && memory.storageScope.startsWith(uid + '@')) {
      const course = store.scopeOf(memory.storageScope).courseId;
      if (course) courseIds.add(course);
    }
  }
  for (const event of events) if (event.courseId) courseIds.add(event.courseId);

  const profileFacts = memories.filter(memory =>
    memory.storageScope === uid && ['preference', 'goal'].includes(memory.type));
  const profilePageId = `wiki:${uid}:learner`;
  const profileSections = {
    preferences: profileFacts.filter(memory => memory.type === 'preference').map(memoryView),
    goals: profileFacts.filter(memory => memory.type === 'goal').map(memoryView),
  };
  const profileResult = store.upsertWikiPage({
    id: profilePageId, uid, scope: uid, pageType: 'learner',
    title: 'Learner profile',
    summary: profileFacts.length
      ? `Long-term profile index with ${profileSections.preferences.length} preferences and ${profileSections.goals.length} goals.`
      : 'No long-term profile facts have been consolidated yet.',
    sections: profileSections,
    sourceMemoryIds: profileFacts.map(memory => memory.id),
    sourceEventIds: [],
  });

  const links = [];
  const pages = [profileResult].filter(Boolean);
  for (const cid of courseIds) {
    const scope = `${uid}@${cid}`;
    const courseFacts = memories.filter(memory => memory.storageScope === scope);
    const courseEvents = events.filter(event => event.courseId === cid);
    const runs = store.listDreamingRuns(scope, 3);
    const incorrect = courseEvents.filter(event => event.type === 'answer_incorrect').length;
    const correct = courseEvents.filter(event => event.type === 'answer_correct').length;
    const coursePageId = `wiki:${uid}:course:${cid}`;
    const courseSections = {
      memories: courseFacts.map(memoryView),
      recentReflections: runs.map(run => ({
        fromEventId: run.fromEventId,
        toEventId: run.toEventId,
        summary: String(run.reflection.summary || '').slice(0, 400),
        patterns: Array.isArray(run.reflection.patterns) ? run.reflection.patterns.slice(0, 6) : [],
        at: run.at,
      })),
      activity: {
        verifiedAnswerEvents: courseEvents.length,
        correct,
        incorrect,
        knowledgePointCount: new Set(courseEvents.map(event => event.kpId).filter(Boolean)).size,
      },
    };
    const courseResult = store.upsertWikiPage({
      id: coursePageId, uid, scope, courseId: cid, pageType: 'course',
      entityId: cid,
      title: `Course · ${cid}`,
      summary: `Course memory index: ${courseEvents.length} verified answer events, ${courseFacts.length} active memories, ${runs.length} recent reflections.`,
      sections: courseSections,
      sourceMemoryIds: courseFacts.map(memory => memory.id),
      sourceEventIds: courseEvents.map(event => event.id),
    });
    if (courseResult) pages.push(courseResult);
    links.push({
      scope, sourcePageId: profilePageId, targetPageId: coursePageId,
      relation: 'studies', confidence: 1,
      evidence: [...courseFacts.map(memory => memory.id), ...courseEvents.slice(-20).map(event => event.id)],
    });

    const byConcept = new Map();
    for (const event of courseEvents) {
      if (!event.kpId) continue;
      if (!byConcept.has(event.kpId)) byConcept.set(event.kpId, []);
      byConcept.get(event.kpId).push(event);
    }
    for (const [kpId, conceptEvents] of byConcept) {
      const conceptEventIds = new Set(conceptEvents.map(event => event.id));
      const conceptMemories = courseFacts.filter(memory => {
        const ids = memory.provenance?.eventIds;
        return Array.isArray(ids) && ids.some(id => conceptEventIds.has(id));
      });
      const conceptCorrect = conceptEvents.filter(event => event.type === 'answer_correct').length;
      const conceptIncorrect = conceptEvents.filter(event => event.type === 'answer_incorrect').length;
      const conceptPageId = `wiki:${uid}:course:${cid}:concept:${kpId}`;
      const recentEvents = conceptEvents.slice(-8).map(event => ({
        eventId: event.id,
        sessionId: event.sessionId,
        turn: event.turn,
        outcome: event.type,
        question: String(event.payload.question || '').slice(0, 180),
        at: event.at,
      }));
      const conceptResult = store.upsertWikiPage({
        id: conceptPageId, uid, scope, courseId: cid, pageType: 'concept',
        entityId: kpId,
        title: conceptTitle(cid, kpId),
        summary: `Verified practice history: ${conceptCorrect} correct and ${conceptIncorrect} incorrect answers across ${new Set(conceptEvents.map(event => event.sessionId)).size} sessions.`,
        sections: {
          evidence: { correct: conceptCorrect, incorrect: conceptIncorrect, total: conceptEvents.length },
          recentEvents,
          relatedMemories: conceptMemories.map(memoryView),
        },
        sourceMemoryIds: conceptMemories.map(memory => memory.id),
        sourceEventIds: conceptEvents.slice(-30).map(event => event.id),
      });
      if (conceptResult) pages.push(conceptResult);
      links.push({
        scope, sourcePageId: coursePageId, targetPageId: conceptPageId,
        relation: 'contains', confidence: 1,
        evidence: conceptEvents.slice(-30).map(event => event.id),
      });
    }
  }

  store.replaceWikiLinks(uid, links);
  return {
    pagesChanged: pages.filter(page => page.changed).length,
    pageCount: store.listWiki(sessionId).pages.length,
    linkCount: links.length,
  };
}

module.exports = { sync, conceptTitle };
