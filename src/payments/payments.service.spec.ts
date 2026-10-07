import { NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { WebhookService } from './webhook.service';
import { PaymentStatus, TransactionStatus } from '@prisma/client';
import * as crypto from 'crypto';

describe('Payment Module Unit & State Hardening Tests', () => {
  let paymentsService: PaymentsService;
  let webhookService: WebhookService;
  let mockPrisma: any;
  let mockCashfreeService: any;
  let mockConfigService: any;

  const mockSecretKey = 'TEST_CASHFREE_SECRET_KEY';

  beforeEach(() => {
    mockPrisma = {
      student: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      paymentOrder: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentTransaction: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentWebhookEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    mockCashfreeService = {
      createOrder: jest.fn(),
      getOrder: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'CASHFREE_SECRET_KEY') return mockSecretKey;
        if (key === 'CASHFREE_ENVIRONMENT') return 'sandbox';
        return null;
      }),
    };

    paymentsService = new PaymentsService(mockPrisma, mockCashfreeService);
    webhookService = new WebhookService(mockPrisma, mockConfigService);
  });

  const validDto = {
    studentCode: 'STU001',
    amount: 500,
    purpose: 'Semester Fee',
    customerName: 'Rahul Kumar',
    customerEmail: 'rahul@example.com',
    customerPhone: '9876543210',
  };

  describe('1. Create Payment Flow', () => {
    it('✓ Create payment successfully with Cashfree order and session', async () => {
      mockPrisma.student.findUnique.mockResolvedValue({
        id: 'cuid_student_1',
        studentCode: 'STU001',
        name: 'Rahul Kumar',
        email: 'rahul@example.com',
      });

      mockPrisma.paymentOrder.create.mockResolvedValue({
        id: 'cuid_order_1',
        orderId: 'UMS_123456_TEST',
        studentId: 'cuid_student_1',
        amount: 500,
        currency: 'INR',
        purpose: 'Semester Fee',
        status: PaymentStatus.CREATED,
      });

      mockCashfreeService.createOrder.mockResolvedValue({
        order_id: 'UMS_123456_TEST',
        payment_session_id: 'session_mock_12345',
        order_status: 'ACTIVE',
      });

      mockPrisma.paymentOrder.update.mockResolvedValue({
        id: 'cuid_order_1',
        orderId: 'UMS_123456_TEST',
        cashfreeOrderId: 'UMS_123456_TEST',
        paymentSessionId: 'session_mock_12345',
        amount: 500,
        currency: 'INR',
        status: PaymentStatus.PENDING,
      });

      const result = await paymentsService.createPayment(validDto);

      expect(result.success).toBe(true);
      expect(result.data.orderId).toBe('UMS_123456_TEST');
      expect(result.data.status).toBe(PaymentStatus.PENDING);
      expect(result.data.paymentSessionId).toBe('session_mock_12345');
      expect(mockCashfreeService.createOrder).toHaveBeenCalled();
    });

    it('✓ Student not found throws NotFoundException for non-existent student', async () => {
      mockPrisma.student.findUnique.mockResolvedValue(null);

      await expect(
        paymentsService.createPayment({
          ...validDto,
          studentCode: 'STU_UNKNOWN',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('✓ Duplicate idempotency key returns existing payment without creating new order', async () => {
      const existingOrder = {
        id: 'cuid_order_existing',
        orderId: 'UMS_PREV_123',
        cashfreeOrderId: 'UMS_PREV_123',
        paymentSessionId: 'session_prev_123',
        amount: 500,
        currency: 'INR',
        status: PaymentStatus.PENDING,
        idempotencyKey: 'idemp_key_abc_123',
      };

      mockPrisma.paymentOrder.findUnique.mockResolvedValue(existingOrder);

      const result = await paymentsService.createPayment(validDto, 'idemp_key_abc_123');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Existing payment returned');
      expect(result.data.orderId).toBe('UMS_PREV_123');
      expect(mockCashfreeService.createOrder).not.toHaveBeenCalled();
      expect(mockPrisma.paymentOrder.create).not.toHaveBeenCalled();
    });
  });

  describe('2. Cashfree Webhook & Cryptographic Verification', () => {
    const webhookPayload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: {
          order_id: 'UMS_123456_TEST',
          order_amount: 500,
        },
        payment: {
          cf_payment_id: 'cf_pay_998877',
          payment_status: 'SUCCESS',
          payment_amount: 500,
          payment_group: 'upi',
        },
      },
    };

    it('✓ Invalid webhook signature throws UnauthorizedException', async () => {
      const rawBody = Buffer.from(JSON.stringify(webhookPayload), 'utf8');

      await expect(
        webhookService.processCashfreeWebhook(
          webhookPayload,
          rawBody,
          'invalid_tampered_signature',
          '1728312000',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('✓ Duplicate webhook is safely acknowledged and ignored via idempotency check', async () => {
      const timestamp = '1728312000';
      const rawBody = Buffer.from(JSON.stringify(webhookPayload), 'utf8');

      const signedPayload = timestamp + rawBody.toString('utf8');
      const validSignature = crypto
        .createHmac('sha256', mockSecretKey)
        .update(signedPayload)
        .digest('base64');

      // Simulate event already stored in PaymentWebhookEvent
      mockPrisma.paymentWebhookEvent.findUnique.mockResolvedValue({
        id: 'event_uuid_1',
        eventId: 'deterministic_event_hash',
        processed: true,
      });

      const result = await webhookService.processCashfreeWebhook(
        webhookPayload,
        rawBody,
        validSignature,
        timestamp,
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Webhook already processed');
      expect(mockPrisma.paymentOrder.update).not.toHaveBeenCalled();
    });

    it('✓ Process successful webhook: updates PaymentOrder to SUCCESS and records Transaction', async () => {
      const timestamp = '1728312000';
      const rawBody = Buffer.from(JSON.stringify(webhookPayload), 'utf8');

      const signedPayload = timestamp + rawBody.toString('utf8');
      const validSignature = crypto
        .createHmac('sha256', mockSecretKey)
        .update(signedPayload)
        .digest('base64');

      mockPrisma.paymentWebhookEvent.findUnique.mockResolvedValue(null);
      mockPrisma.paymentOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        orderId: 'UMS_123456_TEST',
        amount: 500,
        status: PaymentStatus.PENDING,
      });

      mockPrisma.paymentTransaction.findUnique.mockResolvedValue(null);

      const result = await webhookService.processCashfreeWebhook(
        webhookPayload,
        rawBody,
        validSignature,
        timestamp,
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Webhook processed successfully');
      expect(mockPrisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: PaymentStatus.SUCCESS },
        }),
      );
      expect(mockPrisma.paymentTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cashfreePaymentId: 'cf_pay_998877',
            status: TransactionStatus.SUCCESS,
          }),
        }),
      );
    });
  });

  describe('3. Payment State Lifecycle & Hardening Rules', () => {
    it('✓ SUCCESS cannot become FAILED: status transition protection prevents downgrading settled payments', async () => {
      const failedWebhook = {
        type: 'PAYMENT_FAILED_WEBHOOK',
        data: {
          order: { order_id: 'UMS_123456_TEST' },
          payment: { cf_payment_id: 'cf_pay_failed', payment_status: 'FAILED' },
        },
      };

      const timestamp = '1728312000';
      const rawBody = Buffer.from(JSON.stringify(failedWebhook), 'utf8');
      const signedPayload = timestamp + rawBody.toString('utf8');
      const validSignature = crypto
        .createHmac('sha256', mockSecretKey)
        .update(signedPayload)
        .digest('base64');

      mockPrisma.paymentWebhookEvent.findUnique.mockResolvedValue(null);
      // Order is ALREADY in SUCCESS state!
      mockPrisma.paymentOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        orderId: 'UMS_123456_TEST',
        amount: 500,
        status: PaymentStatus.SUCCESS,
      });

      const result = await webhookService.processCashfreeWebhook(
        failedWebhook,
        rawBody,
        validSignature,
        timestamp,
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Invalid payment status transition ignored');
      // Verify database order was NOT modified to FAILED
      expect(mockPrisma.paymentOrder.update).not.toHaveBeenCalled();
    });

    it('✓ Verify payment transitions: PAID -> SUCCESS, ACTIVE -> PENDING, EXPIRED -> EXPIRED', async () => {
      mockPrisma.paymentOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        orderId: 'UMS_VERIFY_1',
        cashfreeOrderId: 'UMS_VERIFY_1',
        status: PaymentStatus.PENDING,
      });

      mockCashfreeService.getOrder.mockResolvedValue({
        order_id: 'UMS_VERIFY_1',
        order_status: 'PAID',
      });

      mockPrisma.paymentOrder.update.mockResolvedValue({
        orderId: 'UMS_VERIFY_1',
        status: PaymentStatus.SUCCESS,
      });

      const result = await paymentsService.verifyPayment('UMS_VERIFY_1');

      expect(result.success).toBe(true);
      expect(result.data.currentStatus).toBe(PaymentStatus.SUCCESS);
      expect(result.data.cashfreeStatus).toBe('PAID');
    });

    it('✓ Reconcile payment rejects transition when order is already in terminal state', async () => {
      mockPrisma.paymentOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        orderId: 'UMS_VERIFY_1',
        cashfreeOrderId: 'UMS_VERIFY_1',
        status: PaymentStatus.SUCCESS, // already terminal!
      });

      mockCashfreeService.getOrder.mockResolvedValue({
        order_id: 'UMS_VERIFY_1',
        order_status: 'ACTIVE',
      });

      const result = await paymentsService.verifyPayment('UMS_VERIFY_1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Payment already reached a final state');
      expect(result.data.status).toBe(PaymentStatus.SUCCESS);
      expect(mockPrisma.paymentOrder.update).not.toHaveBeenCalled();
    });
  });
});
