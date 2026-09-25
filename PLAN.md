# n8n Rapid-Fire Quiz: Implementation Plan

A timed online quiz about [n8n](https://n8n.io), shared through LinkedIn and hosted on Cloudflare at `https://quiz.vmugdha.in/`. It runs over two days and is open to anyone with the link. The only running cost is the Cloudflare Workers Paid plan ($5/month), which is needed to email sign-in codes.

Step-by-step setup instructions are in [`SETUP.md`](SETUP.md).

## 1. Requirements

- Participants sign up with a name and an email address, which they confirm with a 6-digit code sent to it. Each email gets one attempt.
- There is no limit on the number of participants.
- Each participant gets 11 questions, each on a timer:
  - 10 multiple-choice (MCQ) questions drawn at random from a bank of 30: 4 easy, 3 medium and 3 hard, in random order. Each correct answer is worth 1 point.
  - 1 bonus text question, asked last and drawn at random from a pool of bonus questions. Answering it earns a ★.
- The quiz moves to the next question when the participant answers or when the timer runs out.
- On finishing, participants see their score and star, for example "5 + ★", and a message to wait for the winner announcement on a given date and time. Nothing is described as provisional.
- After the quiz closes, the quizmaster replaces each ★ with 0 to 5 points based on the quality of the answer. Participants never see these points.
- The final total (correct answers plus star points) is private to the quizmaster, who uses it to choose the winners manually. The quizmaster decides ties.
- Personal data is deleted 30 days after the quiz closes.

## 2. Architecture

```
LinkedIn post ──► Cloudflare static assets: quiz.vmugdha.in (HTML/CSS/JS from frontend/)
                        │  fetch() POST, Content-Type: text/plain
                        ▼
              Google Apps Script web app (backend)
              - sign-in codes, question selection, timer checks, scoring
              - CacheService for fast session lookups and codes
                        │                         │
                        ▼                         ▼
              Google Sheet (private)      Cloudflare Email Sending
              Config | Questions |        (code emails from n8nquiz@vmugdha.in)
              Participants | Responses |
              Leaderboard | Summary
```

| Layer | Technology | Cost |
|---|---|---|
| Frontend hosting | Cloudflare static assets (Worker `n8n-quiz`, no code), deployed with `npx wrangler deploy` from the public `mugdhav/n8n-quiz-webapp` repo | Included |
| Backend | [Google Apps Script](https://developers.google.com/apps-script) web app, running as the quizmaster | Free |
| Database | Google Sheets | Free |
| Sign-in code emails | [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) (REST API, called from Apps Script) | Workers Paid, $5/month |
| Bot protection | [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) on "Send code" | Free |

**Security rule:** the answer key, question selection, timing and scoring all stay on the server. The browser only ever receives the current question, without its answer. The Sheet, including the Leaderboard, is never shared.

## 3. API contract

All requests are `POST` to the Apps Script `/exec` URL with a JSON body and the header `Content-Type: text/plain`. Using `text/plain` avoids the [CORS (Cross-Origin Resource Sharing)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) preflight request, which Apps Script does not support.

### `status`

Called when the page loads, so the landing screen can show "Quiz opens at …" or "closed" before anyone signs up.

```json
// Request
{ "action": "status" }

// Response. "state" is "not_open", "open" or "closed".
{ "ok": true, "state": "open", "startAt": "2026-09-21T03:30:00.000Z", "endAt": "2026-09-23T03:30:00.000Z" }
```

The page shows the rules and the sign-up form straight away and fills in the status when the reply arrives. The server checks the quiz window again on `requestCode` and `start`.

### `requestCode`

Emails a 6-digit sign-in code to the address.

```json
// Request. turnstileToken is sent when Turnstile is turned on.
{ "action": "requestCode", "name": "Asha Rao", "email": "asha@example.com", "hp": "", "turnstileToken": "..." }

// Response
{ "ok": true, "resendAfter": 60, "expiresInMinutes": 10 }
```

- The answer is the same when the email has already taken the quiz, but then no email is sent. The site never reveals who took part.
- Limits: one code every 60 seconds and 5 an hour for each email (`RESEND_TOO_SOON`), plus `CODE_MAX_PER_HOUR` across everyone (`CODE_LIMIT`). If sending fails, the answer is `EMAIL_FAILED`.
- Only a SHA-256 hash of the code is kept in the script cache, for `CODE_TTL_MINUTES`.
- `hp` is a hidden honeypot field. Real users leave it empty, and bots usually fill it in.

### `start`

```json
// Request. attemptId is created once per Start press and reused on retries.
{ "action": "start", "name": "Asha Rao", "email": "asha@example.com", "consent": true, "hp": "",
  "code": "482913", "attemptId": "uuid" }

// Success
{ "ok": true, "sessionId": "uuid", "index": 1, "total": 11, "timeLimit": 30,
  "question": { "id": "Q07", "type": "mcq", "text": "...", "options": ["A", "B", "C", "D"] } }
```

- The code must match the latest one sent to the email, before it expires. `CODE_MAX_ATTEMPTS` wrong tries are allowed. The code is deleted once it has been used.
- **A retried start is safe.** If the same `attemptId` arrives again (for example after a slow response timed out in the browser), the server returns the same session, with `remaining` seconds, instead of `ALREADY_ATTEMPTED`.

### `answer`

```json
// Request. On a timeout, send "timedOut": true with "" for MCQ, or whatever was typed for the bonus question.
{ "action": "answer", "sessionId": "uuid", "questionId": "Q07", "answer": "B", "timedOut": false }

// Next question. The bonus question arrives with "star": true and its own timeLimit.
{ "ok": true, "done": false, "index": 11, "total": 11, "timeLimit": 60,
  "question": { "id": "S03", "type": "text", "text": "...", "star": true } }

// Finished
{ "ok": true, "done": true, "score": 5, "maxScore": 10, "star": true,
  "message": "Fingers crossed! Wait for the winner announcement on 25 Sept at 6 PM IST." }
```

- If `Config.SHOW_SCORE` is `FALSE`, the finished response leaves out `score` and `star`.
- Sending the same answer twice (for example, a retry after a network error) is safe. The server returns the current state and doesn't score it again.

### `resume`

Used after a page reload. The `sessionId` is kept in `localStorage`.

```json
// Request
{ "action": "resume", "sessionId": "uuid" }

// Response: same shape as an answer response, plus "remaining": 12
```

`remaining` is the number of seconds left on the current question. The timer keeps running on the server during a reload, so reloading does not reset the clock.

### Errors

```json
{ "ok": false, "error": "ALREADY_ATTEMPTED" | "QUIZ_NOT_OPEN" | "QUIZ_CLOSED" | "INVALID_INPUT" | "INVALID_SESSION" | "BUSY"
  | "INVALID_CODE" | "CODE_EXPIRED" | "TOO_MANY_ATTEMPTS" | "RESEND_TOO_SOON" | "CODE_LIMIT" | "EMAIL_FAILED" }
```

The frontend retries `BUSY` and network errors up to 3 times, with a growing delay between attempts (backoff). It waits up to 30 seconds for each request, because Apps Script sometimes takes more than 15 seconds to start up.

## 4. Data model (Google Sheet tabs)

**Config** (key/value rows)

| Key | Default | Meaning |
|---|---|---|
| START_AT | 2026-09-21T09:00:00+05:30 | When the quiz opens. Set the real value before launch. |
| END_AT | 2026-09-23T09:00:00+05:30 | When the quiz closes. Set the real value before launch. |
| TIME_LIMIT | 30 | Seconds per MCQ question |
| STAR_TIME_LIMIT | 60 | Seconds for the bonus question |
| GRACE_SECONDS | 5 | Allowance for network delay |
| FINISH_GRACE_MINUTES | 10 | Minutes after `END_AT` that sessions already started may still finish |
| PICK_EASY / PICK_MEDIUM / PICK_HARD | 4 / 3 / 3 | Number of questions drawn at each difficulty |
| SHOW_SCORE | TRUE | Show "score + ★" on the finish screen |
| RESULTS_MESSAGE | Fingers crossed! Wait for the winner announcement on [DATE AND TIME]. | Text on the finish screen |

Config and Questions are cached for up to 1 and 5 minutes. After editing either tab during the event, run `clearCaches` in Apps Script to apply the change at once.

**Questions**

| id | type | difficulty | text | options | answer | accepted | active |
|---|---|---|---|---|---|---|---|
| Q01 | mcq | easy | Which node starts a workflow when an HTTP request arrives? | Webhook\|Schedule Trigger\|Edit Fields (Set)\|IF | Webhook | | TRUE |
| S01 | text | star | Describe your n8n experience in a sentence or two. … | | | | TRUE |

- Separate options with `|`.
- The bank has 30 MCQ questions (10 easy, 10 medium, 10 hard) and 6 bonus questions (`difficulty` = `star`).
- Setting `active` to `FALSE` stops a question being drawn. Participants who already have it can still answer it.
- The backend can also score short-text questions against the `accepted` list (separated with `|`), but the current bank doesn't use any.

**Participants:** `createdAt, sessionId, name, email, emailNorm, questionIds, currentIndex, servedAt, status (active/done), score, totalTimeSec, finishedAt, star`, then the formula column `finalScore`.

- `score` is the number of correct answers, which the participant sees.
- `servedAt` is a millisecond timestamp.
- `finalScore` adds up `finalPoints` from Responses. Only the quizmaster sees it.

**Responses:** `timestamp, sessionId, email, index, questionId, answer, correct, timeTakenSec, late, kind, reviewPoints`, then the formula column `finalPoints`.

- `kind` is `scored` or `star`.
- `correct` is 1 or 0. It is always 0 on the star row.
- `reviewPoints` is empty until the quizmaster types 0 to 5 on a star row. The Sheet rejects other values.
- `finalPoints` is `correct` on scored rows, and `reviewPoints` (0 while empty) on star rows.

**Leaderboard** (private): finished participants sorted by `finalScore`, highest first, showing `correct`, `star`, `totalTimeSec` and `finishedAt` for reference.

**Summary:** attempts started and finished, average correct answers, stars earned, stars not yet reviewed, average final score, late answers, and accuracy for each question (hardest first).

### Scoring rules

- MCQ: 1 point for an exact match on the option. A timeout or a late answer (arriving after `TIME_LIMIT + GRACE_SECONDS` from `servedAt`) scores 0.
- Bonus question: any text received in time earns the ★, including text sent automatically when the timer runs out. An empty or late answer earns no star.
- Shown to the participant: correct answers out of 10, plus ★ if earned.
- Final total (private): correct answers plus the quizmaster's 0 to 5 points for the star answer. The quizmaster chooses the winners and decides ties.

## 5. Work breakdown

### Phase 0: Decisions and contract

- **T0.1** API contract (section 3) and data model (section 4). Done.
- **T0.2** Decisions (section 9). Done.

### Phase 1: Build

| Track | Task | Output | Owner |
|---|---|---|---|
| **A: Content** | A1. 30 MCQ questions (10 easy, 10 medium, 10 hard) plus 6 bonus questions | `content/questions.csv` | Claude drafted |
| | A2. Review questions and answers | Reviewed CSV | You |
| **B: Backend** | B1. `setup()`: tabs, headers, Config defaults, review formulas, 0–5 check, Leaderboard and Summary | `backend/Code.gs` | Claude |
| | B2. `doPost` router, input validation, honeypot, quiz window check | | Claude |
| | B3. `start`: email deduplication, stratified random pick, one random bonus question, session creation | | Claude |
| | B4. `answer` and `resume`: timer check, scoring, star, next question, finishing | | Claude |
| | B5. `LockService` around writes; CacheService session cache | | Claude |
| | B6. Test functions you can run from the Apps Script editor | `backend/Tests.gs` | Claude |
| **C: Frontend** | C1. Screens: landing and rules, sign-up form with consent, question view, bonus question, finish, error | `frontend/index.html`, `style.css` | Claude |
| | C2. Quiz engine: timer, auto-advance, disable input on submit, `resume` from localStorage | `frontend/app.js` | Claude |
| | C3. API client with retry, plus a mock backend with sample questions | `frontend/api.js`, `frontend/mock.js` | Claude |
| | C4. Mobile layout and accessibility | | Claude |
| **D: Sheet ops** | D1. Leaderboard, Summary and review formulas | Formulas in `setup()` | Claude |
| **E: Launch assets** | E1. Privacy notice and quiz rules | `frontend/privacy.html` | Claude drafted, you approve |
| | E2. LinkedIn posts and link preview image | `launch/linkedin-post.md`, `frontend/og-image.png` | Claude drafted, you approve |

### Phase 2: Integration

- **T2.1** Deploy the backend and load the question bank (`SETUP.md` part 2).
- **T2.2** Point `frontend/config.js` at the `/exec` URL and turn off the mock (`SETUP.md` part 3).
- **T2.3** Test the whole flow: normal run, bonus question, timeouts, reload in the middle of the quiz, duplicate email, quiz closed, late answer.

### Phase 3: Verification (`SETUP.md` part 5)

| Task | Can run in parallel with |
|---|---|
| **V1** Dry run with 3 to 5 friends on different phones and browsers | V2, V3 |
| **V2** Load test: 50 simultaneous `start` requests, checking for no lost or duplicated rows | V1, V3 |
| **V3** Security check: no answers in network responses, timer manipulation rejected, honeypot works | V1, V2 |
| **V4** Clear the test data and set the real `START_AT`, `END_AT` and `RESULTS_MESSAGE` | Runs after V1 to V3 |

### Phase 4: Launch and event (`SETUP.md` parts 6 and 7)

- Publish the LinkedIn launch post when the quiz opens, and the reminder on day two.
- Check the Summary tab and Apps Script **Executions** a few times a day.
- The quiz closes automatically at `END_AT`.

### Phase 5: After the event (`SETUP.md` parts 8 and 9)

- Score each ★ with 0 to 5 points in Responses.
- Choose the winners from the private Leaderboard, decide any ties, and contact the winners by email.
- Publish the winner announcement at the date and time promised on the finish screen.
- Delete personal data 30 days after the quiz closes.

### Dependency graph

```
T0 ──┬── A (content) ──────────────┐
     ├── B (backend) ──────────────┤
     ├── C (frontend, with mock) ──┼──► T2 integration ──► V1 ┐
     ├── D (sheet formulas) ───────┤                     V2 ├──► V4 ──► Launch ──► Post-event
     └── E (launch assets) ────────┘                     V3 ┘
```

## 6. Setup instructions

See [`SETUP.md`](SETUP.md). It covers placeholders, the Google Sheet and Apps Script backend, testing on your computer, GitHub Pages, pre-launch testing, launch, running the event, scoring stars and choosing winners, data deletion, and optional Turnstile.

## 7. Repository layout

```
quizz-solution/
├── PLAN.md
├── SETUP.md             # step-by-step setup and running guide
├── backend/
│   ├── Code.gs          # doPost, status/start/answer/resume, scoring, setup(), clearCaches()
│   └── Tests.gs         # runAllTests()
├── .gitignore           # keeps content/questions.csv (the answers) out of the public repo
├── wrangler.jsonc       # publishes frontend/ to quiz.vmugdha.in (npx wrangler deploy)
├── frontend/            # the only folder published (quiz.vmugdha.in)
│   ├── _headers         # security headers (CSP, HSTS), applied by Cloudflare
│   ├── index.html
│   ├── privacy.html
│   ├── style.css
│   ├── config.js        # API_URL, USE_MOCK, TURNSTILE_SITE_KEY
│   ├── api.js           # fetch + retry
│   ├── mock.js          # local mock backend with sample questions
│   ├── app.js           # screens, timer, flow
│   └── og-image.png     # 1200×627 link preview for LinkedIn
├── content/
│   └── questions.csv    # contains the answers; gitignored, never published
└── launch/
    └── linkedin-post.md # launch post, reminder, winner announcement
```

## 8. Limits and risks

| Risk | Mitigation |
|---|---|
| Apps Script handles about 30 requests at the same moment | Each request takes under a second. The client retries `BUSY` and network errors with backoff. If traffic grows well beyond this, move the backend to Cloudflare Workers + D1 (Cloudflare's SQL database); the frontend stays the same apart from `API_URL`. |
| Slow responses (measured 1.9 to 20 seconds per call on 2026-09-24, mostly Apps Script starting up, plus a redirect to `script.googleusercontent.com`) | The frontend timer starts when a question is shown, and the server allows `GRACE_SECONDS` of extra time. The landing page no longer waits for `status`. Preconnect hints, a 30-second request timeout and safe `start` retries help too. Each `start` and `answer` logs its step timings to **Executions**. Removing the Apps Script wait completely means moving the backend to Cloudflare Workers + D1. |
| Fake or throwaway emails | An emailed 6-digit code proves the participant owns the address. There's also one attempt per email, a honeypot field, Turnstile on "Send code", and manual checks of winners. |
| Someone uses up another person's attempt | Not possible without access to that inbox, because of the code. The site gives the same answer whether or not an email has already been used. |
| The "Send code" button is abused to send email | Turnstile, limits per email (1 a minute, 5 an hour), and a cap per hour across everyone (`CODE_MAX_PER_HOUR`). |
| Answers leaking to the browser | The server never sends `answer` or `accepted`. Check this in V3. |
| Star points or rankings leaking | They exist only in the private Sheet. The API never returns `finalScore`, `reviewPoints` or rank. |
| Two people writing at the same moment | `LockService` around every write. |
| Someone edits the Sheet during the event | Use filter views instead of sorting, and don't insert or delete columns. Answers check the stored row before writing. |
| Personal data | Consent checkbox, privacy notice, and deletion 30 days after the event. |

## 9. Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Show the score | Yes, on the finish screen as "score + ★", with no "provisional" wording |
| 2 | Scoring | 10 MCQ questions at 1 point each. The bonus text question earns a ★, which the quizmaster later turns into 0 to 5 hidden points. |
| 3 | Winners and prizes | Chosen manually by the quizmaster from the private final totals, who also decides ties. Prizes aren't shown to participants after the quiz. Winners are announced at the date and time in `RESULTS_MESSAGE`. |
| 4 | Window | Two days, open to anyone with the link. Exact dates still to be set in Config, `privacy.html` and the LinkedIn post. |
| 5 | Location | Works either as a folder on an existing Pages site or as a separate repository (all paths are relative) |
| 6 | Data retention | 30 days after the quiz closes |

## 10. Build status

| Task | Status | Checked by |
|---|---|---|
| A1 Question bank | Drafted: 30 MCQ (10/10/10) and 6 bonus questions | Structure check: 4 options each, answer among the options, positions spread across A to D. **A2 still needs your review.** |
| B1–B6 Backend | Done | `runAllTests`: 19 of 19 pass in a local simulation of Apps Script. Sheet formulas need checking in real Google Sheets (`SETUP.md` part 3). |
| C1–C4 Frontend | Done | Headless Chrome at phone width against `mock.js`: 16 of 16 checks pass |
| Email codes, faster page load, safe `start` retries, step timings (2026-09-24) | Done | `runAllTests`: 25 of 25 pass in a local simulation of Apps Script. Headless Chrome at 375 px against `mock.js` with the `_headers` CSP applied: 19 of 19 checks pass. **Still to do:** run `runAllTests` in real Apps Script, set up Cloudflare email sending (`SETUP.md` 2.8), and do a real run with your own inbox. |
| D1 Sheet formulas | Done | Created by `setup()` |
| E1 Privacy and rules | Drafted, with highlighted placeholders to fill in | — |
| E2 LinkedIn posts and preview image | Drafted | — |
| T2, V1–V4, launch | Not started | Needs your Google and GitHub accounts (`SETUP.md`) |
