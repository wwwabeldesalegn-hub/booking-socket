Express Mongo Cab API

Quick start

1. Copy env

```
cp .env.example .env
```

2. Start server

```
npm start
```

If local Mongo is not available, the app falls back to in-memory Mongo.

API Highlights
- Auth: `/api/v1/auth/*`
- Bookings CRUD, lifecycle, estimate: `/api/v1/bookings/*`
- Drivers CRUD, availability, nearby: `/api/v1/drivers/*`
- Assignments CRUD: `/api/v1/assignments/*`
- Trips CRUD: `/api/v1/trips/*`
- Live positions: `/api/v1/live/*`
- Pricing CRUD and real-time updates: `/api/v1/pricing/*`

Socket.io broadcasts:
- `driver:position`, `pricing:update`, `booking:update`, `booking:assigned`

Environment Variables

- `MONGO_URI`: Mongo connection string
- `JWT_SECRET`: HMAC secret when JWKS is not used
- `AUTH_JWKS_URL`: JWKS endpoint for RS256 tokens
- `AUTH_AUDIENCE`: Expected audience for tokens
- `AUTH_ISSUER`: Expected issuer for tokens
- `AUTH_DEBUG`: Set `1` to enable verbose auth logs
- `AUTH_BASE_URL`: Base URL of external User Service (auth directory)
- `PASSENGER_LOOKUP_URL_TEMPLATE`: Optional template, e.g. `https://auth.example.com/passengers/{id}`
- `DRIVER_LOOKUP_URL_TEMPLATE`: Optional template, e.g. `https://auth.example.com/drivers/{id}`
- `USER_SERVICE_TIMEOUT_MS`: HTTP timeout for user service calls (default 5000)

