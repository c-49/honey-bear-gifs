# Honey Bear Bot — GIF Service Migration Plan (for Claude Code)

## Goal

Move the `gifs/` folder and all resizing out of the bot. GIFs are resized **once, at upload time**, stored in an object bucket, and served by a small API. The bot calls the API to get a random GIF URL and replies with an **embed image URL** instead of uploading a file. This removes disk I/O, resizing, and multi-MB attachment uploads from the command path, so replies land well inside Discord's 3-second initial-response window.

## Why the current setup is slow (findings from the repo)

Claude Code: verify each of these before changing anything.

1. **Un-awaited resize bug** — `utils/gifUtils.js` calls `sharp(...).toFile(cachedPath)` without `await`, then immediately returns `cachedPath`. On a cache miss the file does not exist yet, so `new AttachmentBuilder(gifPath)` points at a missing/partial file and the send fails or hangs.
2. **Attachment uploads** — every GIF command uploads the file bytes to Discord (`files: [attachment]`). Originals are large (`gifs/pet` ≈ 14 MB for 9 files, `gifs/bonk` ≈ 8.7 MB for 7). Upload time from a small host is the dominant latency.
3. **Repo bloat** — `gifs/` is ~48 MB, including ~9 MB of committed `gifs/resized/` output. Every deploy ships it.
4. **`.webp` files are ignored** — `getRandomGif` filters to `.gif/.png/.jpg/.jpeg`, so 3 of the 4 files in `gifs/bite/` are never picked.
5. **Render leftovers** — `render.yaml` runs `preresize-gifs.js` at build time; the bot now runs on SparkedHost, so this no longer happens.

## Target architecture

```
honey-bear-gifs repo (new)                Cloudflare
┌─────────────────────────┐   push   ┌──────────────────────────────────────┐
│ originals/<category>/*   │ ───────▶ │ GitHub Action: resize (sharp)        │
│ scripts/sync.mjs         │          │   → upload to R2 bucket              │
│ worker/ (Cloudflare)     │          │   → write manifest.json              │
│ .github/workflows/*.yml  │          │   → deploy Worker                    │
└─────────────────────────┘          └──────────────────────────────────────┘
                                                        │
                            R2 bucket: honey-bear-gifs  │
                            ├─ originals/<cat>/<file>   │
                            ├─ r/128x128/<cat>/<id>.gif │
                            └─ manifest.json            ▼
                                           Worker (workers.dev)
                                           GET /random/:category → { url, ... }
                                           GET /manifest         → manifest.json
                                           GET /g/<key>          → GIF bytes (cached)
                                                        │
honey-bear-bot (SparkedHost) ◀──────────────────────────┘
  gifClient.js: fetch manifest at startup, refresh every 10 min,
  pick random in memory → embed.setImage(url) → interaction.reply()
```

Key design decision: **the bot does not make a network call per command.** It loads the manifest at startup and refreshes it in the background, so picking a GIF is an in-memory operation (~0 ms). `/random/:category` still exists for other clients and as a fallback. This is what guarantees the 3-second window instead of hoping an HTTP round trip is fast.

Resizing happens in CI, not in the Worker, because `sharp` (native libvips) cannot run in Cloudflare Workers.

## Phase 0 — Prep (human steps, do before Claude Code runs)

- [ ] Create a Cloudflare account (free). Enable R2 (requires a payment method on file, but stays $0 within the free tier).
- [ ] Create R2 bucket `honey-bear-gifs`.
- [ ] Create an R2 API token (Object Read & Write, scoped to that bucket). Note: Account ID, Access Key ID, Secret Access Key.
- [ ] Create a Cloudflare API token with "Edit Cloudflare Workers" permission (for `wrangler deploy` in CI).
- [ ] Create empty GitHub repo `c-49/honey-bear-gifs`.
- [ ] Add repo secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `CLOUDFLARE_API_TOKEN`.
- [ ] Run `npx wrangler login` locally so Wrangler can deploy from this machine.

## Phase 1 — Build the `honey-bear-gifs` repo

Work in a new directory next to the bot repo.

### 1.1 Move the originals
- Copy every file from `honey-bear-bot/gifs/<category>/` (excluding `gifs/resized/`) into `honey-bear-gifs/originals/<category>/`.
- Categories today: `bite`, `bonk`, `fart`, `hug`, `pet`, `uppies`, `welcome`.
- Do not copy `gifs/resized/` — it will be regenerated.

### 1.2 `scripts/sync.mjs` — resize + upload + manifest
Dependencies: `sharp`, `@aws-sdk/client-s3`.

