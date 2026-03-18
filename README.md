# LA PRESENTAZIONE - Residence Space Reservation

Complete web app to manage shared-space reservations in a residence.

## Features

- TV Room and Music Room availability
- unlimited booking hours (no opening/closing time restrictions)
- reservation creation with field validation
- maximum reservation duration: 4 hours
- booking window: from today up to 30 days ahead
- automatic overlap prevention for same space/date
- existing reservations list shows all active (not expired) bookings
- user-defined cancellation PIN (4-8 digits)
- reservation cancellation restricted to owner (cancellation PIN + room number + full name)
- local JSON persistence (no database required)
- automatic daily cleanup at midnight (removes reservations from previous dates)

## Requirements

- Node.js 18 or newer
- npm

## Local quick start

```bash
cd /Users/gms/residenza-prenotazioni
npm install
npm run dev
```

Open `http://localhost:3000/reservation` in your browser.

## Data persistence

Data is stored locally in:

- `data/spaces.json`
- `data/reservations.json`

No `DATABASE_URL` is needed.

Midnight cleanup:

- at day rollover, all reservations with `date < today` are deleted automatically
- default timezone: `Europe/Rome`
- optional env var: `APP_TIMEZONE` (example: `APP_TIMEZONE=Europe/Rome`)

## AWS Amplify Hosting setup (Express / web compute)

1. Push this repository to GitHub (including `amplify.yml` and `deploy-manifest.json`).
2. In Amplify, create a new app from the repository.
3. Deploy.

Important:

- the Amplify build uses Node.js 22 (`amplify.yml`)
- the output bundle is generated in `.amplify-hosting`
- app URL must include `/reservation`

## Available scripts

- `npm start`: start server
- `npm run dev`: start in watch mode
- `npm run reset-data`: reset reservations and reseed local JSON data

## Structure

- `server.js`: backend API + frontend static hosting
- `public/`: web UI (`index.html`, `styles.css`, `app.js`)
- `scripts/reset-data.js`: reset JSON data
- `lib/default-data.js`: default space dataset
- `lib/file-store.js`: local JSON read/write helpers

## Main API routes

- `GET /reservation/api/spaces`
- `GET /reservation/api/reservations?activeOnly=true`
- `POST /reservation/api/reservations`
  - requires `cancellationPin` (4-8 digits)
  - rejects reservations longer than 4 hours
  - accepts dates only in range: today ... today + 30 days
- `DELETE /reservation/api/reservations/:id`
  - requires `cancellationPin`, `roomNumber`, `residentName`
