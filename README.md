# Skyscrape

Skyscrape is an internal land intelligence workbench. This revision provides the TypeScript workspace and CI. The private application launch is pending.

## Set up the workspace

Use Linux and the exact Node.js 24 LTS patch in `package.json`. You need Corepack and HTTPS access to the public npm registry. Corepack downloads the pinned pnpm release and checks its integrity. The install uses the committed lockfile.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`pnpm verify` typechecks the workspace verification script and checks each manifest against its installed dependency versions. The API, web app, worker, MCP bridge, database, collector, and browser tests are pending. Extend `pnpm verify` and CI as their checks become runnable. Setup at this stage requires no service credentials, database, or browsers.

The product and release requirements are in [docs/requirements](docs/requirements).
