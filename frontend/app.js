import { call } from "./api.js";
import { TURNSTILE_SITE_KEY } from "./config.js";

const SESSION_KEY = "n8nQuiz.sessionId";
const RESULT_KEY = "n8nQuiz.result";
const WARN_AT = [10, 5];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const $ = (id) => document.getElementById(id);

const ERRORS = {
  ALREADY_ATTEMPTED: "This email has already been used to take the quiz. Each email gets one attempt.",
  QUIZ_NOT_OPEN: "The quiz hasn't opened yet.",
  QUIZ_CLOSED: "The quiz has closed. Thanks for your interest!",
  INVALID_INPUT: "Please check your name and email, and tick the consent box.",
  INVALID_SESSION: "We couldn't find your quiz session. Please start again.",
  INVALID_CODE: "That code isn't right. Check the email and try again.",
  CODE_EXPIRED: "That code has expired or has already been used. Please ask for a new code.",
  TOO_MANY_ATTEMPTS: "Too many wrong tries. Please ask for a new code.",
  RESEND_TOO_SOON: "A code was sent a moment ago. Please wait before asking for another.",
  CODE_LIMIT: "Lots of people are asking for codes right now. Please try again in a few minutes.",
  EMAIL_FAILED: "We couldn't send a code to this address. Check it and try again.",
  BUSY: "The quiz is very busy right now. Please try again in a moment.",
  NETWORK: "We couldn't reach the quiz server. Check your connection and try again.",
};

const state = {
  sessionId: null,
  question: null,
  deadline: 0,
  timeLimit: 30,
  timerId: 0,
  rafId: 0,
  warned: new Set(),
  submitting: false,
  turnstileToken: "",
  codeEmail: "",      // the email the current code was sent to
  resendTimerId: 0,
  attempt: null,      // { key, id }: reused when Start is pressed again for the same email and code
};

/* ---------- Storage (may be unavailable in private mode) ---------- */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ---------- Screens ---------- */

function show(name, focusId) {
  document.querySelectorAll(".screen").forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
  if (focusId) requestAnimationFrame(() => $(focusId)?.focus());
}

function showError(code, { retry = null } = {}) {
  stopTimer();
  $("error-message").textContent = ERRORS[code] || ERRORS.NETWORK;
  const btn = $("error-retry");
  btn.hidden = !retry;
  btn.onclick = retry;
  show("error", "error-title");
}

function showFinish(res) {
  stopTimer();
  store.remove(SESSION_KEY);
  store.set(RESULT_KEY, JSON.stringify({ score: res.score, maxScore: res.maxScore, star: res.star, message: res.message }));
  const scoreEl = $("finish-score");
  const detailEl = $("finish-detail");
  scoreEl.hidden = detailEl.hidden = typeof res.score !== "number";
  if (!scoreEl.hidden) {
    scoreEl.textContent = res.star ? `${res.score} + ★` : String(res.score);
    scoreEl.setAttribute("aria-label", res.star ? `Score ${res.score} plus a star` : `Score ${res.score}`);
    detailEl.textContent = `${res.score} of ${res.maxScore} correct.` +
      (res.star ? " You earned a ★ for answering the bonus question." : "");
  }
  $("finish-message").textContent = res.message || "";
  show("finish", "finish-title");
}

/* ---------- Start-up ---------- */

async function init() {
  const sessionId = store.get(SESSION_KEY);
  if (sessionId) return resume(sessionId);

  const saved = store.get(RESULT_KEY);
  if (saved) {
    try { return showFinish(JSON.parse(saved)); } catch { store.remove(RESULT_KEY); }
  }

  // Show the rules and the form straight away. The status check (which also wakes up the
  // backend) fills in the pill when it arrives; the server checks the quiz window again anyway.
  renderLanding(null);
  const res = await call({ action: "status" });
  renderLanding(res);
}

/** status is null while the check is still on its way. */
function renderLanding(status) {
  const pill = $("window-status");
  const form = $("signup-form");
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  form.hidden = false;
  pill.className = "status-pill";
  $("code-btn").disabled = status === null;
  if (status === null) {
    pill.textContent = "Checking whether the quiz is open…";
    pill.classList.add("wait");
    setupTurnstile();
  } else if (!status.ok) {
    pill.textContent = "";
    setupTurnstile();
  } else if (status.state === "not_open") {
    pill.textContent = `Quiz opens at ${fmt(status.startAt)}`;
    pill.classList.add("wait");
    form.hidden = true;
  } else if (status.state === "closed") {
    pill.textContent = "The quiz has closed. Thanks for your interest!";
    pill.classList.add("closed");
    form.hidden = true;
  } else {
    pill.textContent = `Open now · closes ${fmt(status.endAt)}`;
    pill.classList.add("open");
    setupTurnstile();
  }
  show("landing");
}

/* ---------- Sign-up ---------- */

function contactDetails() {
  const name = $("name").value.trim();
  const email = $("email").value.trim();
  $("form-error").textContent = "";
  if (name.length < 2) return formError("Please enter your name.", "name");
  if (!EMAIL_RE.test(email)) return formError("Please enter a valid email address.", "email");
  return { name, email };
}

