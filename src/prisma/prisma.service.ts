import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Database connected successfully via Prisma');
    } catch (error) {
      this.logger.warn(
        'Database connection could not be established at startup. Ensure PostgreSQL container is running (docker compose up -d).',
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
