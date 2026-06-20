# DrewBrews Trend Radar

This little repo does one job: **every Wednesday morning it researches what's
buzzing in specialty coffee and publishes a `radar.json` file.** The DrewBrews
Trend Studio reads that file and refreshes its on-screen radar automatically —
no manual copy-paste, ever.

```
GitHub Action (weekly)  →  scout.mjs  →  Anthropic API (web search)
                                │  writes a validated radar.json
                                ▼
                        GitHub Pages serves radar.json  →  the Studio reads it
```

There is **one moving part that can break**: the Anthropic API. Everything else
(Reddit, YouTube, blogs) is reached *through* Claude's web search, so there are
no other keys, quotas, or accounts to babysit.

---

## What it costs

A single weekly run is **a few cents**. Web search is billed per search (about
$10 per 1,000 searches) and the run is capped at 5 searches, plus a small amount
of token cost. Set a **monthly spend cap** in the Anthropic console as a
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

---

## How to run it manually ("Run now")

You don't have to wait for Wednesday. Repo → **Actions** tab →
**Weekly Trend Radar** → **Run workflow**. It researches, writes `radar.json`,
and commits it back. Refresh the Studio and you'll see it update.

## When does it run automatically?

Every **Wednesday at 13:00 UTC** — that's **5am Pacific in winter (PST), 6am in
summer (PDT)**. GitHub's scheduler runs in UTC and ignores daylight saving, so
the local time shifts by an hour across the year. For weekly content that
doesn't matter.

## How to change the sources

Open **`sources.txt`**, add or remove subreddits / YouTube channels / blogs
(one per line; lines starting with `#` are ignored), and commit. The scout reads
this file each week and tells Claude to prioritize those and similar sources.

## How to use a different model

The model name lives in exactly one place in `scout.mjs`
(`const MODEL = …`). You can also override it without editing code by setting a
`MODEL` environment variable. The default is `claude-haiku-4-5` (cheap and
plenty for this job).

---

## If it breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Radar didn't update this week | The Action failed (GitHub emails the repo owner on failure) | Open the **Actions** tab → re-run the workflow. If it's an API error, check the `ANTHROPIC_API_KEY` secret and your Anthropic billing. |
| Studio shows the old / built-in radar | `RADAR_URL` not set, or the file isn't reachable | Confirm GitHub Pages is on and the URL is exactly right. Open the Pages URL in a browser — you should see JSON. |
| Want different sources | — | Edit `sources.txt`, commit. |
| Costs creeping up | — | Lower `MAX_SEARCHES` in `scout.mjs` (or set the `MAX_SEARCHES` env var) and check your Anthropic spend cap. |

**A bad week never blanks the radar.** If Claude returns nothing usable or the
result fails schema validation, the scout logs the problem, exits with an error
(which triggers GitHub's failure email), and **leaves the previous `radar.json`
untouched**.

---

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

## Security boundary (the one rule that matters)

The Anthropic API key lives **only** in GitHub Actions Secrets. It is
server-side and must never appear in `radar.json`, in any HTML, or in committed
code. The Studio (a public page) only ever *reads* the harmless `radar.json`; it
never holds the key.
