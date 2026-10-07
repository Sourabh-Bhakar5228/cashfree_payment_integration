# UMS Cashfree Payment Module

A production-oriented backend payment module for a University Management System (UMS / ERP) using **NestJS, PostgreSQL, Prisma ORM, and Cashfree Payment Gateway**.

The module handles payment order creation, payment lifecycle tracking, webhook processing, idempotency, transaction history, server-side reconciliation, error handling, and secure payment state management.

---

## Project Status

- ✅ Cashfree Sandbox integration
- ✅ Payment order creation
- ✅ Cashfree payment session generation
- ✅ Payment status tracking
- ✅ Payment transaction history
- ✅ Signed Cashfree webhook processing
- ✅ HMAC-SHA256 webhook verification
- ✅ Timing-safe signature comparison
- ✅ Webhook idempotency
- ✅ Payment creation idempotency
- ✅ Multi-attempt transaction ledger
- ✅ Server-side payment reconciliation
- ✅ PostgreSQL + Prisma persistence
- ✅ Swagger / OpenAPI documentation
- ✅ Global validation and exception handling
- ✅ Docker & Docker Compose support
- ✅ Jest unit tests
- ✅ Database migrations

---

## Features

- Cashfree Sandbox integration
- Payment order creation and payment session generation
- Payment lifecycle management
- Payment status tracking
- Multiple payment attempts per business order
- Cashfree asynchronous webhook processing
- HMAC-SHA256 webhook signature verification
- Timing-safe signature comparison using `crypto.timingSafeEqual`
- Idempotent webhook processing
- Client-side payment creation idempotency using `Idempotency-Key`
- Server-side Cashfree payment reconciliation
- PostgreSQL persistence using Prisma ORM
- Centralized exception handling
- Request validation using `class-validator`
- Swagger API documentation
- Dockerized deployment
- Health check endpoint
- Secure environment-based credential management

---

## Tech Stack

| Technology | Purpose |
|---|---|
| NestJS | Backend framework |
| TypeScript | Programming language |
| PostgreSQL 16 | Relational database |
| Prisma ORM | Database ORM and migrations |
| Cashfree PG | Payment gateway |
| Docker | Containerization |
| Docker Compose | Local service orchestration |
| Jest | Unit testing |
| Swagger / OpenAPI | API documentation |
| Axios | Cashfree API communication |

---

## Architecture

```text
                    ┌───────────────────┐
                    │   ERP / Frontend  │
                    └─────────┬─────────┘
                              │
                              │ Create Payment
                              ▼
                    ┌───────────────────┐
                    │    NestJS API     │
                    │                   │
                    │ Payment Module    │
                    │ Cashfree Module   │
                    └───────┬─────┬─────┘
                            │     │
                 ┌──────────┘     └──────────────┐
                 ▼                               ▼
        ┌────────────────┐              ┌─────────────────┐
        │  PostgreSQL    │              │    Cashfree     │
        │                │              │  Payment Gateway│
        │ Orders         │              └────────┬────────┘
        │ Transactions   │                       │
        │ Webhook Events │                       │ Webhook
        └────────────────┘                       │
                                                 ▼
                                      ┌──────────────────┐
                                      │ Webhook Endpoint │
                                      │ Signature Verify │
                                      │ Idempotency      │
                                      │ Status Update    │
                                      └──────────────────┘
```

---

## Payment Flow

```text
1. ERP requests payment creation
                ↓
2. Backend validates request
                ↓
3. Student is validated
                ↓
4. Internal PaymentOrder is created
   Status = CREATED
                ↓
5. Cashfree Create Order API
                ↓
6. Cashfree returns payment_session_id
                ↓
7. PaymentOrder updated
   Status = PENDING
                ↓
8. Customer completes payment
                ↓
9. Cashfree sends signed webhook
                ↓
10. Backend verifies webhook signature
                ↓
11. Duplicate event check
                ↓
12. PaymentTransaction created/updated
                ↓
13. PaymentOrder status updated
                ↓
14. ERP reads final payment status
```

---

## Payment Status Lifecycle

Allowed lifecycle:
```text
CREATED
   │
   ▼
PENDING
 ┌─┼───────────────┐
 ▼ ▼               ▼
SUCCESS FAILED   CANCELLED
                  │
                  └── EXPIRED
```

