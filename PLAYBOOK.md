# Publishing playbook

How to get Resource Watcher in front of users on
[extensions.gnome.org](https://extensions.gnome.org) (EGO) — the store that
feeds the Extensions app and the `gnome-extensions` CLI. EGO reviews every
upload (automated validation + a volunteer human review for malicious
behavior) before it becomes publicly downloadable.

## One-time decisions (before your first upload)

These are effectively permanent — settle them first:

- **UUID** — currently `gnome-resource-watcher@joel`. EGO treats the UUID as
  the extension's identity; changing it later creates a *new* listing and
  forces existing users to reinstall. The convention is email-like
  (`gnome-resource-watcher@joeljuca.github.io`); either is acceptable, but
  decide now.
- **License** — add a `LICENSE` file (GNOME ecosystem norm:
  GPL-2.0-or-later; MIT is fine too).
- **`shell-version` honesty** — metadata claims 45–51 but only 51.1 has been
  tested. Either verify on older versions (see gjs.guide's "Targeting Older
  GNOME Versions" and its per-version upgrade notes) or narrow the range
  before advertising it.
- **`url` in `metadata.json`** — add the repository URL; it shows on the
  listing and reviewers expect it.

## Publish the first version

1. **Register** an account at extensions.gnome.org (Register link on the
   upload page).
2. **Make sure CI is green** — the `unit` and `headless` jobs passing is the
   pre-flight gate (see `.github/workflows/ci.yml`).
3. **Package**:

   ```sh
   make pack
   ```

   This produces `gnome-resource-watcher@joel.shell-extension.zip`.
   Alternatively, download the `gnome-resource-watcher` artifact from the
   latest green workflow run — same zip, already content-verified.

4. **Upload** at <https://extensions.gnome.org/upload/> and pick the zip.
5. **Wait for review.** It is volunteer-run, not instant; the extension shows
   up as pending until approved.
6. **Fill in the listing** once approved: description (the README text works
   as a base), screenshots of the top-bar label and the open popup menu, and
   tags.

## Ship an update

Every release follows the same loop:

1. Make your changes; CI must be green.
2. **Bump the integer `version` in `metadata.json`** — this is how EGO and
   the Extensions app recognize the upload as an update (users only receive
   it if the version increased).
3. `make pack`
4. Upload the new zip on the same EGO page (same UUID → same listing).

## Troubleshooting

- **Upload rejected / won't validate** — check `metadata.json` first: UUID
   must match the directory/zip name, `shell-version` must list existing
   GNOME versions, `version` must be an integer.
- **Changed the UUID after publishing** — don't; it orphans the listing. If
   it ever happens, treat it as a new extension and note the migration for
   users in the old listing's description.
- **Review is taking long** — normal; it is volunteer-run. You can follow up
   on the extension's page or in the `#gnome-extensions` GNOME Matrix/Discourse
   channels (linked from gjs.guide/extensions).
- **Users report the update not appearing** — verify the uploaded version is
   actually higher than the previous one; that is the usual cause.

## Optional: Arch users (AUR)

EGO is the primary audience. For CachyOS/Arch users who prefer pacman, a
PKGBUILD in an AUR package pointing at this repo (or the released zip) is a
useful secondary channel. Keep EGO as the source of truth for versions.
