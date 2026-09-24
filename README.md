# DrewBrews Trend Radar

This little repo does one job: **every Wednesday morning it researches what's
buzzing in specialty coffee and publishes a `radar.json` file.** The DrewBrews
Trend Studio reads that file and refreshes its on-screen radar automatically —
no manual copy-paste, ever.

```
GitHub Action (weekly) → scout.mjs
   1. COLLECT  real posts/articles/videos      (no AI — Reddit, RSS feeds, YouTube feeds)
   2. CURATE   Claude picks the best + writes copy   (it picks by number, never writes links)
   3. PUBLISH  validated radar.json → commit → GitHub Pages + Gist  →  the Studio reads it
```

Every link in `radar.json` comes straight from Reddit, a publication's RSS feed, or
YouTube — Claude only chooses *which* items and writes the "buzz" and "angle" copy,
and is told to use only facts that appear in the item itself.

**Moving parts that can break:** the Anthropic API (curation), and each source
(Reddit, the publication feeds, YouTube). A single source going dark doesn't fail
the run — but it is flagged: the run shows a ⚠️ warning and a **"Radar source
health"** table on the run's summary page. Glance at that after a run.

---

## What it costs

A weekly run is **a few cents**: one Claude request over ~60 collected items. No
web-search fees. Still set a **monthly spend cap** in the Anthropic console as a
runaway-bug backstop — see "First-time setup" below.

---

## First-time setup (do this once)

1. **Add your Anthropic API key as a secret.**
   Repo → **Settings** → **Secrets and variables** → **Actions** → **New
   repository secret**.
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key (starts with `sk-ant-…`)
   The key lives only here, server-side. It never appears in `radar.json`, in any
   web page, or in the code.

2. **Turn on GitHub Pages.**
   Repo → **Settings** → **Pages** → Source: **Deploy from a branch** →
   Branch: `main`, folder: `/ (root)` → **Save**.
   After a minute your file is live at:
   ```
   https://<your-username>.github.io/drewbrews-radar/radar.json
   ```

3. **Point the Studio at it.** In `content/drewbrews-trend-studio.html`, find the
   commented constant near the top of the main script and change it:
   ```js
   // before
   const RADAR_URL = 'radar.json';
   // after
   const RADAR_URL = 'https://<your-username>.github.io/drewbrews-radar/radar.json';
   ```
   That's the only edit to the Studio. It already fetches the file on load
   (cache-busted), validates it, adopts it only if it's newer than what it has,
   and falls back to your last manual paste — then to the built-in starter radar
   — so it can never show a blank screen, even if a run fails.

4. **(Recommended) Set a monthly spend cap** in the Anthropic console so a bug
   can never run up a bill.

5. **(Optional) Gist mirror.** The workflow also copies `radar.json` to a GitHub
   Gist when the `GIST_TOKEN` and `GIST_ID` secrets are set. If they're missing
   the step just logs a warning.

6. **(Not done yet: see "Known gaps") Reddit API credentials.** Without them
   Reddit is read through its public RSS feed, which Reddit heavily rate-limits
   for GitHub's servers (in testing, 3 of 25 fetches got through). With them, the
   scout uses Reddit's official API and also gets upvote and comment counts.
   Reddit now requires approval before API use:
   1. Create a "script" app at <https://www.reddit.com/prefs/apps>. Its page
      shows the client ID and secret.
   2. Request access through Reddit's support form
      (<https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=360000600232>),
      choosing the **developer** category. Describe the project honestly:
      read-only, 5 subreddits, about 5 requests a week, and posts are summarized
      by an AI (not used for training). Mention it if DrewBrews earns money from
      this, since commercial use needs separate approval.
   3. Once approved, add repository secrets `REDDIT_CLIENT_ID` and
      `REDDIT_CLIENT_SECRET`, then press **Radar dry run** to confirm the log
      says `Reddit mode: OAuth API`.