/* Step 1: email a one-time code. */

$("code-btn").addEventListener("click", async () => {
  const contact = contactDetails();
  if (!contact) return;
  if (TURNSTILE_SITE_KEY && !state.turnstileToken) return formError("Please complete the check below the email field.");

  const btn = $("code-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";
  const res = await call({
    action: "requestCode", ...contact,
    hp: $("website").value, turnstileToken: state.turnstileToken || undefined,
  });
  resetTurnstile(); // Turnstile tokens work only once.

  if (res.ok || res.error === "RESEND_TOO_SOON") {
    state.codeEmail = contact.email;
    const codeEl = $("code");
    codeEl.disabled = false;
    codeEl.focus();
    $("code-status").textContent = res.ok
      ? `We've sent a 6-digit code to ${contact.email}. It expires in ${res.expiresInMinutes || 10} minutes. If you can't see it, check your spam folder.`
      : "A code was sent to this address a moment ago. Check your inbox and spam folder, or ask for a new one when the timer ends.";
    return startResendCountdown(res.resendAfter || 60);
  }
  btn.disabled = false;
  btn.textContent = state.codeEmail ? "Resend code" : "Send code";
  formError(ERRORS[res.error] || ERRORS.NETWORK);
});

function startResendCountdown(seconds) {
  clearInterval(state.resendTimerId);
  const btn = $("code-btn");
  let left = seconds;
  const tick = () => {
    if (left <= 0) {
      clearInterval(state.resendTimerId);
      btn.disabled = false;
      btn.textContent = "Resend code";
      return;
    }
    btn.disabled = true;
    btn.textContent = `Resend (${left}s)`;
    left--;
  };
  tick();
  state.resendTimerId = setInterval(tick, 1000);
}

// A code belongs to one email address. Changing the address starts over.
$("email").addEventListener("input", () => {
  if (!state.codeEmail || $("email").value.trim() === state.codeEmail) return;
  state.codeEmail = "";
  clearInterval(state.resendTimerId);
  $("code").value = "";
  $("code").disabled = true;
  $("code-status").textContent = "";
  $("code-btn").disabled = false;
  $("code-btn").textContent = "Send code";
});

// Enter in the email field sends the code instead of submitting the form.
$("email").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!$("code-btn").disabled) $("code-btn").click();
});

$("code").addEventListener("input", (e) => {
  const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== e.target.value) e.target.value = digits;
});

/* Step 2: start with the code. */

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const contact = contactDetails();
  if (!contact) return;
  if (state.codeEmail !== contact.email) return formError("Please send a code to this email address first.", "code-btn");
  const code = $("code").value.trim();
  if (!/^\d{6}$/.test(code)) return formError("Please enter the 6-digit code from the email.", "code");
  if (!$("consent").checked) return formError("Please tick the consent box to continue.", "consent");

  // Pressing Start again for the same email and code reuses the attempt ID, so if the first
  // try reached the server but its answer got lost, the server hands back the same session.
  const key = `${contact.email}|${code}`;
  if (state.attempt?.key !== key) state.attempt = { key, id: newId() };

  const btn = $("start-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  const res = await call({
    action: "start", ...contact, consent: true, hp: $("website").value,
    code, attemptId: state.attempt.id,
  });
  btn.disabled = false;
  btn.textContent = "Start the quiz";

  if (!res.ok) {
    if (res.error === "INVALID_CODE") return formError(ERRORS.INVALID_CODE, "code");
    if (res.error === "CODE_EXPIRED" || res.error === "TOO_MANY_ATTEMPTS") {
      $("code").value = "";
      return formError(ERRORS[res.error], $("code-btn").disabled ? "code" : "code-btn");
    }
    return formError(ERRORS[res.error] || ERRORS.NETWORK);
  }
  state.attempt = null;
  state.sessionId = res.sessionId;
  store.set(SESSION_KEY, res.sessionId);
  if (res.done) return showFinish(res);
  showQuestion(res, res.remaining ?? res.timeLimit);
});

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

function formError(msg, focusId) {
  $("form-error").textContent = msg;
  if (focusId) $(focusId).focus();
}

/* ---------- Resume ---------- */

async function resume(sessionId) {
  state.sessionId = sessionId;
  show("loading");
  const res = await call({ action: "resume", sessionId });
  if (!res.ok) {
    if (res.error === "INVALID_SESSION") {
      store.remove(SESSION_KEY);
      return showError("INVALID_SESSION", { retry: () => location.reload() });
    }
    if (res.error === "QUIZ_CLOSED") {
      store.remove(SESSION_KEY);
      return showError("QUIZ_CLOSED");
    }
    return showError(res.error, { retry: () => resume(sessionId) });
  }
  if (res.done) return showFinish(res);
  showQuestion(res, res.remaining);
}

/* ---------- Question view ---------- */

