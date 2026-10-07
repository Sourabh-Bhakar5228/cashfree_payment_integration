import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { WebhookService } from './webhook.service';
import { CashfreeModule } from '../cashfree/cashfree.module';

@Module({
  imports: [CashfreeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, WebhookService],
  exports: [PaymentsService, WebhookService],
})
export class PaymentsModule {}
