# Releasing VSCX

Releases are automated with Changesets 3 and [the Changesets GitHub Action](https://github.com/changesets/action). A merged delivery change produces or updates a release pull request. Merge that reviewed release PR to publish the npm packages in dependency order and then publish the VS Code Marketplace pre-release.

## Add a changeset

Every pull request that changes a shipped package or the VS Code extension must include a changeset:

```sh
pnpm changeset
```

Select every affected package and write the release-note summary. Select `vscx` when the VS Code extension changes. Its manifest sets `"private": true` only to prevent npm publication. Changesets still versions the extension and writes `packages/vscode/CHANGELOG.md` before the release script publishes its VSIX to the Marketplace.

In this guide, `public` and `private` refer only to package registry settings. They do not describe repository visibility, source availability, licensing, intended audience, or confidentiality.

`@vscx/core`, `@vscx/cli`, and `vscx` are a fixed version group. Changesets advances them together so standalone clients and the bundled extension share one VSCX version.

Changes that affect only tests, tooling, or documentation do not need a changeset.

## Merge the release PR

1. Merge delivery pull requests into `main`.
2. The `Release` workflow creates or updates a `Version Packages` pull request with version, dependency-range, runtime-version, and changelog changes.
3. Review and merge that release pull request.
4. The same workflow verifies the release, publishes `@vscx/core` and `@vscx/cli` through npm trusted publishing in dependency-aware order, then publishes the versioned pre-release VSIX only when the release PR changes the extension version.

The workflow is serialized per branch. It validates the Marketplace publisher, credential, and exact VSIX before publishing anything. If npm publishing fails, it never reaches the extension publish step. After resolving the failure, rerun the release workflow from the failed release commit. npm and Marketplace publication both skip versions that already exist, so a retry after a partial success is safe. Do not create a second release PR or manually change the generated versions.

Changesets publishes `@vscx/core` and `@vscx/cli` to npm. The `vscx` package is excluded from npm and published to the VS Code Marketplace by the repository's release script.

## First-release rollout

Complete the external setup after this release infrastructure reaches `main` and before merging its generated `Version Packages` pull request. The initial changeset advances the synchronized package family from the bootstrap version `0.0.1` to the first managed pre-release version `0.1.0`.

### Repository automation setup

Run this setup once before merging the first delivery pull request. It replaces **Settings > Actions > General > Workflow permissions** and **Settings > Environments** click-ops:

```sh
repository="aaronccasanova/vscx"

gh api \
  --method PUT \
  "repos/${repository}/actions/permissions/workflow" \
  --field default_workflow_permissions=write \
  --field can_approve_pull_request_reviews=true

printf '{}\n' | gh api \
  --method PUT \
  "repos/${repository}/environments/release" \
  --input -
```

The environment intentionally has no protection rules or deployment branch policy. The release pull request is the human approval gate.

GitHub may require approval before running CI on the first pull request created by `github-actions[bot]`. Find the run ID and approve it without opening the Actions UI:

```sh
gh run list \
  --repo "${repository}" \
  --workflow CI \
  --branch changeset-release/main \
  --event pull_request \
  --json databaseId,conclusion,url

gh api \
  --method POST \
  "repos/${repository}/actions/runs/<run-id>/approve"
```

### 1. Confirm package and publisher ownership

- Confirm the npm account can publish scoped packages with `"access": "public"` under the `@vscx` scope.
- Confirm that the `vscx` VS Code Marketplace publisher is available to the release identity.
- Confirm that `packages/vscode/package.json` uses the verified `vscx` publisher ID.

### 2. Bootstrap the npm packages

npm exposes trusted-publisher settings only after a package exists. From a clean `main` checkout, sign in interactively, run `pnpm release:verify`, then publish the bootstrap packages in dependency order:

```sh
pnpm --filter @vscx/core publish --access public
pnpm --filter @vscx/cli publish --access public
```

Confirm that npm shows `@vscx/core@0.0.1` and `@vscx/cli@0.0.1`. Do not manually publish `0.1.0`. Changesets owns that version.

For each npm package, open its trusted-publisher settings and add a GitHub Actions publisher with:

- Organization or user: `aaronccasanova`
- Repository: `vscx`
- Workflow filename: `release.yml`
- Environment name: `release`
- Allowed action: `npm publish`

npm CLI 11 can automate the same one-time registry configuration. These are npm registry administration commands. Package installation and publication remain pnpm-native:

```sh
npm trust github @vscx/core \
  --repository aaronccasanova/vscx \
  --file release.yml \
  --environment release \
  --allow-publish \
  --yes

npm trust github @vscx/cli \
  --repository aaronccasanova/vscx \
  --file release.yml \
  --environment release \
  --allow-publish \
  --yes
```

Trusted publishing requires a GitHub-hosted runner and the workflow's `id-token: write` permission. It removes the need for an npm token and generates npm provenance automatically. After confirming the first automated publish succeeds, npm recommends enabling `Require two-factor authentication and disallow tokens` for each package.

### 3. Configure the Marketplace release identity

Add a `VSCE_PAT` secret to the `release` environment created during repository setup:

```sh
repository="aaronccasanova/vscx"

gh secret set VSCE_PAT \
  --repo "${repository}" \
  --env release
```

The command securely prompts for the secret value. Leave required reviewers disabled. The workflow uses the environment to create the `Version Packages` PR as well as publish a release, so environment reviewers would pause both operations. Review and merge the generated release PR as the human approval gate.

Create the Personal Access Token under the Microsoft account that owns the selected Marketplace publisher, with the Marketplace `Manage` scope. `vsce` reads `VSCE_PAT` automatically during the final publish step.

The initial Marketplace workflow uses PAT authentication. Microsoft retires global Azure DevOps PATs on December 1, 2026. Migrate the publisher to Microsoft Entra ID and replace the secret-backed step with `vsce --azure-credential` before that date.

### 4. Enable and run the managed release

The repository automation setup allows GitHub Actions to create and approve pull requests. The workflow declares the required `contents`, `pull-requests`, and `id-token` permissions.

Review the generated `Version Packages` pull request. Confirm that it sets core, CLI, extension, and runtime versions to `0.1.0`, updates all three changelogs, and removes the consumed changeset. Merge it only after npm trusted publishing, the GitHub `release` environment, `VSCE_PAT`, and the Marketplace publisher ID are ready.

The resulting `main` push verifies the release, publishes npm packages first, and publishes the Marketplace pre-release second. Confirm both npm packages, their provenance attestations, and the Marketplace listing before announcing the pre-release.

## Local checks

Run the complete release verification and VSIX artifact build without publishing:

```sh
pnpm release:verify
```

Inspect the exact pending release plan:

```sh
pnpm changeset status
```

Inspect the npm tarballs without publishing:

```sh
pnpm package:core
pnpm package:cli
```
