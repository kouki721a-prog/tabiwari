#!/bin/sh
# Usage: PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh   (needs an empty scratch database)
set -e
cd "$(dirname "$0")/.."
DB=tabiwari_test
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f tests/stub.sql
for f in migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d $DB -f "$f"; done
psql -q -d $DB -f tests/rls.sql
psql -q -d $DB -f tests/phase3.sql