Behavior:
1. Read config from `gifs.config.json`: `{ "sizes": [{ "w": 128, "h": 128 }], "default": "128x128", "maxBytes": 3000000 }`.
2. Walk `originals/<category>/*` accepting `.gif .webp .png .jpg .jpeg`.
3. For each file, compute `id = sha256(fileBytes).slice(0, 16)`. Content-hash keys mean re-uploads are idempotent and URLs are cache-safe forever.
4. For each size, output key `r/<w>x<h>/<category>/<id>.gif`:
   - `sharp(buf, { animated: true }).resize(w, h, { fit: 'inside', withoutEnlargement: true }).gif({ effort: 7 }).toBuffer()`
   - Always output GIF (Discord embeds animate `.gif` reliably; animated WebP in embeds is inconsistent).
   - If output exceeds `maxBytes`, retry with `.gif({ colours: 128, dither: 0.5 })`, then `colours: 64`. Warn if still over.
5. Skip upload when the key already exists (`HeadObject`) unless `--force`.
6. Upload with `ContentType: image/gif`, `CacheControl: public, max-age=31536000, immutable`.
7. Also upload the original to `originals/<category>/<filename>` (backup/source of truth in the bucket).
8. Build `manifest.json`:
   ```json
   {
     "version": "<ISO timestamp>",
     "default": "128x128",
     "categories": {
       "bonk": [{ "id": "a1b2c3d4e5f60718", "name": "bonk-cat.gif", "sizes": { "128x128": "r/128x128/bonk/a1b2c3d4e5f60718.gif" } }]
     }
   }
   ```
   Upload it with `CacheControl: public, max-age=60`.
9. Optional `--prune`: delete `r/` objects not referenced by the new manifest.
10. `--dry-run` flag prints what would happen without uploading. Run it first and show the output for approval before any real upload.

