\getenv migrator_password DB_MIGRATOR_PASSWORD
\getenv runtime_password DB_RUNTIME_PASSWORD
\getenv auth_password DB_AUTH_PASSWORD
\getenv admin_password DB_ADMIN_PASSWORD

BEGIN;
CREATE EXTENSION IF NOT EXISTS postgis;

SELECT format('CREATE ROLE %I LOGIN', required.name)
FROM (VALUES ('skyscrape_migrator'), ('skyscrape_runtime'), ('skyscrape_auth'), ('skyscrape_admin')) AS required(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = required.name)
\gexec
ALTER ROLE skyscrape_migrator PASSWORD :'migrator_password';
ALTER ROLE skyscrape_runtime PASSWORD :'runtime_password';
ALTER ROLE skyscrape_auth PASSWORD :'auth_password';
ALTER ROLE skyscrape_admin PASSWORD :'admin_password';

REVOKE ALL ON DATABASE postgres, template1, skyscrape FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE skyscrape TO skyscrape_migrator;
GRANT CONNECT ON DATABASE skyscrape TO skyscrape_runtime, skyscrape_auth, skyscrape_admin;
GRANT CREATE ON SCHEMA public TO skyscrape_migrator;

ALTER DEFAULT PRIVILEGES FOR ROLE skyscrape_migrator IN SCHEMA public
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM skyscrape_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE skyscrape_migrator IN SCHEMA public
    REVOKE USAGE ON SEQUENCES FROM skyscrape_runtime;
COMMIT;
