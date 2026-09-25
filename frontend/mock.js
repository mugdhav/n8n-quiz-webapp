// Local mock backend that follows the API contract in PLAN.md section 3.
// Used only when USE_MOCK is true in config.js. The questions here are placeholders,
// so no real answers ship with the site.
//
// Add ?mock=not_open, ?mock=closed or ?mock=busy to the page URL to try those states.
// Sign-in codes are printed to the browser console instead of being emailed.

const TIME_LIMIT = 30;
const STAR_TIME_LIMIT = 60;
const GRACE_SECONDS = 5;
const LATENCY_MS = 350;
const RESEND_SEC = 60;
const CODE_TTL_MIN = 10;
const STORE_KEY = "n8nQuiz.mockDb";

const BANK = [
  { id: "M01", type: "mcq", difficulty: "easy", text: "Sample: which colour is the sky on a clear day?", options: ["Green", "Blue", "Red", "Brown"], answer: "Blue" },
  { id: "M02", type: "text", difficulty: "easy", text: "Sample: type the word \"merge\".", accepted: ["merge"] },
  { id: "M03", type: "mcq", difficulty: "easy", text: "Sample: 2 + 2 = ?", options: ["3", "4", "5", "22"], answer: "4" },
  { id: "M04", type: "mcq", difficulty: "medium", text: "Sample: which of these is a day of the week?", options: ["Monday", "March", "Autumn", "Noon"], answer: "Monday" },
  { id: "M05", type: "text", difficulty: "medium", text: "Sample: type the word \"webhook\".", accepted: ["webhook"] },
  { id: "M06", type: "mcq", difficulty: "medium", text: "Sample: how many sides does a triangle have?", options: ["2", "3", "4", "6"], answer: "3" },
  { id: "M07", type: "mcq", difficulty: "hard", text: "Sample: which number is prime?", options: ["21", "27", "29", "33"], answer: "29" },
  { id: "M08", type: "text", difficulty: "hard", text: "Sample: type the word \"workflow\".", accepted: ["workflow"] },
  { id: "M09", type: "mcq", difficulty: "hard", text: "Sample: which is the largest?", options: ["0.5", "0.45", "0.405", "0.054"], answer: "0.5" },
  { id: "M10", type: "mcq", difficulty: "easy", text: "Sample: which of these is a fruit?", options: ["Carrot", "Potato", "Onion", "Apple"], answer: "Apple" },
  { id: "M11", type: "mcq", difficulty: "hard", text: "Sample: 12 × 12 = ?", options: ["124", "144", "132", "154"], answer: "144" },
  { id: "M12", type: "mcq", difficulty: "medium", text: "Sample: which planet is closest to the Sun?", options: ["Venus", "Earth", "Mercury", "Mars"], answer: "Mercury" },
  { id: "S01", type: "text", difficulty: "star", text: "Sample bonus: describe your n8n experience." },
  { id: "S02", type: "text", difficulty: "star", text: "Sample bonus: what would you automate first?" },
];

const byId = Object.fromEntries(BANK.map((q) => [q.id, q]));

