# Publishing to Open VSX (Antigravity's extension store)

Antigravity does **not** use the Microsoft Visual Studio Marketplace. It ships with the
[Open VSX Registry](https://open-vsx.org) (Eclipse Foundation), which is also what
VSCodium, Gitpod, Cursor and Windsurf use. Publishing there once makes the extension
installable from Antigravity's Extensions panel.

Everything in this repo is already wired up. The steps below are the **one-time external
setup**; after that, every release is a single command.

---

## One-time setup (~10 min)

### 1. Eclipse account

Register at [accounts.eclipse.org](https://accounts.eclipse.org/user/register).
⚠️ The **GitHub username** field must be exactly `soumatheusgomes` — Open VSX matches
your GitHub login against the Eclipse account, and a mismatch blocks publishing.

### 2. Sign the Publisher Agreement

1. Log in at [open-vsx.org](https://open-vsx.org) **with GitHub**.
2. Profile → **Settings** → _Log in with Eclipse_ → link the account from step 1.
3. Click the button to agree to the **Eclipse Publisher Agreement**.

### 3. Create an access token

Open VSX → **Settings → Access Tokens → Generate New Token**.
Copy the value immediately — it is shown only once.

### 4. Create the namespace

The namespace must match `publisher` in `package.json` (`soumatheusgomes`). It is
kept identical to the GitHub ID on purpose — that is the one form of evidence the
namespace-ownership claim accepts without DNS records or manual review:

```bash
npx ovsx create-namespace soumatheusgomes -p <YOUR_TOKEN>
```

### 5. Add the token as a GitHub secret

Repo → **Settings → Secrets and variables → Actions → New repository secret**

| Name             | Value                 |
| ---------------- | --------------------- |
| `OPEN_VSX_TOKEN` | the token from step 3 |

### 6. Let the release workflow push

Repo → **Settings → Actions → General → Workflow permissions** →
select **Read and write permissions** → Save.

(The workflow pushes the version commit and tag. If `main` has branch protection, also
allow the `github-actions[bot]` actor to bypass it.)

---

## Releasing (every time, from here on)

```bash
gh workflow run release.yml -f bump=patch     # or minor / major
```

…or GitHub → **Actions → Release → Open VSX → Run workflow**.

The workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)) then:

1. `npm ci` + lint + typecheck + tests — fails the release if anything is red;
2. bumps the version, creating the `vX.Y.Z` commit and tag **locally**;
3. builds the minified `.vsix` (`npm run package:ci`);
4. fails if the bundle is over 2 MB (guards against a stale `.vscodeignore`);
5. publishes to Open VSX;
6. only then pushes the commit + tag and cuts a GitHub Release with the `.vsix` attached.

Nothing reaches the remote until Open VSX accepts the package, so a failed publish leaves
no dangling tag to clean up.

Extensions show as _Deactivated_ on Open VSX for a few seconds while the registry scans
them (secret detection, blocklist, namespace-similarity checks), then go live.

---

## Screenshots in the store listing

Open VSX renders `README.md` as the extension page. Write image references **relative**
(`![alt](resources/screenshot.png)`) — at package time `vsce` rewrites them to
`https://github.com/soumatheusgomes/agentville/raw/HEAD/resources/screenshot.png`,
inferred from the `repository` field in `package.json`.

Two consequences:

- The image must be **committed and pushed to `main`**, or the listing shows a broken
  image — the store fetches it from GitHub, it is not served from the `.vsix`.
- `resources/screenshot*.png` is excluded in `.vscodeignore` precisely because the packed
  copy is never read. Only `resources/icon.png` ships.

## Optional

- **Verified namespace** — removes the "unverified publisher" warning on the listing.
  Open a _Claim namespace ownership_ issue at
  [github.com/EclipseFdn/open-vsx.org/issues](https://github.com/EclipseFdn/open-vsx.org/issues).
  This project qualifies under **Option 3** ("Not a VS Code Marketplace Publisher") via
  _"The namespace matches the GitHub ID making this request"_ — which is exactly why the
  namespace is `soumatheusgomes` and not a prettier variant. Any other namespace would
  fall through to Option 4, the discretionary manual-review path. The claim also requires
  12+ months of public GitHub history.
- **Also publish to the VS Code Marketplace** — needs a separate Azure DevOps publisher and
  PAT. Add a step to `release.yml` after the Open VSX one:

  ```yaml
  - name: Publish to VS Code Marketplace
    env:
      VSCE_PAT: ${{ secrets.VSCE_PAT }}
    run: npx @vscode/vsce publish --packagePath agentville-*.vsix
  ```

## Local packaging (unchanged)

`npm run package` still bumps + builds a `.vsix` for local installs — see the
`release-vsix` skill. Use it for testing; use the workflow for actual releases.
