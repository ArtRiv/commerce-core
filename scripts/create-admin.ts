import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  formatAdminSummary,
  getAdminCliHelp,
  parseAdminCliArgs,
  provisionAdmin,
} from '../src/auth/admin-provisioning';
import { PrismaClient } from '../src/generated/prisma/client';
import { schemaFromConnectionString } from '../src/prisma/connection-schema';

async function main(): Promise<void> {
  const args = parseAdminCliArgs(process.argv.slice(2));

  if (args.help || !args.email) {
    console.log(getAdminCliHelp());
    if (!args.help && !args.email) {
      console.error(
        '\nErro: O parâmetro --email é obrigatório para provisionar um administrador.',
      );
      process.exit(1);
    }
    return;
  }

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('Variável de ambiente DATABASE_URL não foi definida.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString },
      { schema: schemaFromConnectionString(connectionString) },
    ),
  });

  try {
    const result = await provisionAdmin(
      {
        email: args.email,
        name: args.name,
        password: args.password,
      },
      prisma,
    );

    const appUrl = process.env['APP_URL'] || 'http://localhost:5173';
    console.log('\n' + formatAdminSummary(result, appUrl) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(
    '\nFalha no provisionamento de administrador:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
