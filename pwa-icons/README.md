# Home screen icons

The chat UI is installable, so it has an icon, and `pwa/manifest.webmanifest` is
what names it. Whatever that file lists has to exist in the icon set a deployment
ships — a manifest whose icon 404s is not an install at all, and the failure shows
up on a phone rather than in a deploy log. `infra/config.js` reads the list out of
the manifest and refuses a config whose set is missing one; `deploy.sh` copies
exactly that list.

Today the manifest asks for:

| file                     | size    | purpose                                     |
| ------------------------ | ------- | ------------------------------------------- |
| `icon-192.png`           | 192×192 | `any` — also the iOS `apple-touch-icon`     |
| `icon-512.png`           | 512×512 | `any` — install prompts and splash screens  |
| `icon-maskable-512.png`  | 512×512 | `maskable` — Android crops this to its shape |

## More than one deployment

The files in this directory are the default set. A deployment that wants its own
identity puts a full set in a subdirectory and points at it:

```json
"pwa": { "iconDir": "pwa-icons/ribbon" }
```

Two deployments of this repository are two apps on the same home screen, which is
the whole reason this is configurable rather than constant — `docs/DEPLOY.md` has
the rest of what a second deployment needs.

Icon sets are **tracked in git**, unlike the config file that selects one. A full
deploy ships the tree the deploy box checked out from `origin/main`, so an
untracked icon would quietly become the default one there and the deploy would
report success over the wrong icon.

## The maskable one is not the same picture

Android crops a maskable icon to whatever shape the launcher uses — circle,
squircle, teardrop — and only the centre **80%** circle is guaranteed to survive.
So it is full-bleed background with the artwork kept well inside that circle,
while the `any` icons are a rounded square with transparent corners. The same file
cannot do both jobs: an `any` icon handed to a launcher that masks it loses its
corners, and a maskable one shown unmasked is a picture swimming in padding.

## Regenerating a set

The sets here were produced from a single source image, kept in the set's own
directory as `source.png` so the next size can be cut from the same artwork:

- `any` (192, 512): white rounded square, corner radius `0.219 × size` (matching
  the default set), artwork scaled so its longest side is `0.78 × size`, centred,
  everything outside the rounded square transparent.
- `maskable` (512): white to the edges, artwork scaled so its longest side is
  `0.58 × size`, centred — that keeps it inside the 80% safe circle with room to
  spare.

Resample with Lanczos and leave the artwork on the background colour it was drawn
on rather than keying that colour out: a soft key against a light background
leaves a pale fringe that is invisible at 512 and obvious at 192.
