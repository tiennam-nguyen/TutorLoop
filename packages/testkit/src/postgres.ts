import { PostgreSqlContainer } from "@testcontainers/postgresql";

export function startPostgres() {
  return new PostgreSqlContainer("postgres:18").start();
}
