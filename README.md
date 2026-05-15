# bombadil-action

A GitHub Action for running [Bombadil](https://github.com/antithesishq/bombadil) property-based tests in CI.

## Quick start

```yaml
- uses: antithesishq/bombadil-action@v1
  with:
    origin: https://your-app.example.com
    spec: ./spec/bombadil.ts
    time-limit: 5m
    exit-on-violation: true
    output-path: bombadil-output
```

That installs Chrome for Testing, runs `bombadil test`, and fails the job on a property violation. The Chrome download is cached across runs.

## Drivers

Bombadil has two drivers. Select with `driver`:

| `driver`   | Subcommand                | What it does                                    |
| ---------- | ------------------------- | ----------------------------------------------- |
| `browser` (default) | `bombadil test`           | Drives a real Chrome browser against `origin`.  |
| `terminal` | `bombadil terminal test`  | Runs a command and tests its terminal output.   |

Chrome is only installed when `driver: browser`.

### Browser driver

```yaml
- uses: antithesishq/bombadil-action@v1
  with:
    origin: https://your-app.example.com
    spec: ./spec/bombadil.ts
    time-limit: 10m
    headers: |
      Authorization: Bearer ${{ secrets.STAGING_TOKEN }}
      X-Feature-Flag: 1
```

### Terminal driver

```yaml
- uses: antithesishq/bombadil-action@v1
  with:
    driver: terminal
    command: ./my-program --flag
    test-count: 100
    seed: 42
```

## Inputs

### Common

| Name      | Description                                                            | Default    |
| --------- | ---------------------------------------------------------------------- | ---------- |
| `driver`  | `browser` or `terminal`.                                               | `browser`  |
| `version` | Version of `@antithesishq/bombadil` to use.                            | `latest`   |

### Browser driver

| Name                         | Description                                                                                | Default  |
| ---------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| `origin`                     | Starting URL (also the navigation boundary). **Required.**                                 |          |
| `spec`                       | Path to a TS/JS specification file.                                                        |          |
| `output-path`                | Where to store trace, screenshots, etc.                                                    |          |
| `time-limit`                 | Maximum run time. Accepts `30s`, `5m`, `2h`, `1d`. **Required.**                           |          |
| `exit-on-violation`          | Exit on the first failing property.                                                        | `false`  |
| `width` / `height`           | Viewport size in pixels.                                                                   | `1024` / `768` |
| `device-scale-factor`        | Viewport scaling factor.                                                                   | `2`      |
| `instrument-javascript`      | Comma-separated: `files`, `inline`.                                                        | `files,inline` |
| `chrome-grant-permissions`   | Comma-separated Chrome permissions.                                                        | (see manual) |
| `headers`                    | HTTP headers as multi-line `Key: Value`. See below.                                        |          |
| `no-sandbox`                 | Disable Chromium sandboxing. Defaults on because GitHub-hosted Ubuntu runners restrict the namespaces Chromium needs. | `true`  |
| `chrome-version`             | Channel (`stable`, `beta`, `dev`, `canary`) or specific build ID.                          | `stable` |
| `cache`                      | Cache the Chrome download across runs.                                                     | `true`   |

### Terminal driver

| Name             | Description                                                       | Default |
| ---------------- | ----------------------------------------------------------------- | ------- |
| `command`        | Program and arguments, space-separated. **Required.**             |         |
| `test-count`     | How many test cases to run.                                       | `1`     |
| `seed`           | Random generator seed.                                            |         |
| `render-append`  | Append render output instead of clearing between renders.         | `false` |

## Outputs

| Name        | Description                                                  |
| ----------- | ------------------------------------------------------------ |
| `exit-code` | The exit code from `bombadil`: `0` ok, `2` property violation, other = error. |

## Headers

`headers` is a multi-line string with one `Key: Value` per line. Blank lines and `#`-comments are ignored.

```yaml
with:
  headers: |
    Authorization: Bearer ${{ secrets.TOKEN }}
    X-Custom: 1
    # X-Disabled: not-sent
```

Each line becomes a separate `--header KEY=VALUE` on the CLI.

## Time limit

The browser driver requires `time-limit` — without it a test can run until the job times out, even with `exit-on-violation: true` (if no violation fires, there's nothing to exit on). Set it shorter than the surrounding job's [`timeout-minutes`](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idtimeout-minutes) so bombadil can exit cleanly and write its trace before the runner is killed.

```yaml
jobs:
  test:
    timeout-minutes: 10
    steps:
      - uses: antithesishq/bombadil-action@v1
        with:
          origin: https://your-app.example.com
          time-limit: 5m
```

## Chrome installation

When `driver: browser`, the action installs Chrome for Testing via [`@puppeteer/browsers`](https://www.npmjs.com/package/@puppeteer/browsers) into `$RUNNER_TEMP/bombadil-chrome` and exports `CHROME=<path>` so `bombadil` picks it up. To use a pre-installed Chrome instead, set `CHROME` in the workflow env — the action will skip the download:

```yaml
- uses: antithesishq/bombadil-action@v1
  env:
    CHROME: /usr/bin/google-chrome
  with:
    origin: https://your-app.example.com
```

By default the download is cached per `(platform, build ID)`. Disable with `cache: false`.

## Uploading output

Pair with `actions/upload-artifact` to keep the trace for inspection:

```yaml
- uses: antithesishq/bombadil-action@v1
  with:
    origin: https://your-app.example.com
    output-path: bombadil-output
    time-limit: 5m
- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: bombadil-output
    path: bombadil-output
```

You can then download the artifact and run `bombadil inspect bombadil-output` locally to step through what happened.

## Testing against a local server

The usual pattern: start your app in the background, wait for it to accept connections, then run bombadil against `localhost`.

```yaml
- run: npm ci
- run: npm run start &
- run: curl --retry 30 --retry-all-errors --retry-delay 2 --silent --fail http://localhost:3000 >/dev/null
- uses: antithesishq/bombadil-action@v1
  with:
    origin: http://localhost:3000
    time-limit: 5m
    output-path: bombadil-output
- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: bombadil-output
    path: bombadil-output
```

The `curl --retry` line blocks until the server responds. GitHub tears down the runner at the end of the job, so an explicit server-stop step is usually unnecessary.

For Docker-based stacks:

```yaml
- run: docker compose up --detach --wait
- uses: antithesishq/bombadil-action@v1
  with:
    origin: http://localhost:8080
    time-limit: 5m
- if: always()
  run: docker compose down --volumes
```

`docker compose up --wait` blocks until the configured healthchecks pass, so you don't need a separate readiness probe.

## Reproducing a failure

Reproduction is a local workflow. When a test fails, bombadil prints both the `bombadil inspect` and `bombadil test --reproduce ...` commands to stdout — copy them from the job log.

1. Download the output artifact uploaded by the failing run.
2. Unzip it, then run the printed command locally against the same app:

   ```sh
   bombadil test --reproduce=./bombadil-output https://your-app.example.com
   ```

3. Use `bombadil inspect ./bombadil-output` to step through what happened.

For reproductions to succeed, run with the same options as the original (viewport, spec file, etc.).

## Development

```sh
npm install
npm run build   # bundles src/main.ts → dist/index.js with @vercel/ncc
```

CI rebuilds `dist/` and commits it back to `main` after the smoke tests pass, so you don't need to commit `dist/` from a PR yourself.

## Releasing

Releases are just floating major-version tags. Consumers reference `@v1`, `@v2`, etc.

```sh
git tag -f v1
git push origin v1 --force
```

For a new major (breaking change), use a fresh tag (`v2`) so existing consumers stay pinned to `v1`. Anyone needing an immutable pin can use a commit SHA: `uses: antithesishq/bombadil-action@<sha>`.
