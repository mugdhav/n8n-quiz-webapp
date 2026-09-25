/** @OnlyCurrentDoc */

/**
 * n8n Rapid-Fire Quiz: Google Apps Script backend.
 *
 * Deploy as a web app (Execute as: Me, Who has access: Anyone).
 * All requests are POST with a JSON body and Content-Type: text/plain.
 * See PLAN.md section 3 for the API contract.
 *
 * The answer key, question selection, timing and scoring stay on the server.
 * The browser only ever receives the current question, without its answer.
 */

const SHEETS = {
  CONFIG: 'Config',
  QUESTIONS: 'Questions',
  PARTICIPANTS: 'Participants',
  RESPONSES: 'Responses',
  LEADERBOARD: 'Leaderboard',
  SUMMARY: 'Summary',
};

const QUESTION_HEADERS = ['id', 'type', 'difficulty', 'text', 'options', 'answer', 'accepted', 'active'];
const PARTICIPANT_HEADERS = ['createdAt', 'sessionId', 'name', 'email', 'emailNorm', 'questionIds',
  'currentIndex', 'servedAt', 'status', 'score', 'totalTimeSec', 'finishedAt', 'star'];
// kind is 'scored' or 'star'. The code writes up to kind; the quizmaster types 0-5
// into reviewPoints on star rows.
const RESPONSE_HEADERS = ['timestamp', 'sessionId', 'email', 'index', 'questionId', 'answer',
  'correct', 'timeTakenSec', 'late', 'kind', 'reviewPoints'];

// 1-based column numbers in Participants.
const P_COL = PARTICIPANT_HEADERS.reduce((acc, h, i) => { acc[h] = i + 1; return acc; }, {});

// Formula columns to the right of the written data. They fill themselves in for every row.
// finalPoints: on a star row, the quizmaster's reviewPoints (0 until reviewed); otherwise the 1/0 correct value.
const RESPONSES_FINAL_POINTS_FORMULA =
  '={"finalPoints"; ARRAYFORMULA(IF(A2:A = "", , IF(J2:J = "star", IF(K2:K = "", 0, K2:K), G2:G)))}';
// finalScore: sum of finalPoints for the session. Only the quizmaster sees it.
const PARTICIPANTS_FINAL_SCORE_FORMULA =
  '={"finalScore"; ARRAYFORMULA(IF(B2:B = "", , SUMIF(Responses!B2:B, B2:B, Responses!L2:L)))}';
const MAX_REVIEW_POINTS = 5;
const RESPONSES_MIN_ROWS = 20000;

const CONFIG_DEFAULTS = [
  ['START_AT', '2026-09-21T09:00:00+05:30', 'When the quiz opens (ISO 8601 with offset). Set the real date before launch.'],
  ['END_AT', '2026-09-23T09:00:00+05:30', 'When the quiz closes (ISO 8601 with offset). Set the real date before launch.'],
  ['TIME_LIMIT', '30', 'Seconds per scored question'],
  ['STAR_TIME_LIMIT', '60', 'Seconds for the last (star) text question'],
  ['GRACE_SECONDS', '5', 'Allowance for network delay'],
  ['FINISH_GRACE_MINUTES', '10', 'Minutes after END_AT that started sessions may still finish'],
  ['PICK_EASY', '4', 'Easy questions per participant'],
  ['PICK_MEDIUM', '3', 'Medium questions per participant'],
  ['PICK_HARD', '3', 'Hard questions per participant'],
  ['SHOW_SCORE', 'TRUE', 'Show the score (and star) on the final screen. Never includes review points.'],
  ['RESULTS_MESSAGE', 'Fingers crossed! Wait for the winner announcement on [DATE AND TIME].', 'Text on the final screen. Put in the announcement date and time.'],
  ['CODE_TTL_MINUTES', '10', 'Minutes an emailed sign-in code stays valid'],
  ['CODE_MAX_ATTEMPTS', '5', 'Wrong tries allowed per code'],
  ['CODE_MAX_PER_HOUR', '300', 'Codes sent per hour across everyone. A safety cap against abuse.'],
];

