# Publish interview-voice on GitHub

This folder is not a git repository yet. The steps below create a private GitHub repo from `/Users/sidjp/Downloads/interview-voice` without uploading secrets or the local database.

Do this from that directory. GitHub stores the source. It does not run the interview. Fly remains a separate deploy.

## Stay out of the repo

`.gitignore` already excludes:

- `.env`, which holds the OpenAI key, email, passphrase, and session secret
- `data/`, which holds `interview.db` and session files
- `node_modules/`
- `web/dist/`, which `npm run build` and the Docker image recreate

Before the first commit, run `git status` and confirm none of those paths are listed. Do not paste the key or passphrase into a commit message, issue, or this file.

`package.json` has `"private": true`. That only blocks an accidental `npm publish`. The GitHub repo can still be created.

## What the first commit contains

- `server/` and `web/src/`, `web/index.html`, `web/vite.config.js`
- `package.json` and `package-lock.json`
- `setup.sh`, `.env.example`, `.gitignore`
- `Dockerfile`, `.dockerignore`, `fly.toml`
- `README.md` and this file
- `.github/workflows/build.yml`, which runs `npm ci` and `npm run build` on GitHub with Node 22

`.dockerignore` ignores `*.md`, so the Docker image used by Fly does not contain these documents. The git repo does.

## One-time machine setup

Install the GitHub CLI and sign in once if `gh auth status` fails:

```bash
brew install gh
gh auth login
```

Node 22 or newer is required on any machine that clones the repo. `./setup.sh` checks that and creates a local `.env`.

## Create the repo and push

Pick a repo name. `interview-voice` matches the folder. Create it private.

```bash
cd /Users/sidjp/Downloads/interview-voice
git init -b main
git add -A
git status
git commit -m "$(cat <<'EOF'
Add the interview voice app and GitHub setup.

EOF
)"
gh repo create interview-voice --private --source=. --remote=origin --push
```

`git status` before the commit is the check. Stop if `.env`, `data/`, `node_modules/`, or `web/dist/` appears.

`gh repo create` prints the repo URL when the push finishes. A later change is:

```bash
git add -A
git status
git commit -m "Describe why this change exists."
git push
```

## After it is on GitHub

Clone on another machine, run `./setup.sh`, and fill in a new `.env`. Do not copy the local database unless you mean to. A fresh `data/interview.db` is created on first launch and includes the built-in skill titles. Briefs are filled by research, so a new database does not contain the briefs already stored in the local file.

The GitHub Action only builds the page. It does not deploy to Fly and does not need the OpenAI key.

The live Fly app is a separate copy. Pushing to GitHub does not update https://interview-voice-sjp.fly.dev. A Fly deploy is `flyctl deploy --ha=false` from this directory after `flyctl` is logged in. Put secrets there with `fly secrets set`, not in a file that git can see.
