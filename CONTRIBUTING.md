# Contributing to garmin-mcp

How to work on garmin-mcp: running the tests, finding your way around the
code, reporting problems and cutting a release.

## Reporting issues

Open an issue on GitHub and include:

- what you asked your AI app (or which tool you called, with its arguments);
- what came back, and what you expected;
- whether asking again with `detail: "full"` shows the missing field. If it
  does, the compact shape is dropping it; if it doesn't, Garmin isn't sending
  it for your device.

Never paste your Garmin key, bearer tokens or `.dev.vars` into an issue. Found
a security problem? Report it privately through GitHub's
[**Security → Report a vulnerability**](https://github.com/colincooperio/garmin-mcp/security/advisories/new)
on this repo rather than opening an issue. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm test           # unit tests, including the stdio server, the npm package and the Claude Desktop extension
npm run test:e2e   # the real Worker in Miniflare, full OAuth + MCP flow, GitHub and Garmin faked
npm run check      # type-check + both of the above; runs before every deploy and in CI
npm run stdio      # the local stdio server (needs GARMIN_API_KEY in the environment)
npm run build      # compile the stdio server to dist/ (what's published to npm as garmin-mcp)
npm run build:mcpb # bundle it into one file and pack the Claude Desktop extension, garmin-mcp.mcpb
npm run test:pack  # pack, install the tarball in a temp project and run its bin (also part of npm test)
npm run dev        # the Worker on :8788 (needs .dev.vars, see .dev.vars.example)
npm run setup      # interactive first-time cloud setup (scripts/setup.mjs)
npm run update     # update an existing cloud deployment (scripts/update.mjs)
npm run usage      # how many people use it, from GitHub's download counts (scripts/usage.mjs)
npm run sync:prompts # copy the prompts from src/prompts.ts into mcpb/manifest.json (build:mcpb runs it)
```

Prompts are defined once, in `src/prompts.ts`. Claude Desktop rejects any
prompt whose served text differs from the manifest's `text` after argument
substitution, so never edit the manifest's prompts by hand: change
`src/prompts.ts` and run `npm run sync:prompts`. `test/mcpb.test.ts` fails if
they drift.

`scripts/setup.mjs` and `scripts/update.mjs` share `scripts/lib.mjs`. They
take their command runner, prompts and files as arguments, so
`test/setup.test.ts` drives them with fake wrangler, git and npm output.

The tests and type-check use `wrangler.example.jsonc`, so they run without a
Cloudflare account or your own config.

The tools and prompts live in `src/server.ts`, shared by the Worker
(`src/index.ts`) and the local server (`src/stdio.ts`). Field names come from
Garmin's Personal API spec, but check formats against real responses: the
spec documents some epoch-millisecond fields as date strings, and Garmin's
"local" times are an hour out on DST nights. If a value comes back empty for
your device, compare with `detail: "full"`. The compact shapes live in
`src/compact.ts` and `src/activities.ts`; local-time handling is in
`src/times.ts`.

`npm audit` reports advisories in `undici` inside `miniflare@4`. That copy is
used only by the local test harness against fake servers and isn't part of
the deployed Worker. `npm audit --omit=dev` is clean.

## Releasing

1. Bump the version in `package.json`, `src/server.ts`, `server.json` (both
   places) and `mcpb/manifest.json`. The version-sync test fails if any of
   them disagree.
2. Commit and push.
3. Create a GitHub release with the tag `vX.Y.Z`. Start the release notes
   with a line for people running the cloud version, **Cloud: action
   needed?**, saying either exactly what to do (for example a new setting to
   copy from `wrangler.example.jsonc`, or a new secret to store) or "No: run
   `npm run update`." Cloud users get release emails when they watch the repo,
   so this line is what they act on.

Publishing the release runs `.github/workflows/release.yml`. It checks the tag
matches every version, runs `npm run check`, publishes to npm (with
provenance) and the MCP Registry, and attaches `garmin-mcp.mcpb`, with a signed build attestation, to the
release. It needs no tokens: npm and the MCP Registry both authenticate with
GitHub's OIDC token.

The release workflow also attaches, for each install type (`mcpb`, `npx`,
`cloud`):

- `latest-<type>.json` (`{"latest": "<version>", "url": "<release url>"}`):
  the update check downloads it once per UTC day (`src/update.ts`);
- `weekly-<type>.json`, `monthly-<type>.json` and `install-<type>.json`
  (`{"ok":true}`): downloaded once per ISO week, once per month and once ever
  (`src/usage.ts`).

GitHub's download counts for these are the usage numbers. Unpinned `npx`
installs are counted but never shown the update notice. Turning the check off
(`GARMIN_MCP_NO_UPDATE_CHECK=1`, or the Desktop switch) removes an install
from all of them. `test/release-assets.test.ts` fails if the release stops
attaching a file the server downloads.

## Reading usage

```sh
npm run usage
```

It fetches the `stats` branch and prints, per install type and in total:
daily active installs (last 14 days), weekly (last 8 ISO weeks), monthly,
DAU/MAU, `.mcpb` downloads per week, and a one-line summary. Counts are summed
across releases, since a new release mid-period splits that period's
downloads between two tags. `npm run usage -- --file downloads.csv` reads a
local copy instead.

The `stats` branch is written only by `.github/workflows/stats.yml`, which
runs daily at 00:05 UTC (or by hand: Actions → Usage stats → Run workflow).
It appends GitHub's download count for every release file to
`stats/downloads.csv`. Don't commit to that branch by hand, and don't merge it
into main: it has no shared history with it.

One-time setup: on npmjs.com, open the `garmin-mcp` package's settings and add
a trusted publisher for GitHub Actions with this repository and the workflow
filename `release.yml`.
