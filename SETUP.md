# Setup Guide: n8n Rapid-Fire Quiz

This guide takes you from the files in this folder to a live quiz, then through running it and closing it down. Follow the parts in order. Plan for about 1.5 hours before launch, plus time for a dry run with friends.

| Part | What you do | Time |
|---|---|---|
| 1 | Fill in the placeholders | 15 min |
| 2 | Create the Google Sheet and the backend | 20 min |
| 3 | Connect the frontend and test it on your computer | 15 min |
| 4 | Publish at quiz.vmugdha.in on Cloudflare | 10 min |
| 5 | Test before launch | 30 min, plus the dry run |
| 6 | Launch | 10 min |
| 7 | Run the quiz over the two days | A few checks a day |
| 8 | Score the stars and choose the winners | Your call |
| 9 | Delete the data after 30 days | 5 min |

**How scoring works:** each participant gets 10 timed multiple-choice questions, worth 1 point each for a correct answer, then 1 timed bonus text question. Answering the bonus question earns a ★. At the end they see, for example, "5 + ★". After the quiz closes, you replace each ★ with 0 to 5 points based on the quality of the answer. The resulting total decides the winners, and you settle any ties yourself.

**What stays private:** the Google Sheet, including the Leaderboard, Summary, your star points and the final totals, is visible only to you. Participants only ever see their questions and "score + ★". Don't share the Sheet or publish it to the web.

---

## Part 1: Fill in the placeholders

Decide the start and end times first. The quiz runs over two days.

| File | What to change |
|---|---|
| `frontend/privacy.html` | Every highlighted `[…]` placeholder: the date, your name, how to contact you, the start and end times with time zone, and the winner announcement date and time. Then delete the `<span class="todo">` and `</span>` tags around each one. |
| `frontend/index.html` | The two `og:` lines near the top point to `https://quiz.vmugdha.in/`. Change them only if the quiz moves (see Part 4). LinkedIn needs the full address for the link preview. |
| `launch/linkedin-post.md` | The link and the `[…]` date placeholders. |
| `content/questions.csv` | This file holds the answers, so it is listed in `.gitignore` and never goes into the repository. Keep it on your computer and in the Sheet only. Review the 30 multiple-choice questions (Q01–Q30) and their answers. Edit anything that doesn't match the n8n version your audience uses. Check Q10 ("Activate (publish)") and Q02 (the license question) in particular. Then review the 6 bonus questions (S01–S06), and add or change them as you like. |

The preview image `frontend/og-image.png` says "TWO-DAY QUIZ" and "10 questions · 30 seconds each · bonus ★". It has no dates, so it doesn't need changing.

---

## Part 2: Create the Google Sheet and the backend