// Questions with this difficulty form the star pool. One is drawn and asked last.
const STAR_DIFFICULTY = 'star';
const CACHE_TTL_SEC = 21600; // 6 hours, the CacheService maximum.
const CONFIG_CACHE_SEC = 60;
const QUESTIONS_CACHE_SEC = 300;
const LOCK_WAIT_MS = 10000;
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const ANSWER_MAX = 1000;
const CODE_FROM = { address: 'n8nquiz@vmugdha.in', name: 'n8n Rapid-Fire Quiz' };
const CODE_RESEND_SEC = 60;
const CODE_PER_EMAIL_PER_HOUR = 5;

// Tests set these to run without touching the Config or Questions tabs,
// without Turnstile, and without sending real email.
var CONFIG_OVERRIDE = null;
var QUESTIONS_OVERRIDE = null;
var NOW_OVERRIDE = null;
var SKIP_TURNSTILE = false;
var SEND_CODE_OVERRIDE = null;

class QuizError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Web app entry points                                                */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, service: 'n8n-quiz' });
}

function doPost(e) {
  return json_(handleRequest_(e && e.postData ? e.postData.contents : ''));
}

/** Parses and routes one request. Returns a plain object (tests call this directly). */
function handleRequest_(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody || '');
  } catch (err) {
    return fail_('INVALID_INPUT');
  }
  if (!body || typeof body !== 'object') return fail_('INVALID_INPUT');

  try {
    switch (body.action) {
      case 'status': return handleStatus_();
      case 'requestCode': return handleRequestCode_(body);
      case 'start': return handleStart_(body);
      case 'answer': return handleAnswer_(body);
      case 'resume': return handleResume_(body);
      default: return fail_('INVALID_INPUT');
    }
  } catch (err) {
    if (err instanceof QuizError) return fail_(err.code);
    console.error(err && err.stack ? err.stack : err);
    // Unexpected failures are reported as BUSY so the client retries.
    return fail_('BUSY');
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function handleStatus_() {
  const cfg = getConfig_();
  const now = now_();
  let state = 'open';
  if (now < cfg.startAt) state = 'not_open';
  else if (now >= cfg.endAt) state = 'closed';
  return { ok: true, state, startAt: cfg.startAt.toISOString(), endAt: cfg.endAt.toISOString() };
}

/**
 * Emails a one-time sign-in code. Always answers { ok: true } for a valid request, even when the
 * email has already taken the quiz (no email is sent then), so the site can't be used to check who took part.
 */
function handleRequestCode_(body) {
  const input = validateContact_(body);
  const cfg = getConfig_();
  assertWindowOpen_(cfg);
  verifyTurnstile_(body.turnstileToken);

  const cache = CacheService.getScriptCache();
  const key = input.emailNorm;
  if (cache.get('r:' + key)) throw new QuizError('RESEND_TOO_SOON');
  const perEmail = Number(cache.get('rh:' + key)) || 0;
  if (perEmail >= CODE_PER_EMAIL_PER_HOUR) throw new QuizError('RESEND_TOO_SOON');
  cache.put('r:' + key, '1', CODE_RESEND_SEC);
  cache.put('rh:' + key, String(perEmail + 1), 3600);

  const sentResponse = { ok: true, resendAfter: CODE_RESEND_SEC, expiresInMinutes: cfg.codeTtlMinutes };
  if (emailAlreadyUsed_(key)) return sentResponse;

  // Approximate: the cache has no atomic increment, which is fine for a safety cap.
  const hourKey = 'rg:' + Math.floor(now_().getTime() / 3600000);
  const sentThisHour = Number(cache.get(hourKey)) || 0;
  if (sentThisHour >= cfg.codeMaxPerHour) throw new QuizError('CODE_LIMIT');
  cache.put(hourKey, String(sentThisHour + 1), 3600);

  const code = newCode_();
  const ttlSec = cfg.codeTtlMinutes * 60;
  cache.put('v:' + key, JSON.stringify({ h: codeHash_(code, key), a: 0, exp: now_().getTime() + ttlSec * 1000 }), ttlSec);
  try {
    sendCode_(input.email, code, cfg);
  } catch (err) {
    console.error('Code email failed: ' + (err && err.message ? err.message : err));
    cache.removeAll(['v:' + key, 'r:' + key]);
    throw new QuizError('EMAIL_FAILED');
  }
  return sentResponse;
}

function handleStart_(body) {
  const input = validateStart_(body);
  const attemptId = cleanId_(body.attemptId);
  const cfg = getConfig_();
  assertWindowOpen_(cfg);
  const cache = CacheService.getScriptCache();

  // A retried start (for example after a slow response timed out in the browser) gets its own session back.
  if (attemptId) {
    const existing = cache.get('a:' + attemptId);
    if (existing) {
      const session = loadSession_(existing, false);
      if (session.emailNorm === input.emailNorm) {
        return Object.assign({ ok: true, sessionId: session.sessionId }, stateResponse_(session, cfg, getQuestions_(), true));
      }
    }
  }

  const timer = stepTimer_('start');
  verifyCode_(input.emailNorm, body.code, cfg);

  const questions = getQuestions_();
  const questionIds = pickQuestionIds_(questions, cfg);
  if (questionIds.length === 0) throw new Error('Question bank is empty');
  timer.mark('prep');

  return withLock_(() => {
    if (emailAlreadyUsed_(input.emailNorm)) throw new QuizError('ALREADY_ATTEMPTED');
    timer.mark('emailCheck');

    const now = now_();
    const session = {
      sessionId: Utilities.getUuid(),
      name: input.name,
      email: input.email,
      emailNorm: input.emailNorm,
      questionIds,
      currentIndex: 1,
      servedAt: now.getTime(),
      status: 'active',
      score: 0,
      totalTimeSec: 0,
      star: false,
      row: 0,
    };

    const sheet = sheet_(SHEETS.PARTICIPANTS);
    sheet.appendRow([
      now, session.sessionId, safeCell_(session.name), safeCell_(session.email), safeCell_(session.emailNorm),
      questionIds.join(','), session.currentIndex, session.servedAt, session.status,
      session.score, session.totalTimeSec, '', false,
    ]);
    session.row = sheet.getLastRow();

    cache.put('e:' + input.emailNorm, '1', CACHE_TTL_SEC);
    cache.remove('v:' + input.emailNorm);
    if (attemptId) cache.put('a:' + attemptId, session.sessionId, CACHE_TTL_SEC);
    putSession_(session);
    timer.mark('writeRow');

    return Object.assign({ ok: true, sessionId: session.sessionId }, questionPayload_(session, cfg, questions));
  }, timer);
}

function handleAnswer_(body) {
  const sessionId = cleanId_(body.sessionId);
  const questionId = cleanId_(body.questionId);
  if (!sessionId || !questionId) throw new QuizError('INVALID_INPUT');
  const answer = typeof body.answer === 'string' ? body.answer.slice(0, ANSWER_MAX) : '';
  const timedOut = body.timedOut === true;

  const timer = stepTimer_('answer');
  const cfg = getConfig_();
  assertCanContinue_(cfg);
  const questions = getQuestions_();
  timer.mark('prep');

  return withLock_(() => {
    const session = loadSession_(sessionId, true);
    timer.mark('loadSession');
    const expectedId = session.questionIds[session.currentIndex - 1];

    // Retried request for a question that was already recorded: return the current state.
    if (session.status === 'done' || questionId !== expectedId) {
      const idx = session.questionIds.indexOf(questionId);
      const alreadyAnswered = idx !== -1 && (session.status === 'done' || idx < session.currentIndex - 1);
      if (!alreadyAnswered) throw new QuizError('INVALID_INPUT');
      return stateResponse_(session, cfg, questions, false);
    }

    const question = questions.byId[questionId];
    const now = now_().getTime();
    const limit = timeLimitFor_(question, cfg);
    const elapsedSec = Math.max(0, (now - session.servedAt) / 1000);
    const late = !timedOut && elapsedSec > limit + cfg.graceSeconds;
    const star = isStar_(question);
    const correct = !star && !timedOut && !late && question ? scoreAnswer_(question, answer) : false;

    if (correct) session.score += 1;
    if (star) {
      // Any text that arrived in time earns the star, including text sent when the timer ran out.
      session.star = !late && normalizeText_(answer) !== '';
    } else {
      session.totalTimeSec = round1_(session.totalTimeSec + Math.min(elapsedSec, limit));
    }

    sheet_(SHEETS.RESPONSES).appendRow([
      new Date(now), session.sessionId, safeCell_(session.email), session.currentIndex, questionId,
      safeCell_(answer), correct ? 1 : 0, round1_(elapsedSec), late, star ? 'star' : 'scored',
    ]);
    timer.mark('appendRow');

    const finished = session.currentIndex >= session.questionIds.length;
    if (finished) {
      session.status = 'done';
      session.finishedAt = new Date(now);
    } else {
      session.currentIndex += 1;
      session.servedAt = now;
    }
    writeSessionRow_(session);
    putSession_(session);
    timer.mark('writeRow');

    return stateResponse_(session, cfg, questions, false);
  }, timer);
}

function handleResume_(body) {
  const sessionId = cleanId_(body.sessionId);
  if (!sessionId) throw new QuizError('INVALID_INPUT');
  const cfg = getConfig_();
  assertCanContinue_(cfg);
  const session = loadSession_(sessionId, false);
  return stateResponse_(session, cfg, getQuestions_(), true);
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

function stateResponse_(session, cfg, questions, includeRemaining) {
  if (session.status === 'done') {
    const out = { ok: true, done: true, maxScore: scoredCount_(session, questions), message: cfg.resultsMessage };
    if (cfg.showScore) {
      out.score = session.score;
      out.star = session.star;
    }
    return out;
  }
  const out = Object.assign({ ok: true, done: false }, questionPayload_(session, cfg, questions));
  if (includeRemaining) {
    const limit = timeLimitFor_(questions.byId[session.questionIds[session.currentIndex - 1]], cfg);
    const elapsed = (now_().getTime() - session.servedAt) / 1000;
    out.remaining = Math.max(0, Math.round(limit - elapsed));
  }
  return out;
}

function questionPayload_(session, cfg, questions) {
  const id = session.questionIds[session.currentIndex - 1];
  const q = questions.byId[id];
  if (!q) throw new Error('Question not found: ' + id);
  // Only public fields. Never include answer or accepted.
  const question = { id: q.id, type: q.type, text: q.text };
  if (q.type === 'mcq') question.options = q.options.slice();
  if (isStar_(q)) question.star = true;
  return {
    index: session.currentIndex,
    total: session.questionIds.length,
    timeLimit: timeLimitFor_(q, cfg),
    question,
  };
}

function isStar_(question) {
  return !!question && question.difficulty === STAR_DIFFICULTY;
}

function scoredCount_(session, questions) {
  return session.questionIds.filter((id) => !isStar_(questions.byId[id])).length;
}

function timeLimitFor_(question, cfg) {
  return isStar_(question) ? cfg.starTimeLimit : cfg.timeLimit;
}

/* ------------------------------------------------------------------ */
/* Validation and scoring                                              */
/* ------------------------------------------------------------------ */

function validateStart_(body) {
  if (body.consent !== true) throw new QuizError('INVALID_INPUT');
  return validateContact_(body);
}

/** Name, email and the honeypot. Shared by requestCode and start. */
function validateContact_(body) {
  // Honeypot: real users never see this field, bots tend to fill it in.
  if (body.hp) throw new QuizError('INVALID_INPUT');

  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (name.length < 2 || name.length > NAME_MAX) throw new QuizError('INVALID_INPUT');
  if (email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new QuizError('INVALID_INPUT');
  return { name, email, emailNorm: email.toLowerCase() };
}

/** Lowercase, strip punctuation, collapse whitespace. Applied to both sides of a text comparison. */
function normalizeText_(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 1 point for a correct answer to a scored question. MCQ: exact option match.
 * Text (if the bank has any scored text questions): matches an `accepted` entry after normalising.
 * The star question is not scored here.
 */
function scoreAnswer_(question, answer) {
  if (question.type === 'mcq') {
    return String(answer).trim() === String(question.answer).trim();
  }
  const given = normalizeText_(answer);
  return given !== '' && question.accepted.some((a) => normalizeText_(a) === given);
}

function cleanId_(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
}

/** Stops user text from being treated as a formula when written to the Sheet. */
function safeCell_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function round1_(n) {
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Question selection                                                  */
/* ------------------------------------------------------------------ */

/** Draws PICK_* questions at each difficulty, shuffles them, then adds one random star question last. */
function pickQuestionIds_(questions, cfg) {
  const picks = [
    ['easy', cfg.pickEasy],
    ['medium', cfg.pickMedium],
    ['hard', cfg.pickHard],
  ];
  let chosen = [];
  picks.forEach(([difficulty, count]) => {
    const pool = shuffle_(questions.list.filter((q) => q.difficulty === difficulty));
    if (pool.length < count) console.warn('Only ' + pool.length + ' active ' + difficulty + ' questions for ' + count + ' picks');
    chosen = chosen.concat(pool.slice(0, count).map((q) => q.id));
  });
  chosen = shuffle_(chosen);
  const starPool = shuffle_(questions.list.filter(isStar_));
  if (starPool.length) chosen.push(starPool[0].id);
  else console.warn('No active star questions');
  return chosen;
}

function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Quiz window                                                         */
/* ------------------------------------------------------------------ */

function assertWindowOpen_(cfg) {
  const now = now_();
  if (now < cfg.startAt) throw new QuizError('QUIZ_NOT_OPEN');
  if (now >= cfg.endAt) throw new QuizError('QUIZ_CLOSED');
}

/** Sessions started before END_AT may finish, but not long after it. */
function assertCanContinue_(cfg) {
  const cutoff = cfg.endAt.getTime() + cfg.finishGraceMinutes * 60000;
  if (now_().getTime() >= cutoff) throw new QuizError('QUIZ_CLOSED');
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function emailAlreadyUsed_(emailNorm) {
  if (CacheService.getScriptCache().get('e:' + emailNorm)) return true;
  const sheet = sheet_(SHEETS.PARTICIPANTS);
  if (sheet.getLastRow() < 2) return false;
  const found = sheet.getRange(2, P_COL.emailNorm, sheet.getLastRow() - 1, 1)
    .createTextFinder(emailNorm).matchEntireCell(true).matchCase(false).findNext();
  return !!found;
}

/**
 * Loads a session from the cache, falling back to the Sheet.
 * With verifyRow, a cached row number is checked against the Sheet first,
 * in case someone sorted or deleted rows in Participants.
 */
function loadSession_(sessionId, verifyRow) {
  const sheet = sheet_(SHEETS.PARTICIPANTS);
  const cached = CacheService.getScriptCache().get('s:' + sessionId);
  if (cached) {
    const session = JSON.parse(cached);
    if (!verifyRow || sheet.getRange(session.row, P_COL.sessionId).getValue() === sessionId) return session;
  }

  if (sheet.getLastRow() < 2) throw new QuizError('INVALID_SESSION');
  const found = sheet.getRange(2, P_COL.sessionId, sheet.getLastRow() - 1, 1)
    .createTextFinder(sessionId).matchEntireCell(true).findNext();
  if (!found) throw new QuizError('INVALID_SESSION');

  const row = found.getRow();
  const v = sheet.getRange(row, 1, 1, PARTICIPANT_HEADERS.length).getValues()[0];
  const session = {
    sessionId,
    name: String(v[P_COL.name - 1]),
    email: String(v[P_COL.email - 1]),
    emailNorm: String(v[P_COL.emailNorm - 1]),
    questionIds: String(v[P_COL.questionIds - 1]).split(',').filter(String),
    currentIndex: Number(v[P_COL.currentIndex - 1]),
    servedAt: Number(v[P_COL.servedAt - 1]),
    status: String(v[P_COL.status - 1]),
    score: Number(v[P_COL.score - 1]) || 0,
    star: v[P_COL.star - 1] === true || String(v[P_COL.star - 1]).toUpperCase() === 'TRUE',
    totalTimeSec: Number(v[P_COL.totalTimeSec - 1]) || 0,
    row,
  };
  putSession_(session);
  return session;
}

function putSession_(session) {
  const cache = CacheService.getScriptCache();
  try {
    cache.put('s:' + session.sessionId, JSON.stringify(session), CACHE_TTL_SEC);
  } catch (err) {
    // A stale cache entry would be worse than none; the Sheet stays the source of truth.
    cache.remove('s:' + session.sessionId);
  }
}

/** Writes the mutable columns currentIndex..star in one call. */
function writeSessionRow_(session) {
  sheet_(SHEETS.PARTICIPANTS)
    .getRange(session.row, P_COL.currentIndex, 1, P_COL.star - P_COL.currentIndex + 1)
    .setValues([[
      session.currentIndex, session.servedAt, session.status, session.score,
      session.totalTimeSec, session.finishedAt || '', !!session.star,
    ]]);
}

function withLock_(fn, timer) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new QuizError('BUSY');
  if (timer) timer.mark('lockWait');
  try {
    const result = fn();
    SpreadsheetApp.flush();
    if (timer) timer.mark('flush');
    return result;
  } finally {
    lock.releaseLock();
    if (timer) timer.log();
  }
}

/**
 * Records how long each step of a request takes, as one log line per request
 * (Apps Script > Executions). Logs only step names and milliseconds, never user data.
 */
function stepTimer_(action) {
  const t0 = Date.now();
  let last = t0;
  const steps = {};
  return {
    mark(name) {
      const t = Date.now();
      steps[name] = t - last;
      last = t;
    },
    log() {
      console.log(JSON.stringify(Object.assign({ timing: action }, steps, { total: Date.now() - t0 })));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Emailed sign-in codes                                               */
/* ------------------------------------------------------------------ */

/** A 6-digit code from a random UUID (SecureRandom), not Math.random. */
function newCode_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  const n = (((bytes[0] & 0xff) << 24) >>> 0) + ((bytes[1] & 0xff) << 16) + ((bytes[2] & 0xff) << 8) + (bytes[3] & 0xff);
  return String(n % 1000000).padStart(6, '0');
}

function codeHash_(code, emailNorm) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, code + '|' + emailNorm, Utilities.Charset.UTF_8);
  return bytes.map((b) => ((b & 0xff) + 0x100).toString(16).slice(1)).join('');
}

/** Throws unless `code` matches the latest code sent to this email. Wrong tries are counted. */
function verifyCode_(emailNorm, code, cfg) {
  const given = typeof code === 'string' ? code.trim() : '';
  if (!/^\d{6}$/.test(given)) throw new QuizError('INVALID_CODE');

  const cache = CacheService.getScriptCache();
  const raw = cache.get('v:' + emailNorm);
  if (!raw) throw new QuizError('CODE_EXPIRED');
  const v = JSON.parse(raw);
  const leftMs = v.exp - now_().getTime();
  if (leftMs <= 0) {
    cache.remove('v:' + emailNorm);
    throw new QuizError('CODE_EXPIRED');
  }
  if (v.a >= cfg.codeMaxAttempts) throw new QuizError('TOO_MANY_ATTEMPTS');
  if (codeHash_(given, emailNorm) !== v.h) {
    v.a += 1;
    cache.put('v:' + emailNorm, JSON.stringify(v), Math.max(1, Math.ceil(leftMs / 1000)));
    throw new QuizError(v.a >= cfg.codeMaxAttempts ? 'TOO_MANY_ATTEMPTS' : 'INVALID_CODE');
  }
}

/** Sends the code through Cloudflare Email Sending. Needs the CF_EMAIL_TOKEN and CF_ACCOUNT_ID script properties. */
function sendCode_(to, code, cfg) {
  if (SEND_CODE_OVERRIDE) return SEND_CODE_OVERRIDE(to, code);
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('CF_EMAIL_TOKEN');
  const accountId = props.getProperty('CF_ACCOUNT_ID');
  if (!token || !accountId) throw new Error('CF_EMAIL_TOKEN or CF_ACCOUNT_ID script property is missing');

  const minutes = cfg.codeTtlMinutes;
  const text = 'Your code for the n8n Rapid-Fire Quiz is ' + code + '.\n\n' +
    'It expires in ' + minutes + ' minutes. If you didn\'t ask for this code, you can ignore this email.';
  const html = '<p>Your code for the n8n Rapid-Fire Quiz is:</p>' +
    '<p style="font-size:28px;font-weight:700;letter-spacing:4px">' + code + '</p>' +
    '<p>It expires in ' + minutes + ' minutes. If you didn\'t ask for this code, you can ignore this email.</p>';

  const res = UrlFetchApp.fetch('https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/email/sending/send', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to, from: CODE_FROM, subject: code + ' is your n8n quiz code', text, html }),
    muteHttpExceptions: true,
  });
  const status = res.getResponseCode();
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) { /* treated as failure below */ }
  const bounced = data.result && data.result.permanent_bounces && data.result.permanent_bounces.length > 0;
  if (status < 200 || status >= 300 || !data.success || bounced) {
    throw new Error('Cloudflare email API: HTTP ' + status + ' ' + JSON.stringify(data.errors || []) + (bounced ? ' (permanent bounce)' : ''));
  }
}

/* ------------------------------------------------------------------ */
/* Optional Cloudflare Turnstile                                       */
/* ------------------------------------------------------------------ */

/** Runs only when the TURNSTILE_SECRET script property is set. */
function verifyTurnstile_(token) {
  if (SKIP_TURNSTILE) return;
  const secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) return;
  if (typeof token !== 'string' || !token) throw new QuizError('INVALID_INPUT');
  const res = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'post',
    payload: { secret, response: token },
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) { /* treated as failure below */ }
  if (!data.success) throw new QuizError('INVALID_INPUT');
}

