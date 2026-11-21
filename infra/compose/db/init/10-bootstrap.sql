\getenv migrator_password DB_MIGRATOR_PASSWORD
\getenv runtime_password DB_RUNTIME_PASSWORD

BEGIN;
CREATE EXTENSION postgis;

CREATE ROLE skyscrape_migrator LOGIN;
CREATE ROLE skyscrape_runtime LOGIN;
ALTER ROLE skyscrape_migrator PASSWORD :'migrator_password';
ALTER ROLE skyscrape_runtime PASSWORD :'runtime_password';

REVOKE ALL ON DATABASE postgres, template1, skyscrape FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE skyscrape TO skyscrape_migrator;
GRANT CONNECT ON DATABASE skyscrape TO skyscrape_runtime;
GRANT CREATE ON SCHEMA public TO skyscrape_migrator;

ALTER DEFAULT PRIVILEGES FOR ROLE skyscrape_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO skyscrape_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE skyscrape_migrator IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO skyscrape_runtime;
COMMIT;