Typical transitions:
- `CREATED`  → `PENDING`
- `PENDING`  → `SUCCESS`
- `PENDING`  → `FAILED`
- `PENDING`  → `CANCELLED`
- `PENDING`  → `EXPIRED`

Terminal payment states are protected from invalid downgrades:
- `SUCCESS` → `PENDING`   ❌
- `SUCCESS` → `FAILED`    ❌
- `CANCELLED` → `SUCCESS` ❌
- `EXPIRED` → `SUCCESS`   ❌

Repeated events for an already-settled payment are treated as idempotent / no-op operations.

---

## API Endpoints

### 1. Create Payment Order
`POST /api/v1/payments`

#### Headers
```http
Content-Type: application/json
Idempotency-Key: unique-client-key
```
> *`Idempotency-Key` is optional but recommended for payment creation.*

#### Request
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

#### Response
```json
{
  "success": true,
  "data": {
    "orderId": "UMS_1791374556043_6KO5JC",
    "cashfreeOrderId": "UMS_1791374556043_6KO5JC",
    "paymentSessionId": "session_...",
    "amount": "500.00",
    "currency": "INR",
    "status": "PENDING"
  }
}
```

---

### 2. Get Payment Status
`GET /api/v1/payments/:orderId`

Returns the current payment order, status and transaction history.

#### Example Response
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
    "transactions": []
  }
}
```

---

### 3. Verify / Reconcile Payment
`POST /api/v1/payments/:orderId/verify`

This endpoint performs server-side verification against Cashfree.  
It is useful when:
- Webhook delivery is delayed
- Webhook delivery fails
- ERP needs an explicit reconciliation
- Payment status needs to be confirmed directly with the gateway

#### Example Response
```json
{
  "success": true,
  "data": {
    "orderId": "UMS_...",
    "previousStatus": "PENDING",
    "currentStatus": "PENDING",
    "cashfreeStatus": "ACTIVE"
  }
}
```

---

### 4. Cashfree Webhook
`POST /api/v1/payments/webhook/cashfree`

The webhook endpoint receives asynchronous payment updates from Cashfree.

#### Required Headers
```http
x-webhook-signature: <computed-signature>
x-webhook-timestamp: <timestamp>
```

The backend:
1. Reads the raw request body.
2. Builds the expected HMAC-SHA256 signature.
3. Compares the signature using timing-safe comparison.
4. Checks webhook idempotency.
5. Identifies the payment order.
6. Creates the payment transaction record.
7. Applies valid payment state transitions.
8. Marks the webhook event as processed.

---

### 5. Health Check
`GET /api/v1/health`

Used for service health monitoring.

---

### 6. Swagger Documentation
`http://localhost:3000/api/docs`

Swagger provides interactive API documentation and allows the payment APIs to be tested directly.

---

## Database Design

The database is designed around four primary entities.

### Student
Represents a university/ERP student.  
**Important fields**:
- `id`
- `studentCode` (UNIQUE)
- `name`
- `email` (UNIQUE)
- `phone`

### PaymentOrder
Represents the business-level payment order.  
**Important fields**:
- `id`
- `orderId` (UNIQUE)
- `studentId`
- `amount`
- `currency`
- `purpose`
- `status`
- `cashfreeOrderId`
- `paymentSessionId`
- `idempotencyKey` (UNIQUE)
- `expiresAt`

> *A business payment order is kept separate from individual gateway payment attempts.*

### PaymentTransaction
Represents an individual payment attempt.  
**Important fields**:
- `id`
- `paymentOrderId`
- `cashfreePaymentId` (UNIQUE)
- `amount`
- `status`
- `paymentMethod`
- `gatewayResponse`

This supports multiple payment attempts for the same business order.
```text
PaymentOrder
     │
     ├── Transaction #1 → UPI → FAILED
     │
     ├── Transaction #2 → Card → FAILED
     │
     └── Transaction #3 → NetBanking → SUCCESS
```

### PaymentWebhookEvent
Stores webhook events for auditing and idempotency.  
**Important fields**:
- `id`
- `eventId` (UNIQUE)
- `eventType`
- `orderId`
- `payload`
- `signature`
- `processed`
- `processedAt`
- `createdAt`

---

## Idempotency

### Payment Creation
The API supports:
```http
Idempotency-Key: unique-client-key
```
If the same request is retried using the same idempotency key, the existing payment order is returned instead of creating another Cashfree order.  
This protects against:
- Double-clicks
- Client retries
- Network retry behaviour
- Duplicate ERP requests