7. **(Recommended) YouTube Data API key.** YouTube's public feeds fail more often
   than not from GitHub's servers (0–3 of 8 channels per try in testing). With
   a key, the scout reads each channel's uploads through the official API instead.
   It's free: each weekly run uses about 8 of the 10,000 daily quota units.
   1. In the Google Cloud console (<https://console.cloud.google.com/>), create
      a project (e.g. "drewbrews-radar").
   2. **APIs & Services → Library** → enable **YouTube Data API v3**.
   3. **APIs & Services → Credentials → Create credentials → API key**. Then
      **Edit API key → API restrictions → Restrict key → YouTube Data API v3**,
      so the key can't be used for anything else.
   4. Add it as the repository secret `YOUTUBE_API_KEY`, then press **Radar dry
      run** and look for `YouTube mode: Data API` in the log.

---

## How to run it manually ("Run now")

You don't have to wait for Wednesday. Repo → **Actions** tab →
**Weekly Trend Radar** → **Run workflow**. It researches, writes `radar.json`,
and commits it back. Refresh the Studio and you'll see it update.

## How to preview without publishing ("Dry run")

Repo → **Actions** → **Radar dry run** → **Run workflow**. It does everything
the weekly run does but publishes nothing. The log shows every item it
collected (with upvotes/comments when Reddit's API is connected) and the radar
it *would* have posted. Handy after changing `sources.txt` or adding secrets.

## When does it run automatically?

Every **Wednesday at 13:00 UTC** — that's **5am Pacific in winter (PST), 6am in
summer (PDT)**. GitHub's scheduler runs in UTC and ignores daylight saving, so
the local time shifts by an hour across the year. For weekly content that
doesn't matter.

## How to change the sources

Open **`sources.txt`**, add or remove subreddits / YouTube channels / blogs
(one per line; lines starting with `#` are ignored), and commit.

- **Subreddits:** `https://www.reddit.com/r/<name>/` — the week's top posts are read.
- **Publications:** the site's home page, e.g. `https://sprudge.com/` — the scout
  finds its RSS feed (`/feed`, `/rss`, …) automatically.
- **YouTube:** `https://www.youtube.com/@<handle> <channel ID>`. If you don't know
  the ID, add just the URL; the run log prints the ID (`resolved to UC…`) so you
  can paste it in.

Only these sources are used — the scout never pulls from anywhere else.

## How to use a different model

The model name lives in exactly one place in `scout.mjs` (`const MODEL = …`).
You can also override it without editing code by setting a `MODEL` environment
variable. The default is `claude-sonnet-5`, which is plenty for picking and
writing short copy, and costs pennies per week. It runs at `medium` effort; set
`EFFORT=high` for more careful picks. Picks come back as structured output
(JSON checked against a schema), so any current model that supports structured
outputs works.

---

## If it breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Radar didn't update this week | The Action failed (GitHub emails the repo owner on failure) | Open the **Actions** tab → re-run the workflow. If it's an API error, check the `ANTHROPIC_API_KEY` secret and your Anthropic billing. |
| Studio shows the old / built-in radar | `RADAR_URL` not set, or the file isn't reachable | Confirm GitHub Pages is on and the URL is exactly right. Open the Pages URL in a browser — you should see JSON. |
| Want different sources | — | Edit `sources.txt`, commit. |
| ⚠️ "Reddit source is empty" on a run | No Reddit API secrets, so it fell back to rate-limited RSS | Add `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` (setup step 6). |
| ⚠️ "YouTube source is empty" | No `YOUTUBE_API_KEY`, so the flaky public feeds were used; or the key is wrong or out of quota | Add the key (setup step 7). If one is set, check it in the Google Cloud console. |
| The same story shows up two weeks running | — | It shouldn't: anything already in the current `radar.json` is skipped. |

**A bad week never blanks the radar.** If Claude returns nothing usable or the
result fails schema validation, the scout logs the problem, exits with an error
(which triggers GitHub's failure email), and **leaves the previous `radar.json`
untouched**.

---

## Known gaps

- **Reddit API access isn't set up yet.** Until it is, Reddit comes from the
  rate-limited RSS feed: most weeks it contributes few or no posts, and the
  posts it does bring carry no upvote counts, so the AI can't tell a popular
  thread from noise. Each run shows a ⚠️ warning for this; that's expected until
  setup step 6 is done.
- **`tpl` (s1–s6) has no written definition.** Its meaning lives in the
  Studio, so the AI currently guesses which template fits. Add the definitions
  to the prompt in `scout.mjs` once they're known.

## The contract (`radar.json`)

`radar.json` is the shared agreement between this scout and the Studio. Its shape
is defined formally in `radar.schema.json` and the scout validates every result
against it before writing. Don't change the shape without bumping
`schemaVersion` — the Studio ignores any file whose `schemaVersion` is higher
than it understands.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-24T13:00:00Z",
  "trends": [
    {
      "name": "short gear/trend name",
      "src": "press | review | community | verify",
      "buzz": "1-2 sentences: what's happening and why people care",
      "tpl": "s1 | s2 | s3 | s4 | s5 | s6",
      "angle": "how DrewBrews should frame it — inclusive, no gatekeeping",
      "source_url": "https://a-real-link"
    }
  ]
}
```

## Run it on your own machine (optional)

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node scout.mjs
```

It prints what it found and rewrites `radar.json` only if the result is valid.
To try it without touching the live file, redirect the output:

```bash
OUTPUT_PATH=/tmp/radar.test.json COLLECTED_PATH=/tmp/collected.json node scout.mjs
```

`collected.json` holds every item the scout gathered, so you can see what Claude
chose from.

## Security boundary (the one rule that matters)

The Anthropic API key lives **only** in GitHub Actions Secrets. It is
server-side and must never appear in `radar.json`, in any HTML, or in committed
code. The Studio (a public page) only ever *reads* the harmless `radar.json`; it
never holds the key.
