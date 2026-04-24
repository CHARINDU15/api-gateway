# ParcelPoint API Gateway

This gateway provides a single entry point for the frontend and external callers during local development and lightweight deployments.

## Default Port

- `8000`

## Routed Services

- `http://localhost:3001` for `/api/auth`
- `http://localhost:3002` for:
  - `/api/consignments`
  - `/api/items`
  - `/api/access-links`
  - `/api/otp`
  - `/api/locations`
  - `/api/delivery-options`
  - `/api/v1/invoices`
  - `/api/v1/scheduler`
  - `/api-docs`
- `http://localhost:3003` for `/api/notifications`

## Start

```bash
cd services/api-gateway
npm start
```

## Health Check

```bash
curl http://localhost:8000/health
```

The health response includes upstream service checks so it is easier to see whether the stack is wired correctly.
