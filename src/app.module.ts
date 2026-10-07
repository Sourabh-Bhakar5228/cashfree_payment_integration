import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CashfreeModule } from './cashfree/cashfree.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    CashfreeModule,
    PaymentsModule,
    HealthModule,
  ],
})
export class AppModule {}
