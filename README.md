# Honey Bear GIF Service

Cloudflare R2 stores the original images and resized GIFs. The Worker serves a
public manifest, random GIF lookup, and cached image URLs.

## Add a GIF

Add a supported image (`.gif`, `.webp`, `.png`, `.jpg`, or `.jpeg`) to
`originals/<category>/` and push to `main`. GitHub Actions creates the bounded
GIF variants, uploads originals and variants to R2, updates the manifest, and
deploys the Worker. New categories are picked up from their directory names.

Run the dry run first and inspect its complete source/key listing:

```sh
npm ci
npm run sync:dry-run
```

The dry run needs no credentials and never contacts R2. A real local sync
uploads data, so use it only when you intend to publish the changes.

## Configuration

Edit `gifs.config.json` to change output dimensions or the default size. Each
size is written as `r/<width>x<height>/<category>/<content-hash>.gif`. The
script retries oversized outputs with a reduced palette, then stops with an
error if the file still exceeds `maxBytes`.

## Secrets

Add these under the GitHub repository's **Settings → Secrets and variables →
Actions**:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `CLOUDFLARE_API_TOKEN`

The deploy step sets `CLOUDFLARE_ACCOUNT_ID` from `R2_ACCOUNT_ID`. The R2
credentials are used only by the sync step; the Worker has read-only access
through its bucket binding and does not need secrets.

For local uploads, create an ignored `.env` file with the four `R2_*` values.
Do not commit it. The local Worker deploy can authenticate with Wrangler login
or `CLOUDFLARE_API_TOKEN` in the environment.

## Endpoints

- `GET /health` returns `ok`.
- `GET /manifest` returns the current manifest.
- `GET /random/<category>?size=128x128` returns a random GIF URL and its metadata.
- `GET /g/<key>` serves a cached resized GIF. Only keys under `r/` are exposed.