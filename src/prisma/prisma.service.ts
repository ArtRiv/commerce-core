import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';
import { schemaFromConnectionString } from './connection-schema';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('DATABASE_URL');

    // Prisma 7 requires an explicit driver adapter rather than reading
    // DATABASE_URL implicitly.
    super({
      adapter: new PrismaPg(
        { connectionString },
        {
          // Undefined in production, where the URL pins no schema and Prisma
          // qualifies with `public` exactly as it always has. Set for the e2e
          // suite, whose URL carries `options=-c search_path=<schema>`: without
          // this the generated queries would ignore that and go to `public`
          // while the suite's raw TRUNCATEs went to the test schema — reading
          // and writing real data while believing it was disposable.
          schema: schemaFromConnectionString(connectionString),
        },
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Without this the pool's sockets outlive app.close(), which leaves the
   * process hanging — Jest reports it as "did not exit one second after the
   * test run", and a real deploy would drag connections through shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
