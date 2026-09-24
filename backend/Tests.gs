/**
 * Tests for Code.gs. In the Apps Script editor, pick runAllTests and click Run,
 * then check the execution log.
 *
 * The tests use a built-in sample question bank and config, so they work before
 * the real bank is loaded. Flow tests write rows to Participants and Responses
 * with test emails and delete them again at the end.
 */

const TEST_BASE_TIME = Date.parse('2030-01-01T10:00:00Z');

const TEST_CONFIG = {
  START_AT: '2030-01-01T00:00:00Z',
  END_AT: '2030-01-03T00:00:00Z',
  TIME_LIMIT: '30',
  STAR_TIME_LIMIT: '60',
  GRACE_SECONDS: '5',
  FINISH_GRACE_MINUTES: '10',
  PICK_EASY: '4',
  PICK_MEDIUM: '3',
  PICK_HARD: '3',
  SHOW_SCORE: 'TRUE',
  RESULTS_MESSAGE: 'Test results message',
};

function testQuestionBank_() {
  const rows = [];
  [['easy', 5], ['medium', 4], ['hard', 4]].forEach(([d, n]) => {
    for (let i = 1; i <= n; i++) {
      const id = 'T_' + d.charAt(0).toUpperCase() + i;
      if (i % 2) {
        rows.push({ id, type: 'mcq', difficulty: d, text: d + ' mcq ' + i, options: 'Alpha|Beta|Gamma|Delta', answer: 'Beta', accepted: '', active: true });
      } else {
        rows.push({ id, type: 'text', difficulty: d, text: d + ' text ' + i, options: '', answer: '', accepted: 'Merge|merge node', active: true });
      }
    }
  });
  rows.push({ id: 'T_OFF', type: 'mcq', difficulty: 'easy', text: 'inactive', options: 'A|B', answer: 'A', accepted: '', active: false });
  ['S1', 'S2', 'S3'].forEach((id) => {
    rows.push({ id: 'T_' + id, type: 'text', difficulty: 'star', text: 'Star question ' + id, options: '', answer: '', accepted: '', active: 'TRUE' });
  });
  return rows;
}

function correctAnswerFor_(questionId) {
  const q = getQuestions_().byId[questionId];
  if (isStar_(q)) return 'A thoughtful answer.';
  return q.type === 'mcq' ? q.answer : q.accepted[0];
}

