// Prisma CLI configuration.
//
// The CLI only reads a .env file next to this package, but the monorepo keeps a
// single .env at its root. Load that one here so `pnpm db:push`, `db:migrate` and
// `db:seed` work exactly as the README describes. In CI the variables come from
// the environment and the missing file is simply ignored.
import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