/* ------------------------------------------------------------------ */
/* Config and question bank                                            */
/* ------------------------------------------------------------------ */

function getConfig_() {
  let raw;
  if (CONFIG_OVERRIDE) {
    raw = CONFIG_OVERRIDE;
  } else {
    const cache = CacheService.getScriptCache();
    const cached = cache.get('config');
    if (cached) {
      raw = JSON.parse(cached);
    } else {
      raw = {};
      const values = sheet_(SHEETS.CONFIG).getDataRange().getValues();
      values.slice(1).forEach((r) => {
        if (r[0]) raw[String(r[0]).trim()] = r[1] instanceof Date ? r[1].toISOString() : String(r[1]).trim();
      });
      cache.put('config', JSON.stringify(raw), CONFIG_CACHE_SEC);
    }
  }
  const num = (k, d) => (raw[k] === undefined || raw[k] === '' || isNaN(Number(raw[k])) ? d : Number(raw[k]));
  const cfg = {
    startAt: new Date(raw.START_AT),
    endAt: new Date(raw.END_AT),
    timeLimit: num('TIME_LIMIT', 30),
    starTimeLimit: num('STAR_TIME_LIMIT', 60),
    graceSeconds: num('GRACE_SECONDS', 5),
    finishGraceMinutes: num('FINISH_GRACE_MINUTES', 10),
    pickEasy: num('PICK_EASY', 3),
    pickMedium: num('PICK_MEDIUM', 3),
    pickHard: num('PICK_HARD', 3),
    showScore: String(raw.SHOW_SCORE).toUpperCase() === 'TRUE',
    resultsMessage: raw.RESULTS_MESSAGE || 'Thanks for playing!',
    codeTtlMinutes: num('CODE_TTL_MINUTES', 10),
    codeMaxAttempts: num('CODE_MAX_ATTEMPTS', 5),
    codeMaxPerHour: num('CODE_MAX_PER_HOUR', 300),
  };
  if (isNaN(cfg.startAt.getTime()) || isNaN(cfg.endAt.getTime())) throw new Error('START_AT or END_AT is not a valid date');
  return cfg;
}

