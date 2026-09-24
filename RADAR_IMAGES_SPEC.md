# DrewBrews Radar — adding article images (schema v1.1)

For the Claude Code scout job that publishes `radar.json`.

**Goal:** attach the article's own preview image to each trend so the Story Kit can show Drew *what the story is actually about*. No API key, no signup — the image URL is already sitting in the article's HTML.

**Backwards compatible.** Keep `schemaVersion: 1`. These are four new optional fields per trend; the Story Kit ignores them when absent, and older feeds keep working.

---

## The four new fields

```json
{
  "name": "April Coffee Drops New Manual Grinder",
  "src": "press",
  "buzz": "...",
  "tpl": "s1",
  "angle": "...",
  "source_url": "https://dailycoffeenews.com/2026/09/01/april-coffee-...",

  "image_url":     "https://dr3whubbruh.github.io/drewbrews-radar/images/april-grinder.jpg",
  "image_origin":  "https://aprilcoffeeroasters.com/cdn/press/grinder-hero.jpg",
  "image_credit":  "April Coffee Roasters",
  "image_license": "press"
}
```

| Field | Required | Notes |
|---|---|---|
| `image_url` | optional | Absolute https URL. See **Host it yourself** below — this matters. |
| `image_origin` | **required whenever `image_url` is set** | The exact URL you downloaded the image from, before re-hosting. The page decides rights from this host. |
| `image_credit` | optional | Who owns it. Falls back to the domain if omitted. |
| `image_license` | optional | `"press"` \| `"editorial"` \| `"unknown"`. Default `unknown`. |

---

## How to get the image URL

Fetch the `source_url` and read the first of these that exists:

1. `<meta property="og:image" content="...">`
2. `<meta name="twitter:image" content="...">`
3. `<link rel="image_src" href="...">`

Resolve relative URLs against the page URL. If none exist, omit `image_url` — do **not** guess or substitute a stock photo.

---

## Setting `image_license` — this is the important part

Drew posts these frames publicly, so the Story Kit will only let a photo into a frame when it comes from **the maker**. Everything else is reference-only.

Set `"press"` **only** when `image_origin` is on the manufacturer's or roaster's own domain — `aprilcoffeeroasters.com`, `miir.com`, `hario.com`, `option-o.com`, `fellowproducts.com` and so on.

Set `"editorial"` when `image_origin` is on the publication's domain — `sprudge.com`, `dailycoffeenews.com`, `perfectdailygrind.com`, `notabarista.org`. This is the common case. Their photographers own those images; they are not ours to post.

Set `"unknown"` (or omit) if you can't tell. The page treats unknown as reference-only, so this fails safe.

Do not set `"press"` just because the article is *about* a product launch. It's about **who owns the pixels**, not what the story covers.

The page ignores the label for the final call and checks the **`image_origin` host** against its own maker list. Since `image_url` points at your GitHub Pages copy, its host says nothing about ownership. So a self-hosted image with **no `image_origin` is always reference-only**, and a mislabeled `"press"` on a publication domain gets held back too. If Drew starts covering a maker whose domain isn't recognized, add it to `MFR_HOSTS` in `drewbrews-trend-studio.html`.

---

## Host it yourself (avoids a broken PNG export)

The Story Kit exports frames to PNG in the browser, which re-fetches every image. A remote image whose server doesn't send `Access-Control-Allow-Origin` **exports blank** — it looks fine on screen and then fails silently on download. Most news sites don't send that header.

So: when you find a usable image, **download it into the radar repo** and point `image_url` at your own GitHub Pages copy.

```
drewbrews-radar/
├── radar.json
└── images/
    ├── april-grinder.jpg
    └── miir-ceramics.jpg
```

GitHub Pages serves with `Access-Control-Allow-Origin: *`, so those export correctly. Suggested handling:

- Filename: slug of the trend name, e.g. `april-coffee-manual-grinder.jpg`
- Resize to ~1500px on the long edge, JPEG quality ~82 (keeps the repo small; the frames are 1080×1920)
- Skip anything under 600px on the long edge — too small for a story frame
- Prune `images/` to only what the current `radar.json` references, so the repo doesn't grow forever

Storing a copy for internal reference is fine regardless of license. The `image_license` field is what governs whether it can be *published*.

---

## Acceptance check

After a run, `radar.json` should still validate against `radar.schema.json`, and:

- every `image_url` returns 200 and is on your GitHub Pages domain under `/drewbrews-radar/`
- every trend with `image_url` also has `image_origin` (the pre-download URL)
- every `image_license` is one of the three values
- no `"press"` label sits on a publication domain
- trends with no findable image simply omit the field

The Trend Studio's QA strip will show a per-trend rights badge on each radar card, so a mislabel is visible immediately rather than discovered after posting.

---

## Not legal advice

"Manufacturer press images are generally cleared for promotional use" is the normal industry expectation, not a guarantee. Press kits sometimes carry explicit terms. For anything Drew plans to put real money behind, check the maker's press page or just ask them — makers are usually glad to have their gear featured.
