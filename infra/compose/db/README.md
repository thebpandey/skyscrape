# Run the private PostGIS database

This bootstrap was tested with Docker Engine 29.9.3 and Compose 5.7.0 on Linux/amd64. The Compose file pins the [upstream PostGIS image](https://github.com/postgis/docker-postgis) by digest. It mounts PostgreSQL 18 data at `/var/lib/postgresql`.

## Start and connect

Set three distinct passwords in your local shell or a mode-0600 Compose environment file outside the checkout. Keep the values for the lifetime of the database. For a new installation, generate each value separately with `openssl rand -hex 32`.

| Environment variable | Database role | Consumer |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `postgres` | Host operator and extension bootstrap |
| `DB_MIGRATOR_PASSWORD` | `skyscrape_migrator` | Drizzle migration process |
| `DB_RUNTIME_PASSWORD` | `skyscrape_runtime` | TypeScript API and worker |

From the repository root, run `docker compose up -d --wait db`. If using an environment file, pass `--env-file /path/to/file` after `docker compose` on each command. Health checks authenticate as the runtime role over TCP and query PostGIS.

Attach the API, TypeScript worker, and migrator to the Compose network `db_private`. Use host `db`, port `5432`, and database `skyscrape`. Give each process only its own credential. Keep the Python collection service off this network. The database has no published host port.

Run Drizzle migrations as `skyscrape_migrator`. Use `public` for application tables and the default `drizzle` schema for migration history. The migrator has database `CREATE` for Drizzle's schema creation and can install PostgreSQL's trusted extensions. The bootstrap superuser owns PostGIS. The runtime role gets row access and sequence usage on application objects the migrator creates in `public`. Grant access explicitly when a migration needs another schema.

## Restart, recover, or rotate passwords

Run `docker compose down` to stop the project and retain the named `db_data` volume. Use the same Compose project name when restarting. On an empty volume, the entrypoint runs `init/10-bootstrap.sql` in one transaction. On an existing cluster it skips initialization, including password setup.

If initialization fails, inspect `docker compose logs db`. If the database exists and the bootstrap transaction rolled back, fix the cause, start the service with `docker compose up -d db`, and replay the transaction once.

```sh
docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -Xw -v ON_ERROR_STOP=1 -U postgres -d skyscrape -f /docker-entrypoint-initdb.d/10-bootstrap.sql'
```

For a damaged cluster, preserve its volume and restore a known backup into a separate project. The Compose volume is local storage. It does not provide a backup.

To rotate a password, open `docker compose exec db psql -W -U postgres -d skyscrape` and enter the current bootstrap password at the prompt. Use `\password role_name` in psql, update the matching local secret, and recreate the services that consume it.