function runAllTests() {
  const results = [];
  const createdSessions = [];
  const createdEmails = [];

  CONFIG_OVERRIDE = TEST_CONFIG;
  QUESTIONS_OVERRIDE = testQuestionBank_();
  NOW_OVERRIDE = TEST_BASE_TIME;

  const test = (name, fn) => {
    try {
      fn();
      results.push('PASS  ' + name);
    } catch (err) {
      results.push('FAIL  ' + name + ': ' + (err && err.message ? err.message : err));
    }
  };
  const call = (body) => handleRequest_(JSON.stringify(body));
  const newEmail = () => {
    const e = 'quiz-test-' + Utilities.getUuid().slice(0, 8) + '@example.com';
    createdEmails.push(e);
    return e;
  };
  const start = (overrides) => {
    const res = call(Object.assign({ action: 'start', name: 'Test User', email: newEmail(), consent: true, hp: '' }, overrides || {}));
    if (res.sessionId) createdSessions.push(res.sessionId);
    return res;
  };
  const answer = (sessionId, questionId, text, timedOut) =>
    call({ action: 'answer', sessionId, questionId, answer: text, timedOut: !!timedOut });
  // Answers every scored question correctly (3 s each), then returns the response showing the star question.
  const runToStar = (s) => {
    let res = s;
    while (!res.done && !res.question.star) {
      NOW_OVERRIDE += 3000;
      res = answer(s.sessionId, res.question.id, correctAnswerFor_(res.question.id));
    }
    return res;
  };

  try {
    /* Pure functions */

    test('normalizeText_ lowercases, strips punctuation and collapses spaces', () => {
      assertEq_(normalizeText_('  Merge   Node! '), 'merge node');
      assertEq_(normalizeText_('WEBHOOK_URL'), 'webhookurl');
      assertEq_(normalizeText_(null), '');
    });

    test('scoreAnswer_ checks MCQ options and accepted text answers', () => {
      const bank = getQuestions_();
      assertEq_(scoreAnswer_(bank.byId.T_E1, 'Beta'), true);
      assertEq_(scoreAnswer_(bank.byId.T_E1, 'beta'), false);
      assertEq_(scoreAnswer_(bank.byId.T_E2, ' MERGE node. '), true);
      assertEq_(scoreAnswer_(bank.byId.T_E2, 'switch'), false);
      assertEq_(scoreAnswer_(bank.byId.T_E2, ''), false);
    });

    test('safeCell_ neutralises formulas', () => {
      assertEq_(safeCell_('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")");
      assertEq_(safeCell_('+1'), "'+1");
      assertEq_(safeCell_('Asha'), 'Asha');
    });

    test('inactive questions are never picked but can still be looked up', () => {
      const bank = getQuestions_();
      assertEq_(bank.list.some((q) => q.id === 'T_OFF'), false);
      assertEq_(!!bank.byId.T_OFF, true);
    });

    test('pickQuestionIds_ draws 4/3/3 scored questions and one random star question last', () => {
      const bank = getQuestions_();
      const starsSeen = new Set();
      for (let n = 0; n < 40; n++) {
        const ids = pickQuestionIds_(bank, getConfig_());
        assertEq_(ids.length, 11);
        assertEq_(new Set(ids).size, 11);
        assertEq_(isStar_(bank.byId[ids[10]]), true, 'last question is a star question');
        assertEq_(ids.slice(0, 10).some((id) => isStar_(bank.byId[id])), false, 'only one star question');
        [['easy', 4], ['medium', 3], ['hard', 3]].forEach(([d, n2]) => {
          assertEq_(ids.filter((id) => bank.byId[id].difficulty === d).length, n2);
        });
        starsSeen.add(ids[10]);
      }
      assertEq_(starsSeen.size > 1, true, 'star question varies between participants');
    });

    /* Validation */

    test('start rejects honeypot, missing consent, bad email and short name', () => {
      assertEq_(start({ hp: 'bot' }).error, 'INVALID_INPUT');
      assertEq_(start({ consent: false }).error, 'INVALID_INPUT');
      assertEq_(start({ email: 'not-an-email' }).error, 'INVALID_INPUT');
      assertEq_(start({ name: 'A' }).error, 'INVALID_INPUT');
      assertEq_(call({ action: 'nope' }).error, 'INVALID_INPUT');
      assertEq_(handleRequest_('not json').error, 'INVALID_INPUT');
    });

    test('status reports the quiz window', () => {
      assertEq_(call({ action: 'status' }).state, 'open');
      NOW_OVERRIDE = Date.parse('2029-12-31T00:00:00Z');
      assertEq_(call({ action: 'status' }).state, 'not_open');
      NOW_OVERRIDE = Date.parse('2030-01-04T00:00:00Z');
      assertEq_(call({ action: 'status' }).state, 'closed');
      NOW_OVERRIDE = TEST_BASE_TIME;
    });

    test('start is refused outside the window', () => {
      NOW_OVERRIDE = Date.parse('2029-12-31T00:00:00Z');
      assertEq_(start().error, 'QUIZ_NOT_OPEN');
      NOW_OVERRIDE = Date.parse('2030-01-04T00:00:00Z');
      assertEq_(start().error, 'QUIZ_CLOSED');
      NOW_OVERRIDE = TEST_BASE_TIME;
    });

    /* Full flow */

    test('full run: 11 questions, answers never sent, score 10 plus a star', () => {
      const s = start({ name: '=cmd|" /C calc"!A0' });
      assertEq_(s.ok, true);
      assertEq_(s.index, 1);
      assertEq_(s.total, 11);
      let res = s;
      let steps = 0;
      while (!res.done) {
        assertNoAnswerLeak_(res);
        if (res.index === 11) {
          assertEq_(res.question.star, true);
          assertEq_(res.question.type, 'text');
          assertEq_(res.timeLimit, 60);
        } else {
          assertEq_('star' in res.question, false);
          assertEq_(res.timeLimit, 30);
        }
        NOW_OVERRIDE += 3000;
        res = answer(s.sessionId, res.question.id, correctAnswerFor_(res.question.id));
        assertEq_(res.ok, true, JSON.stringify(res));
        if (++steps > 12) throw new Error('Quiz did not finish');
      }
      assertEq_(steps, 11);
      assertEq_(res.score, 10);
      assertEq_(res.maxScore, 10);
      assertEq_(res.star, true);
      assertEq_(res.message, 'Test results message');

      const session = loadSession_(s.sessionId, true);
      assertEq_(session.status, 'done');
      assertEq_(session.star, true);
      assertEq_(session.totalTimeSec, 30, 'star question time is not counted');
      const pRow = sheet_(SHEETS.PARTICIPANTS).getRange(session.row, 1, 1, PARTICIPANT_HEADERS.length).getValues()[0];
      assertEq_(String(pRow[P_COL.name - 1]).charAt(0), '=', 'name should be stored as text, not a formula');
      assertEq_(pRow[P_COL.star - 1], true);

      const responses = sheet_(SHEETS.RESPONSES);
      const rows = responses.getRange(2, 1, responses.getLastRow() - 1, RESPONSE_HEADERS.length).getValues()
        .filter((r) => r[1] === s.sessionId);
      assertEq_(rows.length, 11);
      assertEq_(rows.filter((r) => r[9] === 'scored').length, 10);
      const starRow = rows.filter((r) => r[9] === 'star')[0];
      assertEq_(starRow[6], 0, 'star row carries no automatic points');
      assertEq_(starRow[10], '', 'reviewPoints is left for the quizmaster');
    });

    test('an empty star answer earns no star', () => {
      const s = start();
      const res = runToStar(s);
      const done = answer(s.sessionId, res.question.id, '   ');
      assertEq_(done.done, true);
      assertEq_(done.score, 10);
      assertEq_(done.star, false);
      NOW_OVERRIDE = TEST_BASE_TIME;
    });

    test('star text sent when the timer runs out still earns the star; a late one does not', () => {
      const s1 = start();
      const r1 = runToStar(s1);
      NOW_OVERRIDE += 60000;
      assertEq_(answer(s1.sessionId, r1.question.id, 'half an answer', true).star, true);

      const s2 = start();
      const r2 = runToStar(s2);
      NOW_OVERRIDE += 70000; // 70 s > 60 s + 5 s grace
      assertEq_(answer(s2.sessionId, r2.question.id, 'too late', false).star, false);
      NOW_OVERRIDE = TEST_BASE_TIME;
    });

    test('setup adds the review formulas, the 0-5 check and the private Leaderboard', () => {
      assertEq_(sheet_(SHEETS.RESPONSES).getRange(1, RESPONSE_HEADERS.length + 1).getFormula(), RESPONSES_FINAL_POINTS_FORMULA);
      assertEq_(sheet_(SHEETS.PARTICIPANTS).getRange(1, PARTICIPANT_HEADERS.length + 1).getFormula(), PARTICIPANTS_FINAL_SCORE_FORMULA);
      assertEq_(RESPONSE_HEADERS[RESPONSE_HEADERS.length - 1], 'reviewPoints');
      const leaderboard = sheet_(SHEETS.LEADERBOARD).getRange('A1').getFormula();
      assertEq_(/order by N desc/.test(leaderboard), true, 'Leaderboard sorts by finalScore');
    });

    test('duplicate email is refused, ignoring case', () => {
      const email = newEmail();
      assertEq_(start({ email }).ok, true);
      assertEq_(start({ email: email.toUpperCase() }).error, 'ALREADY_ATTEMPTED');
    });

    test('timeouts and late answers score 0; the timer cannot be reset', () => {
      const s = start();
      let res = answer(s.sessionId, s.question.id, correctAnswerFor_(s.question.id), true);
      assertEq_(res.index, 2);
      NOW_OVERRIDE += 36000; // 36 s > 30 s limit + 5 s grace
      res = answer(s.sessionId, res.question.id, correctAnswerFor_(res.question.id), false);
      assertEq_(res.index, 3);
      assertEq_(loadSession_(s.sessionId, true).score, 0);

      NOW_OVERRIDE += 20000;
      const resumed = call({ action: 'resume', sessionId: s.sessionId });
      assertEq_(resumed.index, 3);
      assertEq_(resumed.remaining, 10);
      assertNoAnswerLeak_(resumed);
      NOW_OVERRIDE = TEST_BASE_TIME;
    });

    test('a retried answer is not double-counted', () => {
      const s = start();
      const r1 = answer(s.sessionId, s.question.id, correctAnswerFor_(s.question.id));
      const r2 = answer(s.sessionId, s.question.id, correctAnswerFor_(s.question.id));
      assertEq_(r1.index, 2);
      assertEq_(r2.index, 2);
      assertEq_(r2.question.id, r1.question.id);
      assertEq_(loadSession_(s.sessionId, true).score, 1);
    });

    test('unknown session and out-of-order question are rejected', () => {
      assertEq_(call({ action: 'resume', sessionId: 'no-such-session' }).error, 'INVALID_SESSION');
      assertEq_(answer('no-such-session', 'T_E1', 'Beta').error, 'INVALID_SESSION');
      const s = start();
      const other = getQuestions_().list.map((q) => q.id).filter((id) => id !== s.question.id)[0];
      assertEq_(answer(s.sessionId, other, 'x').error, 'INVALID_INPUT');
    });

    test('answers are refused after END_AT plus the finishing grace', () => {
      const s = start();
      NOW_OVERRIDE = Date.parse('2030-01-03T00:20:00Z');
      assertEq_(call({ action: 'resume', sessionId: s.sessionId }).error, 'QUIZ_CLOSED');
      NOW_OVERRIDE = TEST_BASE_TIME;
    });

    test('turning a question off mid-quiz does not break sessions that already have it', () => {
      const s = start();
      const current = s.question.id;
      QUESTIONS_OVERRIDE = testQuestionBank_().map((q) => (q.id === current ? Object.assign({}, q, { active: false }) : q));
      const resumed = call({ action: 'resume', sessionId: s.sessionId });
      assertEq_(resumed.ok, true, JSON.stringify(resumed));
      assertEq_(resumed.question.id, current);
      assertEq_(answer(s.sessionId, current, 'x').ok, true);
      QUESTIONS_OVERRIDE = testQuestionBank_();
    });

    test('SHOW_SCORE FALSE hides the score and the star', () => {
      CONFIG_OVERRIDE = Object.assign({}, TEST_CONFIG, { SHOW_SCORE: 'FALSE' });
      const s = start();
      let res = s;
      while (!res.done) res = answer(s.sessionId, res.question.id, 'x', true);
      assertEq_('score' in res, false);
      assertEq_('star' in res, false);
      CONFIG_OVERRIDE = TEST_CONFIG;
    });
  } finally {
    cleanupTestData_(createdSessions, createdEmails);
    CONFIG_OVERRIDE = null;
    QUESTIONS_OVERRIDE = null;
    NOW_OVERRIDE = null;
  }

  const failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
  results.forEach((r) => console.log(r));
  console.log(failed === 0 ? 'ALL ' + results.length + ' TESTS PASSED' : failed + ' OF ' + results.length + ' TESTS FAILED');
  return failed;
}

function assertNoAnswerLeak_(res) {
  const text = JSON.stringify(res);
  if (/"answer"|"accepted"/.test(text)) throw new Error('Response leaks answer data: ' + text);
}

function assertEq_(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

/** Deletes rows created by the tests, bottom-up so row numbers stay valid. */
function cleanupTestData_(sessionIds, emails) {
  const ids = new Set(sessionIds);
  [SHEETS.RESPONSES, SHEETS.PARTICIPANTS].forEach((name) => {
    const sheet = sheet_(name);
    if (sheet.getLastRow() < 2) return;
    const col = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
    for (let i = col.length - 1; i >= 0; i--) {
      if (ids.has(col[i][0])) sheet.deleteRow(i + 2);
    }
  });
  const cache = CacheService.getScriptCache();
  cache.removeAll(sessionIds.map((id) => 's:' + id).concat(emails.map((e) => 'e:' + e.toLowerCase())));
}
