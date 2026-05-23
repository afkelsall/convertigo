---
name: release
description: Bundle and ship a new Convertigo release to the Mozilla Add-on Hub (AMO). Use when the user wants to "cut a release", "release a new version", "bundle/upload to Mozilla/AMO", "ship to addons.mozilla.org", or "bump the version and build the zip". Reads the prior release tag, bumps the version, generates human-readable release notes, builds the zip with web-ext, commits, and tags.
---

# Release Convertigo to AMO

End-to-end release for this Firefox extension: figure out the new version from the
prior git tag, bump `manifest.json`, generate release notes, build the upload zip, and
tag the release. Final upload to AMO is a manual browser step (instructions at the end).

## Shell rules (from CLAUDE.md — do not violate)
- **Never chain commands** with `&&`, `;`, or `||` — run each as a separate tool call.
- Use `git -C "C:\My Junk\Programming\convertigo" <cmd>` instead of `cd`.
- Use the **Bash** tool for git/node (POSIX). It does NOT understand PowerShell here-strings
  (`@'...'@`) — for multi-line commit messages, write the message to a temp file and use
  `git commit -F <file>` (see step 5).

## Steps

### 1. Determine current and next version
- Read `version` from `manifest.json`.
- Get the prior release tag: `git -C "<repo>" describe --tags --abbrev=0 --match "v*"`.
  - The convention is `vMAJOR.MINOR.PATCH` (e.g. `v1.1.13`).
  - If this errors with "No names found", there are no tags yet — treat the current
    manifest version as the last released version and confirm with the user.
- **Next version = increment the patch by 1** (e.g. `1.1.13` → `1.1.14`), unless the user
  asks for a minor/major bump.
- Sanity check: the prior tag should match the current manifest version. If the manifest
  is already ahead of the latest tag, ask the user whether that version was already
  published before bumping further.

### 2. Generate release notes from commits
- List commits since the prior tag:
  `git -C "<repo>" log <prior-tag>..HEAD --format="%h %s"` (use `%B` to read full bodies).
- Write **human-readable** notes to `RELEASE_NOTES.md` (overwrite it — it's a scratch/paste
  buffer, gitignored from the zip but kept in the working tree). Style the user wants:
  - **Brief dot points, written for end users, not developers.** Translate commit jargon
    into user-visible impact ("Fixed freezing on live-updating pages", not "suppress
    self-induced mutations via takeRecords()").
  - Group under bold headers as relevant: **New Features**, **Bug Fixes**,
    **Performance**, **Settings**, **Internal**. Omit empty sections.
  - Lead the file with `# Release Notes — <version> (<YYYY-MM-DD>)`.
- Show the notes to the user and let them edit before continuing.

### 3. Bump the version
- Edit `manifest.json` `version` to the new version (single-line Edit).

### 4. Build the zip
Run the saved build command (also stored in the gitignored `web-ext-commands.txt`):

```
node "C:\My Junk\Programming\convertigo\node_modules\web-ext\bin\web-ext" build --source-dir "C:\My Junk\Programming\convertigo" --artifacts-dir "C:\My Junk\Programming\convertigo\web-ext-artifacts" --ignore-files web-ext-commands.txt --overwrite-dest
```

Output lands at `web-ext-artifacts/convertigo-<version>.zip`. Confirm the filename matches
the new version.

### 5. Commit and tag
- Stage only the version bump: `git -C "<repo>" add manifest.json`
  (and `RELEASE_NOTES.md` only if the user wants it committed — by default it stays
  untracked, matching prior practice).
- Commit with a clean message. Because Bash can't take PowerShell here-strings, write the
  message to a temp file first, then:
  `git -C "<repo>" commit -F "<repo>\.git\COMMIT_MSG_TMP.txt"`
  Message format:
  ```
  Release <version>

  <one-line summary of what ships>

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```
  Then delete the temp file with `rm -f`.
- Tag: `git -C "<repo>" tag -a v<version> -m "Release <version>"`.
- Committing to `main` is expected here — releases are tagged on `main`.

### 6. Upload to AMO (manual — tell the user)
web-ext `build` only makes the zip; submission to a **listed** add-on is done in the
browser. Tell the user to:
1. Go to **https://addons.mozilla.org/en-US/developers/addon/convertigo/versions/submit/**
2. Upload `web-ext-artifacts/convertigo-<version>.zip`.
3. Choose **"On this site"** (listed) distribution.
4. Paste the contents of `RELEASE_NOTES.md` into the version notes / "What's new" field.
5. Submit for review.

Then remind the user to push the commit and tag:
`git -C "<repo>" push` and `git -C "<repo>" push origin v<version>`.

## Do NOT
- Do **not** put the AMO API key/secret into this skill or any committed file. Those live
  only in the gitignored `web-ext-commands.txt` and are only needed for `web-ext sign`
  (self-distributed/unlisted builds), not for the normal listed upload above.
- Do not run `web-ext sign` unless the user explicitly asks for an unlisted/self-hosted
  build.