/** Returns { list, byId } of questions, cached for a few minutes. */
function getQuestions_() {
  let rows;
  if (QUESTIONS_OVERRIDE) {
    rows = QUESTIONS_OVERRIDE;
  } else {
    const cache = CacheService.getScriptCache();
    const cached = cache.get('questions');
    if (cached) {
      rows = JSON.parse(cached);
    } else {
      const values = sheet_(SHEETS.QUESTIONS).getDataRange().getValues();
      const header = values[0].map((h) => String(h).trim());
      rows = values.slice(1).map((r) => {
        const o = {};
        header.forEach((h, i) => { o[h] = r[i]; });
        return o;
      });
      cache.put('questions', JSON.stringify(rows), QUESTIONS_CACHE_SEC);
    }
  }
  const split = (s) => String(s == null ? '' : s).split('|').map((x) => x.trim()).filter(String);
  const all = rows
    .filter((r) => r.id)
    .map((r) => ({
      id: String(r.id).trim(),
      active: r.active === true || String(r.active).toUpperCase() === 'TRUE',
      type: String(r.type).trim().toLowerCase(),
      difficulty: String(r.difficulty).trim().toLowerCase(),
      text: String(r.text),
      options: split(r.options),
      answer: String(r.answer == null ? '' : r.answer).trim(),
      accepted: split(r.accepted),
    }));
  // list: active questions, used for picking. byId: every question, so a question turned off
  // mid-quiz can still be served and scored for participants who were already given it.
  const list = all.filter((q) => q.active);
  const byId = {};
  all.forEach((q) => { byId[q.id] = q; });
  return { list, byId };
}

