# Run the private PostGIS database

The Compose file pins the [upstream PostGIS image](https://github.com/postgis/docker-postgis) by digest. It mounts PostgreSQL 18 data at `/var/lib/postgresql` and keeps the database on the private Compose network without a published host port.

## Start and connect

Set five distinct passwords in your local shell or a mode-0600 Compose environment file outside the checkout. Keep them for the lifetime of the database. For a new installation, generate each value separately with `openssl rand -hex 32`.

| Environment variable | Database role | Consumer |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `postgres` | Host operator and role setup |
| `DB_MIGRATOR_PASSWORD` | `skyscrape_migrator` | Drizzle migrations and host-only identity provisioning |
| `DB_RUNTIME_PASSWORD` | `skyscrape_runtime` | API domain queries and TypeScript worker |
| `DB_AUTH_PASSWORD` | `skyscrape_auth` | API authentication |
| `DB_ADMIN_PASSWORD` | `skyscrape_admin` | API credential administration |

Run `docker compose up -d --wait db` from the repository root. When using an environment file, pass `--env-file /path/to/file` after `docker compose` on each command. The health check authenticates as runtime over TCP and queries PostGIS.

Connect the API and TypeScript worker to `db_private`. Use host `db`, port `5432`, and database `skyscrape`. Keep the Python collection service off this network. Inject URLs through process configuration. URL-encode passwords in the URLs if needed.

- Set `MIGRATOR_DATABASE_URL` for the migration process and run `node packages/db/src/index.ts`. The same role runs `node scripts/admin-bootstrap.ts` on the host for account issue, creation, and reset.
- Set `DATABASE_URL`, `AUTH_DATABASE_URL`, and `ADMIN_DATABASE_URL` for the API. These use the runtime, authentication, and credential administration logins respectively. Start the API with `node apps/server/src/app.ts` and its application secret and origin settings. Startup checks the login role of each pool.
- Give the ordinary TypeScript worker only its runtime URL. Source qualification and canonical provenance writes belong to a privileged ingestion path. Provision the writer separately before wiring ingestion. Keep its credentials out of disclosure callers.

Drizzle uses `public` for application tables and `drizzle` for migration history. Migration files grant access to application objects explicitly. The runtime has no direct session, key, or raw contact table access. Authentication manages session creation, lookup, refresh, and deletion. Credential administration uses audited database functions gated on a current admin session. Application and export contact reads use the same source-aware reader.

## Upgrade an existing volume

Stop the API and workers before upgrading and retain the named `db_data` volume. Preserve the existing postgres, migrator, and runtime passwords and inject new, distinct authentication and admin passwords. Run `docker compose up -d db` with all five values. PostgreSQL skips entrypoint scripts on initialized volumes, so run the role setup as the host operator.

```sh
docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -Xw -v ON_ERROR_STOP=1 -U postgres -d skyscrape -f /docker-entrypoint-initdb.d/10-bootstrap.sql'
```

The role setup is safe to replay with the same credentials. It creates missing roles and removes the former default grants for future tables. Run the Drizzle migrations next. Migration `0001_access_boundaries` updates the grants on existing application tables and creates the restricted functions. Start the API and workers with their respective URLs after migration succeeds.

## Restart, recover, or rotate passwords

Run `docker compose down` to stop the project and retain `db_data`. Use the same Compose project name when restarting. On an empty volume, the entrypoint runs `init/10-bootstrap.sql` in one transaction. If bootstrap failed after the cluster was initialized, check `docker compose logs db`, correct the cause, and repeat the role setup command.

For a damaged cluster, preserve its volume and restore a known backup into a separate project. Keep database snapshots and credentials separately. A database rollback requires the matching application revision and the corresponding role configuration.

To rotate a password, run `docker compose exec db psql -W -U postgres -d skyscrape` and enter the bootstrap password at the prompt. Use `\password role_name` in psql, update the matching local secret, and recreate the processes that consume it.
