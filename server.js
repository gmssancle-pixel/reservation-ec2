const express = require("express");
const path = require("path");
const crypto = require("crypto");
const {
  initializeFileStore,
  loadSpaces,
  loadReservations,
  saveReservations
} = require("./lib/file-store");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_BASE_PATH = "/reservation";
const PUBLIC_DIR = path.join(__dirname, "public");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const MAX_RESERVATION_MINUTES = 4 * 60;

let mutationQueue = Promise.resolve();

function withMutationLock(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch(() => undefined);
  return run;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === (month - 1)
    && date.getUTCDate() === day
  );
}

function isValidTime(value) {
  if (!TIME_PATTERN.test(value)) {
    return false;
  }

  const [hours, minutes] = value.split(":").map(Number);

  return (
    Number.isInteger(hours)
    && Number.isInteger(minutes)
    && hours >= 0
    && hours <= 23
    && minutes >= 0
    && minutes <= 59
  );
}

function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours * 60) + minutes;
}

function toPublicReservation(reservation) {
  const { cancellationPinHash, ...publicReservation } = reservation;
  return publicReservation;
}

function hasAvailabilityWindow(space) {
  return isValidTime(space.openTime) && isValidTime(space.closeTime);
}

function sameText(first, second) {
  return normalizeString(first).toLowerCase() === normalizeString(second).toLowerCase();
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isReservationActive(reservation, nowMs) {
  const endDateTime = new Date(`${reservation.date}T${reservation.endTime}:00`);

  if (Number.isNaN(endDateTime.getTime())) {
    return false;
  }

  return endDateTime.getTime() >= nowMs;
}

app.use(express.json());

app.get("/", (_req, res) => {
  res.redirect(APP_BASE_PATH);
});

app.get(APP_BASE_PATH, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use(APP_BASE_PATH, express.static(PUBLIC_DIR));

app.get(`${APP_BASE_PATH}/api/health`, (_req, res) => {
  res.json({ status: "ok" });
});

app.get(`${APP_BASE_PATH}/api/spaces`, async (_req, res, next) => {
  try {
    const spaces = await loadSpaces();
    res.json(spaces);
  } catch (error) {
    next(error);
  }
});

app.get(`${APP_BASE_PATH}/api/reservations`, async (req, res, next) => {
  try {
    const activeOnly = normalizeString(req.query.activeOnly).toLowerCase() === "true";
    const filters = {
      spaceId: normalizeString(req.query.spaceId),
      date: normalizeString(req.query.date),
      roomNumber: normalizeString(req.query.roomNumber)
    };

    if (filters.date && !isValidDate(filters.date)) {
      return res.status(400).json({ error: "Invalid date filter. Use YYYY-MM-DD format." });
    }

    const nowMs = Date.now();
    let reservations = await loadReservations();

    if (filters.spaceId) {
      reservations = reservations.filter((reservation) => reservation.spaceId === filters.spaceId);
    }

    if (filters.date) {
      reservations = reservations.filter((reservation) => reservation.date === filters.date);
    }

    if (filters.roomNumber) {
      const roomNumberLower = filters.roomNumber.toLowerCase();
      reservations = reservations.filter((reservation) => reservation.roomNumber.toLowerCase() === roomNumberLower);
    }

    if (activeOnly) {
      reservations = reservations.filter((reservation) => isReservationActive(reservation, nowMs));
    }

    reservations.sort((first, second) => {
      const dateCompare = first.date.localeCompare(second.date);
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return first.startTime.localeCompare(second.startTime);
    });

    res.json(reservations.map(toPublicReservation));
  } catch (error) {
    next(error);
  }
});

app.post(`${APP_BASE_PATH}/api/reservations`, async (req, res, next) => {
  try {
    const payload = {
      spaceId: normalizeString(req.body.spaceId),
      date: normalizeString(req.body.date),
      startTime: normalizeString(req.body.startTime),
      endTime: normalizeString(req.body.endTime),
      residentName: normalizeString(req.body.residentName),
      roomNumber: normalizeString(req.body.roomNumber),
      cancellationPin: normalizeString(req.body.cancellationPin),
      note: normalizeString(req.body.note)
    };

    const requiredFields = [
      ["spaceId", payload.spaceId],
      ["date", payload.date],
      ["startTime", payload.startTime],
      ["endTime", payload.endTime],
      ["residentName", payload.residentName],
      ["roomNumber", payload.roomNumber],
      ["cancellationPin", payload.cancellationPin]
    ];

    const missingField = requiredFields.find(([, value]) => !value);
    if (missingField) {
      return res.status(400).json({ error: `Missing required field: ${missingField[0]}` });
    }

    if (!isValidDate(payload.date)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD format." });
    }

    if (!isValidTime(payload.startTime) || !isValidTime(payload.endTime)) {
      return res.status(400).json({ error: "Invalid time. Use HH:MM format." });
    }

    const startMinutes = toMinutes(payload.startTime);
    const endMinutes = toMinutes(payload.endTime);

    if (startMinutes >= endMinutes) {
      return res.status(400).json({ error: "End time must be after start time." });
    }

    if ((endMinutes - startMinutes) > MAX_RESERVATION_MINUTES) {
      return res.status(400).json({ error: "A reservation cannot be longer than 4 hours." });
    }

    if (!PIN_PATTERN.test(payload.cancellationPin)) {
      return res.status(400).json({ error: "Cancellation PIN must be 4 to 8 digits." });
    }

    const spaces = await loadSpaces();
    const selectedSpace = spaces.find((space) => space.id === payload.spaceId);

    if (!selectedSpace) {
      return res.status(404).json({ error: "Space not found." });
    }

    if (hasAvailabilityWindow(selectedSpace)) {
      const openingMinutes = toMinutes(selectedSpace.openTime);
      const closingMinutes = toMinutes(selectedSpace.closeTime);

      if (startMinutes < openingMinutes || endMinutes > closingMinutes) {
        return res.status(400).json({
          error: `This space is available between ${selectedSpace.openTime} and ${selectedSpace.closeTime}.`
        });
      }
    }

    const createdReservation = await withMutationLock(async () => {
      const reservations = await loadReservations();

      const hasOverlap = reservations.some((reservation) => (
        reservation.spaceId === payload.spaceId
        && reservation.date === payload.date
        && payload.startTime < reservation.endTime
        && payload.endTime > reservation.startTime
      ));

      if (hasOverlap) {
        const overlapError = new Error("The selected time slot is already booked.");
        overlapError.status = 409;
        throw overlapError;
      }

      const created = {
        id: crypto.randomUUID(),
        spaceId: payload.spaceId,
        date: payload.date,
        startTime: payload.startTime,
        endTime: payload.endTime,
        residentName: payload.residentName,
        roomNumber: payload.roomNumber,
        note: payload.note,
        cancellationPinHash: hashText(payload.cancellationPin),
        createdAt: new Date().toISOString()
      };

      reservations.push(created);
      await saveReservations(reservations);
      return created;
    });

    return res.status(201).json({
      message: "Reservation confirmed.",
      reservation: toPublicReservation(createdReservation)
    });
  } catch (error) {
    next(error);
  }
});

app.delete(`${APP_BASE_PATH}/api/reservations/:id`, async (req, res, next) => {
  try {
    const reservationId = normalizeString(req.params.id);
    const cancellationPin = normalizeString(req.body.cancellationPin);
    const roomNumber = normalizeString(req.body.roomNumber);
    const residentName = normalizeString(req.body.residentName);

    if (!reservationId) {
      return res.status(400).json({ error: "Invalid reservation ID." });
    }

    if (!cancellationPin) {
      return res.status(400).json({ error: "Cancellation PIN is required." });
    }

    if (!PIN_PATTERN.test(cancellationPin)) {
      return res.status(400).json({ error: "Cancellation PIN must be 4 to 8 digits." });
    }

    if (!roomNumber) {
      return res.status(400).json({ error: "Room number is required." });
    }

    if (!residentName) {
      return res.status(400).json({ error: "Full name is required." });
    }

    const deleted = await withMutationLock(async () => {
      const reservations = await loadReservations();
      const index = reservations.findIndex((reservation) => reservation.id === reservationId);

      if (index < 0) {
        const notFound = new Error("Reservation not found.");
        notFound.status = 404;
        throw notFound;
      }

      const reservation = reservations[index];

      if (reservation.cancellationPinHash !== hashText(cancellationPin)) {
        const unauthorized = new Error("Wrong cancellation PIN.");
        unauthorized.status = 401;
        throw unauthorized;
      }

      if (!sameText(reservation.roomNumber, roomNumber) || !sameText(reservation.residentName, residentName)) {
        const forbidden = new Error("Only the reservation owner can cancel this booking.");
        forbidden.status = 403;
        throw forbidden;
      }

      reservations.splice(index, 1);
      await saveReservations(reservations);
      return reservation;
    });

    res.json({
      message: "Reservation deleted.",
      id: deleted.id
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const statusCode = error.status || 500;
  console.error(error);
  res.status(statusCode).json({
    error: statusCode === 500 ? "Internal server error." : error.message
  });
});

initializeFileStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}${APP_BASE_PATH}`);
    });
  })
  .catch((error) => {
    console.error("Unable to start server:", error);
    process.exit(1);
  });