function showQuestion(res, secondsLeft) {
  const q = res.question;
  state.question = q;
  state.timeLimit = res.timeLimit;
  state.submitting = false;
  state.warned = new Set();

  $("q-progress").textContent = `Question ${res.index} of ${res.total}`;
  $("q-text").textContent = q.text;
  $("q-note").hidden = !q.star;
  $("q-saving").textContent = "";

  const options = $("q-options");
  const textForm = $("q-text-form");
  const input = $("q-input");
  const textarea = $("q-textarea");
  options.replaceChildren();

  if (q.type === "mcq") {
    textForm.hidden = true;
    options.hidden = false;
    q.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option";
      btn.dataset.value = opt;
      const key = document.createElement("span");
      key.className = "option-key";
      key.textContent = String.fromCharCode(65 + i);
      key.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = opt;
      btn.append(key, label);
      btn.addEventListener("click", () => {
        btn.classList.add("chosen");
        submit(opt, false);
      });
      options.append(btn);
    });
  } else {
    options.hidden = true;
    textForm.hidden = false;
    input.hidden = !!q.star;
    textarea.hidden = !q.star;
    input.value = "";
    textarea.value = "";
    $("q-submit").disabled = false;
    input.disabled = textarea.disabled = false;
  }

  show("question");
  requestAnimationFrame(() => {
    if (q.type === "mcq") $("q-text").focus();
    else (q.star ? textarea : input).focus();
  });

  startTimer(Math.max(0, secondsLeft));
}

$("q-text-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submit(currentTextAnswer(), false);
});

$("q-textarea").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submit(currentTextAnswer(), false);
  }
});

// Keys A–D (or 1–4) pick an MCQ option.
document.addEventListener("keydown", (e) => {
  if ($("screen-question").hidden || state.question?.type !== "mcq" || state.submitting) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toUpperCase();
  let i = "ABCD".indexOf(k);
  if (i === -1) i = "1234".indexOf(k);
  const btn = $("q-options").children[i];
  if (i !== -1 && btn) btn.click();
});

function currentTextAnswer() {
  return state.question?.star ? $("q-textarea").value : $("q-input").value;
}

async function submit(answer, timedOut) {
  if (state.submitting) return;
  state.submitting = true;
  stopTimer();
  setInputsDisabled(true);
  $("q-saving").textContent = timedOut ? "Time's up! Saving…" : "Saving…";

  const res = await call({
    action: "answer",
    sessionId: state.sessionId,
    questionId: state.question.id,
    answer: String(answer ?? "").slice(0, 1000),
    timedOut,
  });

  if (!res.ok) {
    if (res.error === "INVALID_SESSION" || res.error === "QUIZ_CLOSED") {
      store.remove(SESSION_KEY);
      return showError(res.error);
    }
    // The server ignores a repeated answer, so resuming is safe after any failure.
    return showError(res.error, { retry: () => resume(state.sessionId) });
  }
  if (res.done) return showFinish(res);
  showQuestion(res, res.timeLimit);
}

function setInputsDisabled(disabled) {
  $("q-options").querySelectorAll("button").forEach((b) => { b.disabled = disabled; });
  $("q-input").disabled = disabled;
  $("q-textarea").disabled = disabled;
  $("q-submit").disabled = disabled;
}

/* ---------- Timer ---------- */

function startTimer(seconds) {
  stopTimer();
  state.deadline = performance.now() + seconds * 1000;
  tick();
  state.timerId = setInterval(tick, 200);
  const bar = $("timer-bar");
  const frame = () => {
    const left = Math.max(0, state.deadline - performance.now());
    bar.style.transform = `scaleX(${left / (state.timeLimit * 1000)})`;
    bar.classList.toggle("low", left <= 10000);
    if (left > 0) state.rafId = requestAnimationFrame(frame);
  };
  frame();
}

function tick() {
  const left = Math.max(0, Math.ceil((state.deadline - performance.now()) / 1000));
  $("q-seconds").textContent = `${left}s`;
  for (const w of WARN_AT) {
    if (left <= w && left > 0 && !state.warned.has(w) && state.timeLimit > w) {
      state.warned.add(w);
      $("sr-timer").textContent = `${w} seconds left`;
    }
  }
  if (left <= 0) {
    // Send whatever was typed. A scored question that times out gets 0; bonus-question text still earns the star.
    const answer = state.question?.type === "mcq" ? "" : currentTextAnswer();
    submit(answer, true);
  }
}

function stopTimer() {
  clearInterval(state.timerId);
  cancelAnimationFrame(state.rafId);
  state.timerId = 0;
  state.rafId = 0;
}

/* ---------- Optional Turnstile ---------- */

let turnstileWidget = null;

function setupTurnstile() {
  if (!TURNSTILE_SITE_KEY || turnstileWidget !== null) return;
  turnstileWidget = "loading";
  window.onTurnstileLoad = () => {
    turnstileWidget = window.turnstile.render("#turnstile", {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { state.turnstileToken = token; },
      "expired-callback": () => { state.turnstileToken = ""; },
    });
  };
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad";
  s.async = true;
  document.head.append(s);
}

function resetTurnstile() {
  if (window.turnstile && turnstileWidget && turnstileWidget !== "loading") {
    state.turnstileToken = "";
    window.turnstile.reset(turnstileWidget);
  }
}

init().catch((err) => {
  console.error(err);
  showError("NETWORK", { retry: () => location.reload() });
});
