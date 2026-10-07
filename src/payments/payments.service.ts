import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashfreeService } from '../cashfree/cashfree.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentStatus } from '@prisma/client';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfreeService: CashfreeService,
  ) {}

  async createPayment(dto: CreatePaymentDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.paymentOrder.findUnique({
        where: {
          idempotencyKey,
        },
      });

      if (existing) {
        this.logger.log(
          `Idempotent request recognized for key ${idempotencyKey}. Returning existing payment ${existing.orderId}`,
        );
        return {
          success: true,
          message: 'Existing payment returned',
          data: {
            orderId: existing.orderId,
            cashfreeOrderId: existing.cashfreeOrderId,
            paymentSessionId: existing.paymentSessionId,
            amount: existing.amount,
            currency: existing.currency,
            status: existing.status,
          },
        };
      }
    }

    this.logger.log(`Initiating payment creation for studentCode: ${dto.studentCode}, amount: ₹${dto.amount}`);

    // Check if student exists in ERP database
    let student = await this.prisma.student.findUnique({
      where: {
        studentCode: dto.studentCode,
      },
    });

    if (!student) {
      // Auto-provision test student STU001 for zero-friction development testing if DB was just migrated
      if (dto.studentCode === 'STU001') {
        this.logger.log(`Auto-provisioning test student STU001 in database for testing`);
        try {
          student = await this.prisma.student.create({
            data: {
              studentCode: 'STU001',
              name: dto.customerName || 'Rahul Kumar',
              email: dto.customerEmail || 'rahul@example.com',
              phone: dto.customerPhone || '9876543210',
            },
          });
        } catch {
          // In case of race condition or existing email
          student = await this.prisma.student.findUnique({
            where: { studentCode: 'STU001' },
          });
        }
      } else {
        throw new NotFoundException('Student not found');
      }
    }

    const orderId = this.generateOrderId();

    // 1. Create PaymentOrder record in database with CREATED status and idempotencyKey
    const paymentOrder = await this.prisma.paymentOrder.create({
      data: {
        orderId,
        studentId: student.id,
        amount: dto.amount,
        currency: 'INR',
        purpose: dto.purpose,
        status: PaymentStatus.CREATED,
        idempotencyKey: idempotencyKey || null,
      },
    });

    try {
      // 2. Call Cashfree PG Sandbox to create payment order & session
      const cashfreeOrder = await this.cashfreeService.createOrder({
        orderId,
        amount: dto.amount,
        customerId: student.studentCode,
        customerName: dto.customerName,
        customerEmail: dto.customerEmail,
        customerPhone: dto.customerPhone,
      });

      // 3. Update database with Cashfree order ID & payment_session_id (Status: PENDING)
      const updatedPayment = await this.prisma.paymentOrder.update({
        where: {
          id: paymentOrder.id,
        },
        data: {
          cashfreeOrderId: cashfreeOrder.order_id,
          paymentSessionId: cashfreeOrder.payment_session_id,
          status: PaymentStatus.PENDING,
        },
      });

      this.logger.log(`Payment order successfully created: orderId=${orderId}, paymentSessionId=${updatedPayment.paymentSessionId}`);

      return {
        success: true,
        data: {
          orderId: updatedPayment.orderId,
          cashfreeOrderId: updatedPayment.cashfreeOrderId,
          paymentSessionId: updatedPayment.paymentSessionId,
          amount: updatedPayment.amount,
          currency: updatedPayment.currency,
          status: updatedPayment.status,
        },
      };
    } catch (error) {
      this.logger.error(`Cashfree order creation failed for ${orderId}: ${error.message}`);
      await this.prisma.paymentOrder.update({
        where: {
          id: paymentOrder.id,
        },
        data: {
          status: PaymentStatus.FAILED,
        },
      });

      throw error;
    }
  }

  async getPayment(orderId: string) {
    const paymentOrder = await this.prisma.paymentOrder.findUnique({
      where: {
        orderId,
      },
      include: {
        transactions: true,
      },
    });

    if (!paymentOrder) {
      throw new NotFoundException('Payment order not found');
    }

    return {
      success: true,
      data: {
        orderId: paymentOrder.orderId,
        amount: paymentOrder.amount,
        currency: paymentOrder.currency,
        purpose: paymentOrder.purpose,
        status: paymentOrder.status,
        cashfreeOrderId: paymentOrder.cashfreeOrderId,
        transactions: paymentOrder.transactions,
      },
    };
  }

  async verifyPayment(orderId: string) {
    const paymentOrder = await this.prisma.paymentOrder.findUnique({
      where: {
        orderId,
      },
    });

    if (!paymentOrder) {
      throw new NotFoundException('Payment order not found');
    }

    if (!paymentOrder.cashfreeOrderId) {
      throw new BadRequestException('Cashfree order not created');
    }

    const cashfreeOrder = await this.cashfreeService.getOrder(
      paymentOrder.cashfreeOrderId,
    );

    const cashfreeStatus = cashfreeOrder.order_status;
    const newStatus = this.mapCashfreeOrderStatus(cashfreeStatus);

    if (!this.canTransition(paymentOrder.status, newStatus)) {
      return {
        success: true,
        message: 'Payment already reached a final state',
        data: {
          orderId,
          status: paymentOrder.status,
        },
      };
    }

    const updated = await this.prisma.paymentOrder.update({
      where: {
        id: paymentOrder.id,
      },
      data: {
        status: newStatus,
      },
    });

    return {
      success: true,
      data: {
        orderId: updated.orderId,
        previousStatus: paymentOrder.status,
        currentStatus: updated.status,
        cashfreeStatus,
      },
    };
  }

  private mapCashfreeOrderStatus(status: string): PaymentStatus {
    switch (status) {
      case 'PAID':
        return PaymentStatus.SUCCESS;
      case 'ACTIVE':
        return PaymentStatus.PENDING;
      case 'EXPIRED':
        return PaymentStatus.EXPIRED;
      default:
        return PaymentStatus.PENDING;
    }
  }

  private canTransition(
    current: PaymentStatus,
    next: PaymentStatus,
  ): boolean {
    if (
      current === PaymentStatus.SUCCESS ||
      current === PaymentStatus.CANCELLED ||
      current === PaymentStatus.EXPIRED
    ) {
      return false;
    }

    return true;
  }

  private generateOrderId(): string {
    const timestamp = Date.now();
    const random = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

    return `UMS_${timestamp}_${random}`;
  }
}
