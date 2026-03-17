# LA PRESENTAZIONE - Residence Space Reservation

Complete web app to manage shared-space reservations in a residence.

## Features

- TV Room and Music Room availability
- unlimited booking hours (no opening/closing time restrictions)
- reservation creation with field validation
- maximum reservation duration: 4 hours
- automatic overlap prevention for same space/date
- existing reservations list shows all active (not expired) bookings
- user-defined cancellation PIN (4-8 digits)
- reservation cancellation restricted to owner (cancellation PIN + room number + full name)
- local JSON data persistence

## Requirements

- Node.js 18 or newer
- npm

## Quick start

```bash
cd /Users/gms/residenza-prenotazioni
npm install
npm run dev
```

Open `http://localhost:3000/reservation` in your browser.

## Available scripts

- `npm start`: start server
- `npm run dev`: start in watch mode
- `npm run reset-data`: reset spaces and reservations

## Structure

- `server.js`: backend API + frontend static hosting
- `public/`: web UI (`index.html`, `styles.css`, `app.js`)
- `data/`: data files (`spaces.json`, `reservations.json`)
- `scripts/reset-data.js`: reset seed data
- `lib/default-data.js`: default dataset

## Main API routes

- `GET /reservation/api/spaces`
- `GET /reservation/api/reservations?spaceId=...&date=YYYY-MM-DD`
  - supports `activeOnly=true` to return only active reservations
- `POST /reservation/api/reservations`
  - requires `cancellationPin` (4-8 digits)
  - rejects reservations longer than 4 hours
- `DELETE /reservation/api/reservations/:id`
  - requires `cancellationPin`, `roomNumber`, `residentName`
