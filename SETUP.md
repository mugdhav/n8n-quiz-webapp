# Setup Guide: n8n Rapid-Fire Quiz

This guide takes you from the files in this folder to a live quiz, then through running it and closing it down. Follow the parts in order. Plan for about 1.5 hours before launch, plus time for a dry run with friends.

| Part | What you do | Time |
|---|---|---|
| 1 | Fill in the placeholders | 15 min |
| 2 | Create the Google Sheet and the backend | 20 min |
| 3 | Connect the frontend and test it on your computer | 15 min |
| 4 | Publish on GitHub Pages | 10 min |
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
| `frontend/index.html` | In the two `og:` lines near the top, replace `https://<username>.github.io/n8n-quiz/` with the address where the quiz will live (see Part 4). LinkedIn needs the full address for the link preview. |
| `launch/linkedin-post.md` | The link and the `[…]` date placeholders. |
| `content/questions.csv` | Review the 30 multiple-choice questions (Q01–Q30) and their answers. Edit anything that doesn't match the n8n version your audience uses. Check Q10 ("Activate (publish)") and Q02 (the license question) in particular. Then review the 6 bonus questions (S01–S06), and add or change them as you like. |

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
   3. Click **Allow**.
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

Leave the other keys as they are unless you want to change the timings. Write dates exactly in this form: `YYYY-MM-DDTHH:MM:SS+05:30`. The `+05:30` is the time zone offset for India, so change it if you're in a different zone.

### 2.6 Run the tests

1. In Apps Script, choose `runAllTests` in the function dropdown and click **Run**.
2. Open the **Execution log**. The last line should say `ALL 19 TESTS PASSED`.
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

1. The landing page should show a green "Open now" label.
2. Sign up with your own name and email, and answer all 11 questions. The last one is marked "★ Bonus question".
3. Reload the page on one question. The quiz should continue on the same question, and the timer shouldn't restart.
4. Let one question time out.
5. In the Sheet, check that:
   - **Participants** has your row, with `status` set to `done`.
   - **Responses** has 11 rows for your session. `kind` (column J) is `scored` on 10 of them and `star` on the last.
   - The finish screen showed your score, with `+ ★` if you answered the bonus question, and the announcement message.
   - **Leaderboard** lists you.
6. Go back to the landing page and try the same email again. You should see "This email has already been used".

Stop the local server with **Ctrl+C**.

---

## Part 4: Publish on GitHub Pages

[GitHub Pages](https://pages.github.com/) hosts the quiz page for free. Choose one option.

### Option A: add it to an existing Pages site

1. Copy the contents of `frontend/` into your Pages repository, in a folder named `n8n-quiz`.
2. Commit and push:
   ```bash
   git add n8n-quiz
   ```
   ```bash
   git commit -m "Add n8n rapid-fire quiz"
   ```
   ```bash
   git push
   ```
3. After about a minute, the quiz is live at `https://<username>.github.io/n8n-quiz/`, or at `https://<your-domain>/n8n-quiz/` if your site uses a custom domain.

### Option B: use a new repository

1. On GitHub, create a new **public** repository, for example `n8n-quiz`.
2. Upload the **contents** of `frontend/` (not the folder itself) to the root of the repository.
3. Open **Settings → Pages**. Set **Source** to **Deploy from a branch** and **Branch** to **main**, **/ (root)**. Click **Save**.
4. After a minute or two, the quiz is live at `https://<username>.github.io/n8n-quiz/`.

Only the `frontend/` files go on GitHub. `backend/`, `content/questions.csv` and `launch/` stay private, because the CSV contains the answers.

If the address differs from what you put in the `og:` tags in Part 1, update `index.html` and push again.

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

Apps Script handles about 30 requests at the same moment. To check that 50 people starting together doesn't lose rows, open the live quiz, press **F12**, click **Console**, paste this and press **Enter**:

```js
const url = "PASTE-YOUR-EXEC-URL";
const runs = Array.from({ length: 50 }, (_, i) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: JSON.stringify({ action: "start", name: "Load Test " + i, email: `loadtest${i}@example.com`, consent: true, hp: "" }),
}).then((r) => r.json()));
Promise.all(runs).then((r) => console.table(r.map((x) => ({ ok: x.ok, error: x.error || "" }))));
```

Most rows should say `ok: true`. A few `BUSY` errors are fine, because the real page retries them. Check that Participants has one row for each `ok: true`, with no duplicates.

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
- **Apps Script → Executions** (the list icon on the left): look for failed runs. A few `BUSY` responses at busy moments are normal.

**Work safely in the Sheet while the quiz is live:**

- To sort or filter, use **Data → Create a filter view**. Don't sort the Participants or Responses tabs themselves.
- Don't insert, delete or move columns in Participants or Responses.
- After editing **Config** or **Questions**, run `clearCaches`.

**If something goes wrong:**

| Problem | What to do |
|---|---|
| You need to close the quiz early | Set `END_AT` to the current time and run `clearCaches`. People already in the middle of the quiz get 10 more minutes to finish (`FINISH_GRACE_MINUTES`). |
| A question has a mistake | Set its `active` value to `FALSE` and run `clearCaches`. New participants won't get it. Anyone who already has it keeps their result for it. |
| Bots are signing up | Add [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/), a free check that tells people and bots apart. See "Optional: Turnstile" at the end of this guide. |
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
3. In Apps Script, open **Deploy → Manage deployments**, select the deployment, and click **Archive**. The quiz page then stops working, so replace it with a "This quiz has closed" page or remove it from GitHub Pages.

Any exported copy counts too. Delete it at the same time, or update the privacy notice to say how long you keep it.

---

## Optional: Turnstile

Add this only if you see bot sign-ups.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Turnstile → Add widget**. Enter your Pages domain, for example `<username>.github.io`.
2. Copy the **site key** into `TURNSTILE_SITE_KEY` in `frontend/config.js`, then push to GitHub.
3. Copy the **secret key**. In Apps Script, open **Project Settings → Script properties → Add script property**, name it `TURNSTILE_SECRET`, and paste the key.
4. No redeploy is needed. The backend checks for the secret on every sign-up.

---

## Quick reference

| Task | Where |
|---|---|
| Change dates or settings | Config tab, then run `clearCaches` |
| Turn a question off | Questions tab: set `active` to `FALSE`, then run `clearCaches` |
| Update the backend code | Apps Script: **Deploy → Manage deployments → pencil → New version** |
| See errors | Apps Script: **Executions** |
| Score the stars | Responses tab: filter `kind` = `star`, enter 0–5 in `reviewPoints` |
| Rankings | Leaderboard tab (private) |
| Statistics | Summary tab |
