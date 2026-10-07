import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentStatus, TransactionStatus } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async processCashfreeWebhook(
    body: any,
    rawBody: Buffer | string,
    signature: string,
    timestamp: string,
  ) {
    const rawBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody || JSON.stringify(body), 'utf8');

    // 1. Verify webhook signature
    this.verifySignature(rawBuffer, signature, timestamp);

    // 2. Extract event information
    const eventType = body?.type || body?.event_type || 'UNKNOWN';
    const orderId =
      body?.data?.order?.order_id || body?.data?.order_id || null;
    const paymentId = body?.data?.payment?.cf_payment_id
      ? String(body.data.payment.cf_payment_id)
      : null;

    // 3. Generate deterministic event ID
    const eventId = crypto
      .createHash('sha256')
      .update(rawBuffer)
      .digest('hex');

    this.logger.log(`Processing Cashfree webhook: eventType=${eventType}, orderId=${orderId}, eventId=${eventId}`);

    // 4. Idempotency check
    const existingEvent = await this.prisma.paymentWebhookEvent.findUnique({
      where: {
        eventId,
      },
    });

    if (existingEvent) {
      this.logger.log(`Idempotent webhook detected [eventId=${eventId}]. Already processed.`);
      return {
        success: true,
        message: 'Webhook already processed',
      };
    }

    // 5. Save webhook event audit log
    await this.prisma.paymentWebhookEvent.create({
      data: {
        eventId,
        eventType,
        orderId,
        payload: body,
        signature,
        processed: false,
      },
    });

    // 6. Find internal payment order
    if (!orderId) {
      throw new BadRequestException('Order ID missing from webhook');
    }

    const paymentOrder = await this.prisma.paymentOrder.findUnique({
      where: {
        orderId,
      },
    });

    if (!paymentOrder) {
      throw new BadRequestException('Payment order not found');
    }

    // 7. Extract payment status & validate transition
    const paymentStatus =
      body?.data?.payment?.payment_status ||
      body?.data?.payment_status ||
      null;

    const newStatus = this.mapCashfreeStatus(paymentStatus);
    const targetOrderStatus = this.mapOrderStatus(newStatus);

    // Production check: Prevent illegal state regression (e.g. SUCCESS -> FAILED)
    if (!this.canTransition(paymentOrder.status, targetOrderStatus)) {
      this.logger.warn(
        `Invalid status transition ignored: ${paymentOrder.status} -> ${targetOrderStatus} for order ${orderId}`,
      );
      await this.prisma.paymentWebhookEvent.update({
        where: { eventId },
        data: {
          processed: true,
          processedAt: new Date(),
        },
      });
      return {
        success: true,
        message: 'Invalid payment status transition ignored',
      };
    }

    // 8. Create or update transaction record (prevent duplicate paymentId collisions)
    if (paymentId) {
      const existingTx = await this.prisma.paymentTransaction.findUnique({
        where: { cashfreePaymentId: paymentId },
      });

      if (!existingTx) {
        await this.prisma.paymentTransaction.create({
          data: {
            paymentOrderId: paymentOrder.id,
            cashfreePaymentId: paymentId,
            amount: paymentOrder.amount,
            status: newStatus,
            paymentMethod: body?.data?.payment?.payment_group || null,
            gatewayResponse: body,
          },
        });
      } else {
        await this.prisma.paymentTransaction.update({
          where: { cashfreePaymentId: paymentId },
          data: {
            status: newStatus,
            gatewayResponse: body,
          },
        });
      }
    }

    // 9. Update payment order status
    await this.prisma.paymentOrder.update({
      where: {
        id: paymentOrder.id,
      },
      data: {
        status: targetOrderStatus,
      },
    });

    // 10. Mark webhook processed
    await this.prisma.paymentWebhookEvent.update({
      where: {
        eventId,
      },
      data: {
        processed: true,
        processedAt: new Date(),
      },
    });

    this.logger.log(`Webhook successfully processed for order ${orderId}: Final status = ${targetOrderStatus}`);

    return {
      success: true,
      message: 'Webhook processed successfully',
    };
  }

  private verifySignature(
    rawBody: Buffer,
    signature: string,
    timestamp: string,
  ) {
    const secretKey = this.configService.get<string>('CASHFREE_SECRET_KEY');

    if (!secretKey) {
      throw new UnauthorizedException('Cashfree secret key not configured');
    }

    if (!signature || !timestamp) {
      throw new UnauthorizedException(
        'Missing webhook signature or timestamp header',
      );
    }

    const signedPayload = timestamp + rawBody.toString('utf8');

    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(signedPayload)
      .digest('base64');

    const received = Buffer.from(signature, 'utf8');
    const expected = Buffer.from(expectedSignature, 'utf8');

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException('Invalid Cashfree webhook signature');
    }
  }

  private canTransition(
    current: PaymentStatus,
    next: PaymentStatus,
  ): boolean {
    if (current === PaymentStatus.SUCCESS) {
      return false; // Terminal: Success cannot be modified to failed or cancelled
    }

    if (current === PaymentStatus.CANCELLED) {
      return false; // Terminal: Cancelled order cannot become success
    }

    if (current === PaymentStatus.EXPIRED) {
      return false; // Terminal: Expired order cannot become success
    }

    return true;
  }

  private mapCashfreeStatus(status: string): TransactionStatus {
    switch (status) {
      case 'SUCCESS':
        return TransactionStatus.SUCCESS;
      case 'FAILED':
        return TransactionStatus.FAILED;
      case 'CANCELLED':
        return TransactionStatus.CANCELLED;
      case 'PENDING':
      default:
        return TransactionStatus.PENDING;
    }
  }

  private mapOrderStatus(status: TransactionStatus): PaymentStatus {
    switch (status) {
      case TransactionStatus.SUCCESS:
        return PaymentStatus.SUCCESS;
      case TransactionStatus.FAILED:
        return PaymentStatus.FAILED;
      case TransactionStatus.CANCELLED:
        return PaymentStatus.CANCELLED;
      case TransactionStatus.PENDING:
      default:
        return PaymentStatus.PENDING;
    }
  }
}
