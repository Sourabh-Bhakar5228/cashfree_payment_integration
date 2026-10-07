import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CashfreeService } from './cashfree.service';

@Module({
  imports: [ConfigModule],
  providers: [CashfreeService],
  exports: [CashfreeService],
})
export class CashfreeModule {}