R2 S3 client config: `endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `region: 'auto'`.

### 1.3 `worker/` — Cloudflare Worker
`wrangler.toml` binds the bucket as `GIFS`. Routes:

- `GET /manifest` → stream `manifest.json` from R2, `Cache-Control: public, max-age=60`.
- `GET /random/:category?size=128x128` → read manifest (cache it in a module-level variable for 60 s), pick random entry, return `{ url, id, category, size }` where `url` is the absolute `/g/...` URL. 404 JSON for unknown/empty category.
- `GET /g/<key>` → only allow keys starting with `r/`; fetch from R2, return bytes with stored `Content-Type`/`Cache-Control` and `ETag`; use `caches.default` so repeat hits are served from Cloudflare's edge without an R2 read.
- `GET /health` → `ok`.
- Everything else → 404. No write endpoints (uploads only happen through CI).

Keep the Worker read-only and unauthenticated — the GIFs are public anyway, and this avoids storing a secret on the bot side.

### 1.4 GitHub Action `.github/workflows/sync.yml`
- Triggers: `push` to `main` touching `originals/**`, `scripts/**`, `worker/**`, `gifs.config.json`; plus `workflow_dispatch` with a `force` input.
- Steps: checkout → setup Node 20 → `npm ci` → `node scripts/sync.mjs` (with `--force` if input set) → `npx wrangler deploy` in `worker/`.
- Set `CLOUDFLARE_API_TOKEN` from the matching secret and `CLOUDFLARE_ACCOUNT_ID` from `${{ secrets.R2_ACCOUNT_ID }}` for the deploy step; use the R2 secrets for the sync step.

Result: adding a GIF = drop it into `originals/<category>/` on GitHub (web upload works from a phone) and push. No bot redeploy.

### 1.5 README
Document: how to add a GIF, how to add a new category, how to change sizes, secrets list, how to run sync locally with a `.env`.

**Acceptance checks for Phase 1**
- [ ] `node scripts/sync.mjs --dry-run` lists every original and target key.
- [ ] After a real run, `manifest.json` lists all 7 categories with the correct counts (including the 3 `.webp` bite files).
- [ ] `curl https://<worker>.workers.dev/random/bonk` returns JSON with a URL; opening the URL shows an animated 128×128-bounded GIF.
- [ ] Second request for the same `/g/` URL returns `cf-cache-status: HIT`.
- [ ] Every resized file is under 3 MB.

## Phase 2 — Update the bot (`honey-bear-bot`)

Create a branch `feat/remote-gifs`.

### 2.1 New `utils/gifClient.js`
- Env: `GIF_API_BASE` (e.g. `https://honey-bear-gifs.<subdomain>.workers.dev`), `GIF_SIZE` (default `128x128`).
- `init()` — fetch `${GIF_API_BASE}/manifest` with a 5 s timeout (`AbortSignal.timeout(5000)`, Node 18+ global `fetch`); store in memory; `setInterval` refresh every 10 min (`.unref()` it). On refresh failure, keep the last good manifest and log.
- `getRandomGifUrl(category)` — synchronous; returns `${GIF_API_BASE}/g/${key}` or `null`. Avoid repeating the last pick per category when there are ≥2 GIFs.
- `getRandomGifUrlRemote(category)` — async fallback that calls `/random/:category` with a 1.5 s timeout; used only if the manifest never loaded.
- Call `gifClient.init()` in `bot.js` on `ready` (don't block login on it).

### 2.2 Shared reply helper
Add `utils/gifReply.js` exporting `sendGifReply(interaction, { category, content, statKeys })`:
- Get URL via `getRandomGifUrl`, falling back to the remote call.
- If a URL exists: `interaction.reply({ content, embeds: [new EmbedBuilder().setImage(url).setColor(...)] , allowedMentions: { users: [...] } })` — **plain `reply`, no `deferReply`**, since there is nothing slow left.
- If only the remote path is available: `deferReply()` first, then `editReply` (keeps the old safety net).
- If no URL: reply with the existing "(GIF failed to load)" text.
- Fire stat increments (`userDataManager.incrementGifStat`) after replying, non-blocking, same as today.

### 2.3 Refactor callers
Replace `getRandomGif` + `AttachmentBuilder` with `sendGifReply` in:
- `commands/bite.js`, `bonk.js`, `fart.js`, `hug.js`, `pet.js`, `uppies.js`
- `bot.js` → the `welcome_gif` button handler (~line 331)

Preserve each command's exact message text, self-target wording, and stat key names.

### 2.4 Remove the old path
- Delete `utils/gifUtils.js`, `scripts/preresize-gifs.js`, the `build` npm script, and the `gifs/` folder (`git rm -r gifs`).
- Remove `sharp` from `package.json` dependencies if nothing else uses it (grep first).
- Remove `gif` and `gifsFolder` from `config.json`; drop `render.yaml` (bot is on SparkedHost now — confirm with Reith before deleting).
- Add `GIF_API_BASE` and `GIF_SIZE` to `.env.example`; update README "Add GIFs" / "Pre-Resize GIFs" sections to point at the new repo.
- Optional: purge `gifs/` from git history with `git filter-repo` to shrink the repo. **Ask Reith first** — this rewrites history and needs a force-push.

**Acceptance checks for Phase 2**
- [ ] `grep -rn "getRandomGif\|AttachmentBuilder(gifPath\|gifs/" --include=*.js .` returns nothing relevant.
- [ ] Bot starts with `GIF_API_BASE` unset → GIF commands reply with the fallback text, no crash.
- [ ] Bot starts with Worker down → logs manifest failure, commands still respond (fallback text) inside 3 s.
- [ ] In a test guild, each of `/bite /bonk /fart /hug /pet /uppies` and the welcome button shows an animated GIF; log the time from interaction receipt to `reply` resolving — target < 500 ms.
- [ ] Mood/nocontact/moderation commands untouched and still work.

## Phase 3 — Rollout

1. Run Phase 1 and verify the Worker URLs manually.
2. Set `GIF_API_BASE` in SparkedHost's environment.
3. Deploy the `feat/remote-gifs` branch; test in the test guild.
4. Merge; deploy to production; watch logs for a day.
5. Only then delete `gifs/` from the bot repo (step 2.4) — keeps an easy rollback until the new path is proven.

## Free-tier budget check (Cloudflare)

- R2 free tier: 10 GB storage, 1M Class A (writes), 10M Class B (reads) per month, no egress fees. Current originals + one resized set ≈ 50 MB.
- Workers free: 100k requests/day. Edge caching on `/g/` means most GIF views never touch R2.
- Discord also caches embed images on its media proxy, so repeat views of the same GIF barely hit the Worker.

## Open questions for Reith

1. One size (128×128) is enough, or should the manifest carry a second size (e.g. 256×256) for the welcome GIF?
2. OK to delete `render.yaml` now that the bot is on SparkedHost?
3. Rewrite git history to drop the 48 MB of GIFs, or just delete going forward?
4. Is there a custom domain available? If yes, put the Worker on `gifs.<domain>` instead of `workers.dev`.
