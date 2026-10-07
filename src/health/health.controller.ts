import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ok',
        database: 'connected',
        service: 'cashfree-payment-module',
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'ok',
        database: 'connecting',
        service: 'cashfree-payment-module',
        timestamp: new Date().toISOString(),
      };
    }
  }
}
