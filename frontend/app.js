import { call } from "./api.js";
import { TURNSTILE_SITE_KEY } from "./config.js";

const SESSION_KEY = "n8nQuiz.sessionId";
const RESULT_KEY = "n8nQuiz.result";
const WARN_AT = [10, 5];

const $ = (id) => document.getElementById(id);

const ERRORS = {
  ALREADY_ATTEMPTED: "This email has already been used to take the quiz. Each email gets one attempt.",
  QUIZ_NOT_OPEN: "The quiz hasn't opened yet.",
  QUIZ_CLOSED: "The quiz has closed. Thanks for your interest!",
  INVALID_INPUT: "Please check your name and email, and tick the consent box.",
  INVALID_SESSION: "We couldn't find your quiz session. Please start again.",
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

  const res = await call({ action: "status" });
  renderLanding(res);
}

function renderLanding(status) {
  const pill = $("window-status");
  const form = $("signup-form");
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  form.hidden = false;
  pill.className = "status-pill";
  if (!status.ok) {
    pill.textContent = "";
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

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  const email = $("email").value.trim();
  const errorEl = $("form-error");
  errorEl.textContent = "";

  if (name.length < 2) return formError("Please enter your name.", "name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return formError("Please enter a valid email address.", "email");
  if (!$("consent").checked) return formError("Please tick the consent box to continue.", "consent");
  if (TURNSTILE_SITE_KEY && !state.turnstileToken) return formError("Please complete the check above the button.");

  const btn = $("start-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  const res = await call({
    action: "start", name, email, consent: true,
    hp: $("website").value, turnstileToken: state.turnstileToken || undefined,
  });
  btn.disabled = false;
  btn.textContent = "Start the quiz";

  if (!res.ok) {
    if (res.error === "INVALID_INPUT" || res.error === "ALREADY_ATTEMPTED") {
      resetTurnstile();
      return formError(ERRORS[res.error]);
    }
    return showError(res.error);
  }
  state.sessionId = res.sessionId;
  store.set(SESSION_KEY, res.sessionId);
  showQuestion(res, res.timeLimit);
});

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
