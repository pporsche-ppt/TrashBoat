# Wiring QR Manager

A Render-ready QR database for physical wire/cable tracking and device pin tracking.

## What it does

- QR codes encode only the 3-digit number (example: `127` or `301`).
- Cable QR range: `100–299`.
- Device QR range: `300–999`.
- QR status: `READY`, `ACTIVE`, `DEACTIVATED`.
- Link READY QR → ACTIVE.
- Edit ACTIVE QR.
- Edit a READY QR redirects to Link behavior.
- Deactivate many QR codes at once.
- Clear data on many QR codes and return them to READY.
- Cable has exactly two connection slots.
- Each cable connection can be descriptive text, another cable QR, or a device QR + device pin.
- Device can have any number of pins.
- Device-to-device links are rejected.
- Bulk cable↔cable and cable↔device linking with an undo operation.
- Generate unused QR numbers from the database.
- Print 2 cm × 1 cm labels containing the same QR on both halves with a thin center divider and readable code text.
- Public viewing/scanning requires no admin login.
- Mutating operations require the configured admin password.

## Local run

Requires Node.js 20+ and PostgreSQL.

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env`.
3. Put your PostgreSQL connection string in `DATABASE_URL`.
4. Set a strong `JWT_SECRET` and `ADMIN_PASSWORD`.
5. Install and run:

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Render deployment

### 1. Create the PostgreSQL database

In Render:

- New → PostgreSQL
- Create the database.

Copy its **Internal Database URL** if your web service is in the same Render workspace/region, or the connection string Render provides for your service.

### 2. Create the web service

- Push this folder to GitHub.
- Render → New → Web Service.
- Select the GitHub repository.
- Runtime: Node.
- Build command:

```bash
npm install
```

- Start command:

```bash
npm start
```

### 3. Environment variables

Add:

```text
DATABASE_URL=<Render PostgreSQL URL>
JWT_SECRET=<long random secret>
ADMIN_PASSWORD=<strong admin password>
```

`PORT` is supplied by Render automatically.

### 4. Deploy

After deploy, open the Render URL. Browser camera scanning requires HTTPS; Render provides HTTPS for the web service.

## Important QR behavior

The QR itself contains only text such as:

```text
101
```

The QR does **not** contain your Render URL. Therefore you can move the website later without reprinting the QR labels.

## Public vs admin

Anyone who can reach the site can view a QR record. Link/edit/deactivate/generate/bulk operations require the admin password.

For a public internet deployment, keep your `ADMIN_PASSWORD` private and use a long random `JWT_SECRET`.