### Webhook Idempotency
Webhook payloads are deterministically fingerprinted using SHA-256.  
The generated event identifier is stored with a database `UNIQUE` constraint.  
Therefore, repeated webhook deliveries do not create duplicate payment mutations.

---

## Security

The implementation includes the following security measures:

### Environment-based Credentials
Cashfree credentials are never hardcoded.
```env
CASHFREE_APP_ID=
CASHFREE_SECRET_KEY=
```
`.env` is excluded from Git using `.gitignore`.

### HMAC-SHA256 Webhook Verification
Webhook signatures are cryptographically verified before processing:
```text
Webhook
   ↓
Raw Body
   ↓
Timestamp + Raw Body
   ↓
HMAC-SHA256
   ↓
Compare with Cashfree Signature
   ↓
Process / Reject
```

### Timing-safe Comparison
Signature comparison uses:
```typescript
crypto.timingSafeEqual()
```
to avoid timing-based comparison vulnerabilities.

### Raw Request Body
NestJS is configured with:
```typescript
rawBody: true
```
This preserves the original request payload required for cryptographic signature verification.

### Input Validation
Requests are validated using NestJS `ValidationPipe` and `class-validator`:
- Email validation
- Phone validation
- Positive payment amount
- Required fields
- String validation

---

## Failure & Edge Case Handling

- **Successful Payment**: `PENDING` → `SUCCESS`
- **Failed Payment**: `PENDING` → `FAILED`  
  *(The transaction attempt is recorded while keeping the business order capable of supporting another payment attempt where applicable.)*
- **Cancelled Payment**: `PENDING` → `CANCELLED`
- **Expired Payment**: `PENDING` → `EXPIRED`
- **Duplicate Webhook**: Duplicate webhook events are safely ignored without applying duplicate database mutations.
- **Duplicate Payment Request**: Repeated requests with the same `Idempotency-Key` return the existing payment order.
- **Invalid Webhook Signature**: Invalid signatures are rejected before payment data is processed:
  ```text
  Invalid Signature
         ↓
  401 Unauthorized
         ↓
  No Payment Mutation
  ```
- **Unknown Payment Order**: Handled using controlled application errors instead of uncontrolled database failures.
- **Cashfree API Failure**: Gateway failures are isolated using controlled `BadGatewayException` responses while preserving the internal payment record.

---

## Server-side Reconciliation

Webhook processing is the primary asynchronous payment update mechanism. However, the system also supports direct server-side reconciliation:
```text
ERP
 │
 │ Verify Payment
 ▼
NestJS
 │
 ▼
Cashfree API
 │
 ▼
Current Gateway Status
 │
 ▼
PaymentOrder Update
```
This provides protection against delayed or missed webhook deliveries.

---

## Webhook as Source of Truth

Payment completion should not depend only on a frontend redirect.  
Frontend redirects can be:
- Interrupted
- Closed by the customer
- Manipulated
- Delayed

Therefore, payment state is maintained through:
1. Signed Cashfree webhooks
2. Server-side Cashfree verification
3. Database state validation

This ensures the ERP payment status is not blindly trusted from the frontend.

---

## Monetary Precision

Payment amounts are stored using:
```prisma
Decimal(12,2)
```
instead of floating-point values. This prevents monetary precision issues during payment processing.

---

## Local Setup

### 1. Clone Repository
```bash
git clone https://github.com/Sourabh-Bhakar5228/cashfree_payment_integration.git
cd cashfree_payment_integration
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
Create `.env`:
```env
PORT=3000

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cashfree_ums?schema=public"

CASHFREE_APP_ID=your_sandbox_app_id
CASHFREE_SECRET_KEY=your_sandbox_secret_key
CASHFREE_ENVIRONMENT=sandbox
CASHFREE_API_VERSION=2025-01-01

REDIS_URL=redis://localhost:6379
```
> *Never commit `.env` to GitHub.*

### 4. Start PostgreSQL
Using Docker:
```bash
docker compose up -d postgres
```

### 5. Generate Prisma Client
```bash
npx prisma generate
```

### 6. Run Database Migration
```bash
npx prisma db push
```

### 7. Start Application
```bash
npm run start:dev
```

- Application: `http://localhost:3000`
- Swagger: `http://localhost:3000/api/docs`

---

## Docker Setup

The project includes Docker support.

Run:
```bash
docker compose up -d --build
```

