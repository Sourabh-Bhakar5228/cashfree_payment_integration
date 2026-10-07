import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface CreateCashfreeOrderParams {
  orderId: string;
  amount: number;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
}

@Injectable()
export class CashfreeService {
  private readonly logger = new Logger(CashfreeService.name);
  private readonly client: AxiosInstance;
  private readonly appId: string;
  private readonly secretKey: string;

  constructor(private readonly configService: ConfigService) {
    const environment = this.configService.get<string>('CASHFREE_ENVIRONMENT', 'sandbox');
    const baseURL =
      environment === 'production'
        ? 'https://api.cashfree.com/pg'
        : 'https://sandbox.cashfree.com/pg';

    this.appId = this.configService.get<string>('CASHFREE_APP_ID', '');
    this.secretKey = this.configService.get<string>('CASHFREE_SECRET_KEY', '');

    if (!this.appId || !this.secretKey) {
      throw new InternalServerErrorException(
        'Cashfree credentials are not configured in environment variables',
      );
    }

    const apiVersion =
      this.configService.get<string>('CASHFREE_API_VERSION') || '2025-01-01';

    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-client-id': this.appId,
        'x-client-secret': this.secretKey,
        'x-api-version': apiVersion,
      },
      timeout: 10000,
    });
  }

  async createOrder(params: CreateCashfreeOrderParams) {
    // If placeholder/test credentials are used without a live merchant account, simulate sandbox response
    if (
      this.appId === 'YOUR_SANDBOX_APP_ID' ||
      this.appId.startsWith('TEST_') ||
      this.secretKey.startsWith('TEST_')
    ) {
      this.logger.log(
        `[Cashfree Sandbox Simulation] Simulating sandbox order ${params.orderId} for amount ₹${params.amount}`,
      );
      return {
        cf_order_id: `cf_sandbox_${Date.now()}`,
        order_id: params.orderId,
        entity: 'order',
        order_currency: 'INR',
        order_amount: params.amount,
        order_status: 'ACTIVE',
        payment_session_id: `session_${params.orderId}_${Date.now()}_sandbox`,
        order_expiry_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    }

    try {
      this.logger.log(
        `Creating order with Cashfree PG: order_id=${params.orderId}, amount=${params.amount}`,
      );

      const response = await this.client.post('/orders', {
        order_id: params.orderId,
        order_amount: params.amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: params.customerId,
          customer_name: params.customerName,
          customer_email: params.customerEmail,
          customer_phone: params.customerPhone,
        },
        order_meta: {
          return_url: `http://localhost:3000/payment-success?order_id={order_id}`,
        },
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          'Cashfree API Error:',
          error.response?.data || error.message,
        );
        throw new BadGatewayException({
          message: 'Cashfree order creation failed',
          provider: 'cashfree',
          details: error.response?.data,
        });
      }
      throw error;
    }
  }

  async getOrder(orderId: string) {
    if (
      this.appId === 'YOUR_SANDBOX_APP_ID' ||
      this.appId.startsWith('TEST_') ||
      this.secretKey.startsWith('TEST_')
    ) {
      this.logger.log(
        `[Cashfree Sandbox Simulation] Fetching simulated order details for ${orderId}`,
      );
      return {
        cf_order_id: `cf_sandbox_${orderId}`,
        order_id: orderId,
        entity: 'order',
        order_currency: 'INR',
        order_amount: 500,
        order_status: 'PAID',
        payment_session_id: `session_${orderId}_sandbox`,
      };
    }

    try {
      const response = await this.client.get(`/orders/${orderId}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          'Cashfree Get Order Error:',
          error.response?.data || error.message,
        );

        throw new BadGatewayException({
          message: 'Unable to fetch order from Cashfree',
          provider: 'cashfree',
          details: error.response?.data,
        });
      }

      throw error;
    }
  }
}