/** Run after editing the Config or Questions tab to apply changes immediately. */
function clearCaches() {
  CacheService.getScriptCache().removeAll(['config', 'questions']);
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

/** Creates tabs, headers, Config defaults and the Leaderboard and Summary formulas. Safe to re-run. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const config = ensureSheet_(ss, SHEETS.CONFIG, ['key', 'value', 'meaning']);
  config.getRange('B:B').setNumberFormat('@'); // Keep dates and TRUE/FALSE as text.
  const existingKeys = config.getLastRow() > 1
    ? config.getRange(2, 1, config.getLastRow() - 1, 1).getValues().map((r) => r[0])
    : [];
  CONFIG_DEFAULTS.filter((r) => existingKeys.indexOf(r[0]) === -1).forEach((r) => config.appendRow(r));

  ensureSheet_(ss, SHEETS.QUESTIONS, QUESTION_HEADERS);

  const participants = ensureSheet_(ss, SHEETS.PARTICIPANTS, PARTICIPANT_HEADERS);
  participants.getRange('E:E').setNumberFormat('@');
  participants.getRange('H:H').setNumberFormat('0');

  participants.getRange(1, PARTICIPANT_HEADERS.length + 1).setFormula(PARTICIPANTS_FINAL_SCORE_FORMULA).setFontWeight('bold');

  const responses = ensureSheet_(ss, SHEETS.RESPONSES, RESPONSE_HEADERS);
  responses.getRange(1, RESPONSE_HEADERS.length + 1).setFormula(RESPONSES_FINAL_POINTS_FORMULA).setFontWeight('bold');
  // Pre-size so the reviewPoints check covers every future row (10 rows per participant).
  if (responses.getMaxRows() < RESPONSES_MIN_ROWS) {
    responses.insertRowsAfter(responses.getMaxRows(), RESPONSES_MIN_ROWS - responses.getMaxRows());
  }
  responses.getRange(2, RESPONSE_HEADERS.length, responses.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireNumberBetween(0, MAX_REVIEW_POINTS)
      .setAllowInvalid(false)
      .setHelpText('Points for a star answer: 0 to ' + MAX_REVIEW_POINTS + '. Ignored on scored rows.')
      .build());

  // Private to the quizmaster. Sorted by finalScore (correct answers + star review points).
  // Ties are left to the quizmaster; totalTimeSec is shown for information only.
  const leaderboard = ensureSheet_(ss, SHEETS.LEADERBOARD, []);
  leaderboard.getRange('A1').setFormula(
    "=QUERY(Participants!A:N, \"select C, D, N, J, M, K, L where I = 'done' order by N desc " +
    "label C 'name', D 'email', N 'finalScore', J 'correct', M 'star', K 'totalTimeSec', L 'finishedAt'\", 1)");

  const summary = ensureSheet_(ss, SHEETS.SUMMARY, []);
  summary.getRange('A1:B8').setValues([
    ['Metric', 'Value'],
    ['Attempts started', '=COUNTA(Participants!B2:B)'],
    ['Attempts finished', '=COUNTIF(Participants!I2:I, "done")'],
    ['Average correct answers (finished)', '=IFERROR(AVERAGEIF(Participants!I2:I, "done", Participants!J2:J), 0)'],
    ['Stars earned', '=COUNTIF(Participants!M2:M, TRUE)'],
    ['Stars not yet reviewed', '=COUNTIFS(Responses!J2:J, "star", Responses!I2:I, FALSE, Responses!F2:F, "<>", Responses!K2:K, "")'],
    ['Average final score (finished)', '=IFERROR(AVERAGEIF(Participants!I2:I, "done", Participants!N2:N), 0)'],
    ['Late answers', '=COUNTIF(Responses!I2:I, TRUE)'],
  ]);
  summary.getRange('D1').setFormula(
    "=QUERY(Responses!A:L, \"select E, count(E), avg(G) where E <> '' and J = 'scored' " +
    "group by E order by avg(G) label E 'questionId', count(E) 'answers', avg(G) 'accuracy'\", 1)");

  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);
  clearCaches();
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (headers.length && sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return sheet;
}

function now_() {
  return NOW_OVERRIDE ? new Date(NOW_OVERRIDE) : new Date();
}

function fail_(code) {
  return { ok: false, error: code };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