export async function handle(body) {
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  const mode = new URLSearchParams(location.search).get("mock");
  if (mode === "busy") return { ok: false, error: "BUSY" };

  const now = Date.now();
  const startAt = mode === "not_open" ? new Date(now + 86400000) : new Date(now - 3600000);
  const endAt = mode === "closed" ? new Date(now - 60000) : new Date(now + 86400000);
  const state = now < startAt ? "not_open" : now >= endAt ? "closed" : "open";

  const db = load();
  switch (body.action) {
    case "status":
      return { ok: true, state, startAt: startAt.toISOString(), endAt: endAt.toISOString() };

    case "requestCode": {
      if (body.hp) return fail("INVALID_INPUT");
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("INVALID_INPUT");
      if (state === "not_open") return fail("QUIZ_NOT_OPEN");
      if (state === "closed") return fail("QUIZ_CLOSED");
      const prev = db.codes[email];
      if (prev && now - prev.sentAt < RESEND_SEC * 1000) return fail("RESEND_TOO_SOON");
      const sent = { ok: true, resendAfter: RESEND_SEC, expiresInMinutes: CODE_TTL_MIN };
      if (db.emails.includes(email)) return sent; // Same answer as a new email, but nothing is "sent".
      const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
      db.codes[email] = { code, sentAt: now, tries: 0 };
      save(db);
      console.info(`[mock] Code for ${email}: ${code}`);
      return sent;
    }

    case "start": {
      if (body.hp || body.consent !== true) return fail("INVALID_INPUT");
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("INVALID_INPUT");
      if (state === "not_open") return fail("QUIZ_NOT_OPEN");
      if (state === "closed") return fail("QUIZ_CLOSED");
      const retried = body.attemptId && db.attempts[body.attemptId];
      if (retried && db.sessions[retried]) return { ok: true, sessionId: retried, ...stateOf(db.sessions[retried], true) };
      const c = db.codes[email];
      if (!/^\d{6}$/.test(String(body.code || ""))) return fail("INVALID_CODE");
      if (!c || now - c.sentAt > CODE_TTL_MIN * 60000) return fail("CODE_EXPIRED");
      if (c.tries >= 5) return fail("TOO_MANY_ATTEMPTS");
      if (body.code !== c.code) {
        c.tries++;
        save(db);
        return fail(c.tries >= 5 ? "TOO_MANY_ATTEMPTS" : "INVALID_CODE");
      }
      if (db.emails.includes(email)) return fail("ALREADY_ATTEMPTED");
      delete db.codes[email];
      const pick = (d, n) => shuffle(BANK.filter((q) => q.difficulty === d)).slice(0, n).map((q) => q.id);
      const s = {
        id: crypto.randomUUID(),
        ids: [...shuffle([...pick("easy", 4), ...pick("medium", 3), ...pick("hard", 3)]), ...pick("star", 1)],
        index: 1, servedAt: now, score: 0, star: false, done: false,
      };
      db.emails.push(email);
      db.sessions[s.id] = s;
      if (body.attemptId) db.attempts[body.attemptId] = s.id;
      save(db);
      return { ok: true, sessionId: s.id, ...payload(s) };
    }

    case "answer": {
      const s = db.sessions[body.sessionId];
      if (!s) return fail("INVALID_SESSION");
      const expected = s.ids[s.index - 1];
      if (s.done || body.questionId !== expected) {
        const idx = s.ids.indexOf(body.questionId);
        if (idx === -1 || (!s.done && idx >= s.index - 1)) return fail("INVALID_INPUT");
        return stateOf(s, false);
      }
      const q = byId[expected];
      const limit = limitFor(expected);
      const late = !body.timedOut && (now - s.servedAt) / 1000 > limit + GRACE_SECONDS;
      const text = String(body.answer || "");
      if (q.difficulty === "star") s.star = !late && text.trim() !== "";
      else if (!body.timedOut && !late && isCorrect(q, text)) s.score++;
      if (s.index >= s.ids.length) s.done = true;
      else { s.index++; s.servedAt = now; }
      save(db);
      return stateOf(s, false);
    }

    case "resume": {
      const s = db.sessions[body.sessionId];
      if (!s) return fail("INVALID_SESSION");
      return stateOf(s, true);
    }

    default:
      return fail("INVALID_INPUT");
  }
}

function stateOf(s, withRemaining) {
  if (s.done) return { ok: true, done: true, score: s.score, star: s.star, maxScore: s.ids.length - 1, message: "Fingers crossed! Wait for the winner announcement on [DATE AND TIME]. (mock)" };
  const out = { ok: true, done: false, ...payload(s) };
  if (withRemaining) out.remaining = Math.max(0, Math.round(limitFor(s.ids[s.index - 1]) - (Date.now() - s.servedAt) / 1000));
  return out;
}

function payload(s) {
  const q = byId[s.ids[s.index - 1]];
  const question = { id: q.id, type: q.type, text: q.text };
  if (q.type === "mcq") question.options = q.options;
  if (q.difficulty === "star") question.star = true;
  return { index: s.index, total: s.ids.length, timeLimit: limitFor(q.id), question };
}

function limitFor(id) {
  return byId[id].difficulty === "star" ? STAR_TIME_LIMIT : TIME_LIMIT;
}

function isCorrect(q, answer) {
  if (q.type === "mcq") return answer.trim() === q.answer;
  const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return q.accepted.some((a) => norm(a) === norm(answer));
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fail(error) {
  return { ok: false, error };
}

function load() {
  let db = null;
  try { db = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { /* start fresh */ }
  return { emails: [], sessions: {}, codes: {}, attempts: {}, ...db };
}

function save(db) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    /* Mock state is lost on reload without storage; that is fine for local testing. */
  }
}
