# UMS Cashfree Payment Module

A production-oriented backend payment module for a University Management System (UMS / ERP) using NestJS, PostgreSQL, Prisma ORM, and Cashfree Payment Gateway.

## Features

- Cashfree Sandbox integration (API version 2025-01-01)
- Payment order creation & session generation
- Payment status tracking & history
- Cashfree asynchronous webhook processing
- HMAC-SHA256 webhook signature verification with timing-safe comparison
- Idempotent webhook processing (deterministic event deduplication)
- Server-side payment status reconciliation
- Duplicate payment protection using `Idempotency-Key`
- Multi-attempt transaction ledger
- PostgreSQL persistence with Prisma ORM
- Interactive Swagger OpenAPI documentation
- Containerized Docker & Docker Compose setup
- Global validation and centralized error handling

## Tech Stack

- **Framework**: NestJS (v10)
- **Language**: TypeScript
- **Database**: PostgreSQL 16
- **ORM**: Prisma ORM (v5)
- **Payment Gateway**: Cashfree Payment Gateway (PG Sandbox)
- **Containerization**: Docker & Docker Compose
- **Testing**: Jest
- **API Specs**: Swagger / OpenAPI

## Architecture

```text
ERP / Frontend
      |
      v
NestJS Payment API
      |
      +---- PostgreSQL
      |
      +---- Cashfree
                |
                v
             Webhook
                |
                v
         Payment Verification
```

## Payment Flow

1. ERP requests payment creation (`POST /api/v1/payments`).
2. Backend validates student existence, amount, and request parameters.
3. Backend creates an internal payment order (status: `CREATED`).
4. Backend invokes Cashfree PG Create Order API (`POST /pg/orders`).
5. Cashfree returns a `payment_session_id`.
6. Frontend checkout uses the session to initiate payment.
7. Cashfree dispatches payment updates through signed webhooks.
8. Backend verifies cryptographic webhook signature (`x-webhook-signature`).
9. Backend verifies webhook idempotency (event hash check).
10. Backend stores the gateway transaction attempt.
11. Backend updates the internal payment status using state transition validation.
12. ERP queries final payment status (`GET /api/v1/payments/:orderId`) or reconciles on-demand (`POST /api/v1/payments/:orderId/verify`).

## API Endpoints

### 1. Create Payment Order
`POST /api/v1/payments`
- Headers (Optional): `Idempotency-Key: <client_key>`
- Request Body:
```json
{
  "studentCode": "STU001",
  "amount": 500,
  "purpose": "Semester Fee",
  "customerName": "Rahul Kumar",
  "customerEmail": "rahul@example.com",
  "customerPhone": "9876543210"
}
```
- Response (201 Created):
```json
{
  "success": true,
  "data": {
    "orderId": "UMS_1791374556043_6KO5JC",
    "cashfreeOrderId": "UMS_1791374556043_6KO5JC",
    "paymentSessionId": "session_UMS_...",
    "amount": "500.00",
    "currency": "INR",
    "status": "PENDING"
  }
}
```

### 2. Get Payment Status
`GET /api/v1/payments/:orderId`
- Response (200 OK):
```json
{
  "success": true,
  "data": {
    "orderId": "UMS_1791374556043_6KO5JC",
    "amount": "500.00",
    "currency": "INR",
    "purpose": "Semester Fee",
    "status": "SUCCESS",
    "cashfreeOrderId": "UMS_1791374556043_6KO5JC",
    "transactions": [...]
  }
}
```

### 3. Verify Payment with Cashfree Gateway
`POST /api/v1/payments/:orderId/verify`
- Reconciles status directly with Cashfree and updates DB.

### 4. Cashfree Webhook Listener
`POST /api/v1/payments/webhook/cashfree`
- Headers:
  - `x-webhook-signature`: HMAC-SHA256 digest
  - `x-webhook-timestamp`: Webhook timestamp

### 5. Health Check
`GET /api/v1/health`

### 6. Interactive Swagger Documentation
`GET /api/docs`

## Environment Variables

```env
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cashfree_ums?schema=public
CASHFREE_APP_ID=your_sandbox_app_id
CASHFREE_SECRET_KEY=your_sandbox_secret_key
CASHFREE_ENVIRONMENT=sandbox
CASHFREE_API_VERSION=2025-01-01
REDIS_URL=redis://localhost:6379
```

## Local Setup

```bash
# 1. Clone repository
git clone <repository-url>
cd cashfree-payment-module

# 2. Install dependencies
npm install

# 3. Environment configuration
cp .env.example .env

# 4. Generate Prisma Client & Migrate
npx prisma generate
npx prisma migrate dev

# 5. Start Development Server
npm run start:dev
```

Swagger UI: [http://localhost:3000/api/docs](http://localhost:3000/api/docs)

## Docker Setup

```bash
docker compose up -d --build
```

Runs:
- `cashfree-postgres`: PostgreSQL 16
- `cashfree-payment-api`: NestJS Payment Module

## Database Design

- **`Student`**: ERP Student profile (`studentCode` UNIQUE, name, email, phone).
- **`PaymentOrder`**: High-level payment order (`orderId` UNIQUE, `idempotencyKey` UNIQUE, `amount` Decimal(12,2), status).
- **`PaymentTransaction`**: Individual payment attempts (`cashfreePaymentId` UNIQUE, status, method, gateway response).
- **`PaymentWebhookEvent`**: Audit trail & idempotency store (`eventId` UNIQUE, eventType, payload, signature, processed).

## Idempotency

- **Payment Creation**: Supports client `Idempotency-Key` header. Duplicate requests return existing payment records without creating duplicate Cashfree orders.
- **Webhook Events**: Uses deterministic SHA-256 event hash stored with a database UNIQUE constraint to prevent duplicate processing.

## Security

- Cashfree credentials stored exclusively in environment variables (`.env`).
- HMAC-SHA256 signature verification with constant-time comparison (`crypto.timingSafeEqual`).
- Raw request body preserved (`rawBody: true`) for cryptographic digest parity.
- Strict input validation using NestJS `ValidationPipe` and `class-validator`.
- Finite state machine prevents illegal status overwrites.

## Failure & Edge Case Handling

- **Successful Payments**: Transitions order `PENDING` -> `SUCCESS`.
- **Failed Payments**: Transitions attempt to `FAILED` without breaking retry ability.
- **Cancelled / Expired Payments**: Marked terminal.
- **Duplicate Webhooks**: Safely acknowledged with `200 OK` without duplicate DB mutations.
- **Duplicate Payment Creation**: Existing order returned via `idempotencyKey`.
- **Invalid Webhook Signatures**: Immediately rejected with `401 Unauthorized`.
- **Unknown Orders**: Gracefully handled with controlled error responses.
- **Gateway Outages**: Isolated with `BadGatewayException`, preserving internal database integrity.

## Design Decisions

- **PaymentOrder vs PaymentTransaction**: A business payment order is kept distinct from gateway transactions because a single business order can have multiple payment attempts (e.g., initial UPI failure followed by successful NetBanking retry).
- **Webhook as Single Source of Truth**: Frontend redirects can be dropped or manipulated; asynchronous signed webhooks and server-side verification guarantee financial ledger consistency.
- **Monetary Precision**: Stored as `Decimal(12, 2)` instead of floating-point numbers to prevent precision errors.

## Future Improvements

- Redis-based distributed locking for multi-instance horizontal scaling
- Background reconciliation worker with BullMQ
- Prometheus / Grafana observability & metrics
- Dead-letter queues for failed webhook processing