The backend is a [Google Apps Script](https://developers.google.com/apps-script) project attached to a Google Sheet. The Sheet is the database.

### 2.1 Create the Sheet

1. Go to [sheets.new](https://sheets.new) while signed in to the Google account you want to own the quiz data.
2. Name the file `n8n Quiz – Data`.
3. Open **File → Settings** and set **Time zone** to your time zone, for example `(GMT+05:30) India Standard Time`. Click **Save settings**.

### 2.2 Add the code

1. In the Sheet, open **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
2. Delete everything in `Code.gs`. Open `backend/Code.gs` from this folder, copy all of it, and paste it in.
3. Click **+** next to **Files**, choose **Script**, and name it `Tests`. Apps Script adds the `.gs` extension. Paste in all of `backend/Tests.gs`.
4. Click the project name at the top (it says "Untitled project") and rename it to `n8n Quiz Backend`.
5. Click the **Save** icon.
6. Open **Project Settings** (the gear icon on the left). Set **Time zone** to the same zone as the Sheet.

### 2.3 Run setup

1. Go back to the **Editor** (the `< >` icon on the left).
2. In the function dropdown at the top, choose `setup`, then click **Run**.
3. The first time, Google asks for permission:
   1. Click **Review permissions** and choose your account.
   2. You see "Google hasn't verified this app". This is expected, because it's your own script. Click **Advanced**, then **Go to n8n Quiz Backend (unsafe)**.
   3. Click **Allow**. The script asks to see and edit **only this spreadsheet** (the `@OnlyCurrentDoc` line at the top of `Code.gs` limits it) and to connect to an external service (Cloudflare, for the code emails and Turnstile).
4. Wait for "Execution completed" in the log.
5. Go back to the Sheet. It now has these tabs: **Config**, **Questions**, **Participants**, **Responses**, **Leaderboard** and **Summary**.

### 2.4 Load the questions

1. Click the **Questions** tab.
2. Open **File → Import → Upload** and choose `content/questions.csv`.
3. Set **Import location** to **Replace current sheet**, and leave **Convert text to numbers, dates, and formulas** ticked. Click **Import data**.
4. Check the result:
   - Row 1 is the headers: `id, type, difficulty, text, options, answer, accepted, active`.
   - There are 36 questions: Q01 to Q30 (multiple choice, 10 each at `easy`, `medium` and `hard`), then S01 to S06 (bonus questions, difficulty `star`).
   - The `active` column says `TRUE` on every row.

Each participant gets 4 easy, 3 medium and 3 hard questions in random order, then one bonus question drawn at random from the `star` rows.

- **To add a bonus question:** add a row with a new `id` (for example `S07`), `type` = `text`, `difficulty` = `star`, your question in `text`, and `active` = `TRUE`. Leave `options`, `answer` and `accepted` empty.
- **To leave a question out without deleting it:** set its `active` value to `FALSE`. Keep at least 4 active easy questions, 3 medium, 3 hard and 1 star.

### 2.5 Set the Config

Click the **Config** tab. `setup` has filled in defaults. Change the values in column B:

| Key | What to enter |
|---|---|
| `START_AT` | For now, a time **in the past**, so you can test. For example `2026-09-01T09:00:00+05:30`. You set the real time in Part 6. |
| `END_AT` | For now, a time a few days in the future. |
| `SHOW_SCORE` | `TRUE`. Participants see "score + ★" at the end. |
| `RESULTS_MESSAGE` | The text under the score. Replace `[DATE AND TIME]` with the winner announcement date and time, for example `Fingers crossed! Wait for the winner announcement on 25 Sept at 6 PM IST.` |
| `STAR_TIME_LIMIT` | Seconds for the bonus question. The default is 60, because it needs typing. Set it to `30` to match the other questions. |

`CODE_TTL_MINUTES` (10), `CODE_MAX_ATTEMPTS` (5) and `CODE_MAX_PER_HOUR` (300) control the emailed sign-in codes: how long a code works, how many wrong tries are allowed, and how many codes can go out per hour in total. The hourly cap is a safety net: if it's reached, new sign-ups see "try again in a few minutes". If you run `setup` on an existing Sheet, it adds these keys.

Leave the other keys as they are unless you want to change the timings. Write dates exactly in this form: `YYYY-MM-DDTHH:MM:SS+05:30`. The `+05:30` is the time zone offset for India, so change it if you're in a different zone.

### 2.6 Run the tests

1. In Apps Script, choose `runAllTests` in the function dropdown and click **Run**.
2. Open the **Execution log**. The last line should say `ALL 25 TESTS PASSED`. The tests don't send real emails or check Turnstile. The log also shows one `Code email failed: simulated send failure` line, which is expected.
3. The tests add rows to Participants and Responses and delete them again at the end. Check that both tabs contain only their header row.

If a test fails, copy the log and send it to Claude.

### 2.7 Deploy the web app

1. Click **Deploy → New deployment**.
2. Click the gear icon next to **Select type** and choose **Web app**.
3. Set these:
   - **Description:** `v1`
   - **Execute as:** **Me**. The script runs with your access, so participants never get access to the Sheet.
   - **Who has access:** **Anyone**. This lets the quiz page call it without a Google sign-in.
4. Click **Deploy**, and approve permissions again if asked.
5. Copy the **Web app URL**. It ends in `/exec`.
6. Paste that URL into a new browser tab. You should see `{"ok":true,"service":"n8n-quiz"}`.

> **When you change the code later:** use **Deploy → Manage deployments**, click the pencil icon, set **Version** to **New version**, and click **Deploy**. This keeps the same URL. **New deployment** would create a new URL, and the quiz page would stop working until you updated it.

### 2.8 Set up the sign-in code emails

Before the quiz starts, each participant gets a 6-digit code by email, sent from `n8nquiz@vmugdha.in` through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/). The code proves the email address belongs to them, so nobody can use up someone else's attempt. Sending to any address needs the **Workers Paid** plan ($5/month, 3,000 emails a month included).

Your domain's DNS is already on Cloudflare, so you don't need to change anything at BigRock. In the [Cloudflare dashboard](https://dash.cloudflare.com/):

1. **Upgrade to Workers Paid**, if you haven't already.
2. **Compute & AI → Email Service → Email Sending → Onboard Domain**, choose `vmugdha.in`, and click **Add records and onboard**. Cloudflare adds locked records for the bounce address `cf-bounce.vmugdha.in`: three MX records, an SPF TXT record, and a DKIM TXT record at `cf-bounce._domainkey.vmugdha.in`. The root domain keeps its own MX and SPF records for Email Routing. There's one SPF record per name, which is correct, so leave both.
3. **DMARC:** each name can have only **one** `_dmarc` TXT record, so edit the existing record rather than adding another. With `v=DMARC1; p=reject; rua=mailto:contact@vmugdha.in`, inboxes reject email that pretends to be from `vmugdha.in`, and you get reports. The code emails pass, because Cloudflare signs them for `vmugdha.in`. Keep `p=reject` only if Cloudflare is the only service that sends as `@vmugdha.in`. If you also send as `contact@vmugdha.in` from Gmail or anything else, use `p=none` until that service is set up to sign for the domain too.
4. **Email Routing → Routing rules → Create address:** `n8nquiz@vmugdha.in` → your own inbox, so replies reach you.
5. **Create an API token:** **My Profile → API Tokens → Create Token → Custom token**. Give it the account permission for Email Sending (send) and nothing else. Copy the token.
6. Copy your **Account ID**. It's on the right of the account's home page.
7. In Apps Script, open **Project Settings → Script properties** and add:
   - `CF_EMAIL_TOKEN`: the token
   - `CF_ACCOUNT_ID`: the account ID
8. Send yourself a test email. From a terminal:
   ```bash
   npx wrangler email sending send --from n8nquiz@vmugdha.in --to YOUR-OWN-EMAIL --subject "Test" --text "Test"
   ```
   Check that it arrives in your inbox and not in spam. New Cloudflare accounts start with a low daily sending limit that grows over time, so do this well before launch.
9. Set up Turnstile (see "Turnstile" at the end of this guide). It's needed now. Without it, a bot could use the public "Send code" button to make your domain email strangers.

If sending fails, participants see "We couldn't send a code to this address". The reason appears under **Apps Script → Executions**, as a `Code email failed` line.

---

## Part 3: Connect the frontend and test it on your computer

### 3.1 Point the frontend at the backend

Open `frontend/config.js` and change the first two settings:

```js
export const API_URL = "https://script.google.com/macros/s/PASTE-YOUR-ID/exec";
export const USE_MOCK = false;
```

`USE_MOCK` switches off the built-in practice backend (`mock.js`), which uses sample questions.

### 3.2 Run it on your computer

The page must be served over HTTP. Opening `index.html` directly from File Explorer doesn't work. In a terminal, in the `quizz-solution` folder, run:

```bash
python -m http.server 8000 --directory frontend
```

Open [http://localhost:8000](http://localhost:8000).

### 3.3 Do a full run

1. The landing page appears at once with "Checking whether the quiz is open…", which then changes to a green "Open now" label.
2. Enter your own name and email and click **Send code**. The code arrives from `n8nquiz@vmugdha.in` within a minute. Enter it, tick the consent box, and click **Start the quiz**. Answer all 11 questions. The last one is marked "★ Bonus question".
3. Reload the page on one question. The quiz should continue on the same question, and the timer shouldn't restart.
4. Let one question time out.
5. In the Sheet, check that:
   - **Participants** has your row, with `status` set to `done`.
   - **Responses** has 11 rows for your session. `kind` (column J) is `scored` on 10 of them and `star` on the last.
   - The finish screen showed your score, with `+ ★` if you answered the bonus question, and the announcement message.
   - **Leaderboard** lists you.
6. Clear the site data (or use a private window), go back to the landing page, and try the same email again. **Send code** says a code was sent, but no email arrives, and **Start the quiz** says the code has expired. This is deliberate: the site never reveals whether an email has already taken part.

To try the page without the backend, set `USE_MOCK = true` in `config.js`. The mock prints the code in the browser console (**F12 → Console**) instead of emailing it.

Stop the local server with **Ctrl+C**.

---

## Part 4: Publish at quiz.vmugdha.in on Cloudflare

The quiz is hosted on Cloudflare as a static site: a Worker named `n8n-quiz` with no code, only the files in `frontend/`. `wrangler.jsonc` in the repository root sets this up and claims the custom domain `quiz.vmugdha.in`. Cloudflare serves the site, and your computer is used only to upload the files. Your main site (`mugdhav.github.io`, served at `www.vmugdha.in`) doesn't change.

**To publish or update the site**, from the `quizz-solution` folder, run:

```bash
npx wrangler deploy
```

It uploads the changed files in a few seconds. The first run creates the `quiz.vmugdha.in` DNS record and HTTPS certificate. If wrangler asks you to sign in, run `npx wrangler login` first.

> **Automatic deploys on every push (optional):** in the dashboard, go to **Workers & Pages → n8n-quiz → Settings → Build → Connect** and choose `mugdhav/n8n-quiz-webapp`. Leave the build command empty and the deploy command as `npx wrangler deploy`. If this fails with "Permission group … not found", create a token from the **Edit Cloudflare Workers** template under **My Profile → API Tokens**, and choose it as the build's API token.

1. After a deploy, open `https://quiz.vmugdha.in/`. If your computer still says the site can't be found, its DNS cache is out of date: run `ipconfig /flushdns` or wait a few minutes.
2. `frontend/_headers` gives the quiz its security headers: a content security policy that allows only the Apps Script backend and Turnstile, HTTPS-only, and no framing by other sites. After the first deploy, open the quiz, press **F12**, and check that the **Console** shows no "Content Security Policy" errors.
3. Old links: a rule under **Rules → Redirect Rules** for `vmugdha.in` sends `www.vmugdha.in/n8n-quiz*` (Hostname equals `www.vmugdha.in` and URI Path starts with `/n8n-quiz`), redirecting (302 during the quiz, 301 afterwards) to `https://quiz.vmugdha.in/`. Once it works, delete the old `n8n-quiz/` folder from the `mugdhav.github.io` repository.

Only `frontend/` is published. The repository is public, but `content/questions.csv` (the answers) is in `.gitignore` and never goes into it. Check that `https://quiz.vmugdha.in/content/questions.csv` returns "not found".

If the address changes, update the `og:` tags in `index.html` and push again.

---

## Part 5: Test before launch

### 5.1 Dry run with friends

Ask 3 to 5 people to take the quiz on different phones and browsers, for example iPhone Safari, Android Chrome and a laptop. Ask them to:

- Open the link from inside the LinkedIn app, because most participants will.
- Reload the page once in the middle.
- Tell you anything confusing or broken.

### 5.2 Check that no answers reach the browser

1. On a laptop, open the live quiz and press **F12** to open the browser's developer tools. Click the **Network** tab.
2. Start the quiz and answer a few questions.
3. Click the `exec` requests and look at the **Response** tab. You should see question text and options, but never the words `"answer"` with a value or `"accepted"`.

### 5.3 Optional: check it handles a rush

Apps Script handles about 30 requests at the same moment. Signing up now needs a code emailed to a real inbox, so don't load-test `start` or `requestCode` with made-up addresses: emails that bounce harm your domain's sending reputation. Instead, check how the backend copes with 50 requests at once. Open the live quiz, press **F12**, click **Console**, paste this and press **Enter**:

```js
const url = "PASTE-YOUR-EXEC-URL";
const t0 = performance.now();
const runs = Array.from({ length: 50 }, () => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: JSON.stringify({ action: "status" }),
}).then((r) => r.json()).then((x) => ({ ok: x.ok, ms: Math.round(performance.now() - t0) })));
Promise.all(runs).then((r) => console.table(r));
```

Every row should say `ok: true`. The `ms` column shows how long people would wait at a busy moment. The dry run with friends (5.1) covers several people answering at the same time.

### 5.4 Clear the test data

1. In **Participants** and **Responses**, select the test rows from **row 2 downwards**, right-click and choose **Delete rows**.
   - Don't delete row 1, because the headers and the `finalScore` and `finalPoints` formulas are in it.
   - Don't delete or insert columns.
2. In Apps Script, run `clearCaches`. Test emails are remembered for up to 6 hours, so without this step your own email stays blocked.

---

## Part 6: Launch

1. In **Config**, set the real `START_AT` and `END_AT`.
2. In Apps Script, run `clearCaches`. Otherwise, Config changes take up to 1 minute to apply.
3. Open the live quiz on your phone before the start time. It should say "Quiz opens at …" and hide the sign-up form.
4. Paste the quiz link into the [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) and check the preview image and title.
5. When the quiz opens, publish the launch post from `launch/linkedin-post.md`.

---

## Part 7: Run the quiz over the two days

**Check a few times a day:**

- **Summary** tab: attempts started and finished, and average scores.
- **Apps Script → Executions** (the list icon on the left): look for failed runs and `Code email failed` lines. A few `BUSY` responses at busy moments are normal. Each `start` and `answer` also logs one `{"timing": …}` line with the milliseconds spent on each step (waiting for the lock, reading the session, writing rows, `flush`). If `flush` or the writes regularly take more than about 500 ms, the Sheet formulas are slowing answers down.

**Work safely in the Sheet while the quiz is live:**

- To sort or filter, use **Data → Create a filter view**. Don't sort the Participants or Responses tabs themselves.
- Don't insert, delete or move columns in Participants or Responses.
- After editing **Config** or **Questions**, run `clearCaches`.

**If something goes wrong:**

| Problem | What to do |
|---|---|
| You need to close the quiz early | Set `END_AT` to the current time and run `clearCaches`. People already in the middle of the quiz get 10 more minutes to finish (`FINISH_GRACE_MINUTES`). |
| A question has a mistake | Set its `active` value to `FALSE` and run `clearCaches`. New participants won't get it. Anyone who already has it keeps their result for it. |
| Bots are asking for codes | Check that Turnstile is on (see "Turnstile" at the end of this guide). Lower `CODE_MAX_PER_HOUR` in Config and run `clearCaches`. |
| Someone says the code never arrived | Ask them to check spam and wait a minute before clicking **Resend code**. Check **Executions** for `Code email failed`, and the Cloudflare dashboard's **Email Sending** activity. |
| Someone asks for their data to be deleted | Delete their rows in Participants and Responses. Search for their email with **Ctrl+F**. |

The quiz closes by itself at `END_AT`.

---

## Part 8: Score the stars and choose the winners

Do this after the quiz closes.

### 8.1 Give points for stars

Each ★ is worth 0 points until you score it.

1. Open **Responses** and choose **Data → Create a filter view**.
2. Filter the `kind` column (J) to show only `star`.
3. For each row, read the bonus answer in `answer` (F). The question is in `questionId` (E); look it up in the **Questions** tab.
4. In `reviewPoints` (K), type a number from **0 to 5** based on the quality of the answer. The Sheet refuses anything else.
   - Rows where `late` (I) is `TRUE`, or `answer` is empty, didn't earn a star. You can leave them empty.
   - Values typed on `scored` rows are ignored.
5. `finalPoints` (L) updates by itself: correct answers are 1 point each, and star rows count your review points.

The **Summary** tab shows **Stars not yet reviewed**, so you can see how many are left.

### 8.2 Read the Leaderboard

The **Leaderboard** tab updates by itself. It lists finished participants, highest `finalScore` first. The columns are:

| Column | Meaning |
|---|---|
| `finalScore` | Correct answers plus your star points. Use this to choose the winners. |
| `correct` | Correct answers out of 10. This is the number the participant saw. |
| `star` | `TRUE` if they earned a ★. |
| `totalTimeSec` | Total time on the 10 scored questions. For your information, if it helps you settle a tie. |

You decide ties however you choose. Participants never see `finalScore`, your star points or the Leaderboard.

### 8.3 Announce the winners

Choose the winners from the Leaderboard. Contact them by email yourself, because nothing is sent automatically. Then announce them on the date and time you gave in `RESULTS_MESSAGE` and the privacy page. `launch/linkedin-post.md` has a template for the announcement post.

---

## Part 9: Delete the data after 30 days

The privacy notice promises deletion 30 days after the quiz closes. Put a reminder in your calendar now.

On that date:

1. Export a copy if you need one, using **File → Download**. Store it securely, because it contains personal data.
2. In **Participants** and **Responses**, delete every row from row 2 down. Keep row 1.
3. In Apps Script, open **Deploy → Manage deployments**, select the deployment, and click **Archive**. The quiz page then stops working, so replace `frontend/index.html` with a "This quiz has closed" page and run `npx wrangler deploy`, or delete the `n8n-quiz` Worker in the Cloudflare dashboard.

Any exported copy counts too. Delete it at the same time, or update the privacy notice to say how long you keep it.

---

## Turnstile

[Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) is a free check that tells people and bots apart. It protects the **Send code** button, so bots can't use it to make your domain email strangers. Set it up before launch.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Turnstile → Add widget**. Add the hostname `quiz.vmugdha.in`, plus `localhost` for testing.
2. Copy the **site key** into `TURNSTILE_SITE_KEY` in `frontend/config.js`, then push to GitHub.
3. Copy the **secret key**. In Apps Script, open **Project Settings → Script properties → Add script property**, name it `TURNSTILE_SECRET`, and paste the key.
4. No redeploy is needed. The backend checks the Turnstile token every time a code is requested.

---

## Quick reference

| Task | Where |
|---|---|
| Change dates or settings | Config tab, then run `clearCaches` |
| Turn a question off | Questions tab: set `active` to `FALSE`, then run `clearCaches` |
| Update the backend code | Apps Script: **Deploy → Manage deployments → pencil → New version** |
| See errors and step timings | Apps Script: **Executions** |
| Code email settings | Apps Script: **Project Settings → Script properties** (`CF_EMAIL_TOKEN`, `CF_ACCOUNT_ID`, `TURNSTILE_SECRET`) |
| Publish frontend changes | Push to `main`, then run `npx wrangler deploy` |
| Score the stars | Responses tab: filter `kind` = `star`, enter 0–5 in `reviewPoints` |
| Rankings | Leaderboard tab (private) |
| Statistics | Summary tab |