This starts:
- `cashfree-postgres`
- `cashfree-payment-api`

Check running containers:
```bash
docker ps
```

---

## Testing

Run unit tests:
```bash
npm test
```

Run tests with coverage:
```bash
npm run test:cov
```

Build production application:
```bash
npm run build
```

---

## Sandbox Verification

The integration has been tested against the Cashfree Sandbox environment.

- **Create Payment (`POST /api/v1/payments`)**: Successfully creates a Cashfree payment order and returns a `payment_session_id`.
- **Payment Status (`GET /api/v1/payments/:orderId`)**: The created sandbox order was successfully returned with `PENDING`.
- **Server-side Verification (`POST /api/v1/payments/:orderId/verify`)**: Cashfree returned `ACTIVE`, and the internal payment remained `PENDING` (expected since the sandbox order had not yet completed a successful payment).

### Example Payment Lifecycle
```text
Create Payment
      │
      ▼
Internal Order Created
      │
      ▼
Cashfree Order Created
      │
      ▼
PENDING
      │
      ├───────────────┐
      │               │
      ▼               ▼
Successful         Failed
Payment            Payment
      │               │
      ▼               ▼
  SUCCESS           FAILED
```

---

## Design Decisions

### PaymentOrder vs PaymentTransaction
A business payment order is different from a gateway transaction attempt.  
This allows the system to support:
```text
One Business Order
        │
        ├── Attempt 1 → FAILED
        ├── Attempt 2 → FAILED
        └── Attempt 3 → SUCCESS
```
This design provides a proper payment history and retry model.

### Webhook + Reconciliation
Webhooks provide asynchronous payment updates while the reconciliation endpoint provides a server-side fallback. This combination improves reliability when webhook delivery is delayed or unavailable.

### Database Constraints
Unique constraints are used for important identifiers:
- `Student.studentCode`
- `Student.email`
- `PaymentOrder.orderId`
- `PaymentOrder.idempotencyKey`
- `PaymentTransaction.cashfreePaymentId`
- `PaymentWebhookEvent.eventId`

This provides database-level protection against duplicate records.

---

## Future Improvements

For a larger production deployment, the following improvements can be added:
- Redis-based distributed locking
- BullMQ background reconciliation workers
- Automatic payment reconciliation scheduler
- Dead-letter queue for failed webhook processing
- Prometheus metrics & Grafana dashboards
- Structured logging & Distributed tracing
- Rate limiting
- AWS/Azure deployment & Horizontal scaling
- Automated integration tests against sandbox
- Payment notification service
- Alerting for reconciliation mismatches

---

## Project Structure

```text
src/
├── cashfree/
│   ├── cashfree.module.ts
│   └── cashfree.service.ts
│
├── payments/
│   ├── dto/
│   │   └── create-payment.dto.ts
│   ├── payments.controller.ts
│   ├── payments.service.ts
│   ├── payments.module.ts
│   ├── webhook.service.ts
│   └── payments.service.spec.ts
│
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts
│
├── health/
│   ├── health.controller.ts
│   └── health.module.ts
│
├── common/
│   └── filters/
│       └── http-exception.filter.ts
│
├── app.module.ts
└── main.ts

prisma/
└── schema.prisma

Dockerfile
docker-compose.yml
.env.example
README.md
```

---

## API Summary

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/v1/payments` | Create Cashfree payment order |
| `GET` | `/api/v1/payments/:orderId` | Get payment status and transaction history |
| `POST` | `/api/v1/payments/:orderId/verify` | Server-side gateway reconciliation |
| `POST` | `/api/v1/payments/webhook/cashfree` | Cashfree webhook listener |
| `GET` | `/api/v1/health` | Health check probe |
| `GET` | `/api/docs` | Swagger OpenAPI documentation |

---

## Submission

**GitHub Repository**:  
👉 [https://github.com/Sourabh-Bhakar5228/cashfree_payment_integration](https://github.com/Sourabh-Bhakar5228/cashfree_payment_integration)

---

## Conclusion

This project demonstrates a backend-oriented payment architecture for a University Management System with:
- Secure Cashfree integration
- Reliable payment state management
- Webhook-driven updates
- Idempotent request handling
- Transaction-level payment history
- Server-side reconciliation
- PostgreSQL persistence
- Prisma migrations
- API documentation
- Automated testing
- Docker support
- Production-oriented error and security handling
