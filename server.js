const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { defaultSpaces, defaultReservations } = require("./lib/default-data");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_BASE_PATH = "/reservation";
const PUBLIC_DIR = path.join(__dirname, "public");

const DATA_DIR = path.join(__dirname, "data");
const SPACES_FILE = path.join(DATA_DIR, "spaces.json");
const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const MAX_RESERVATION_MINUTES = 4 * 60;

let writeQueue = Promise.resolve();

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return cloneData(fallback);
    }
    throw error;
  }
}

async function ensureFile(filePath, fallback) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeJson(filePath, fallback);
      return;
    }
    throw error;
  }
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await ensureFile(SPACES_FILE, defaultSpaces);
  await ensureFile(RESERVATIONS_FILE, defaultReservations);
}

function withWriteLock(task) {
  const run = writeQueue.then(() => task());
  writeQueue = run.catch(() => undefined);
  return run;
}

function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours * 60) + minutes;
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

function toPublicReservation(reservation) {
  const { cancellationCode, cancellationPinHash, ...publicReservation } = reservation;
  return publicReservation;
}

function sortReservations(reservations) {
  return reservations.slice().sort((a, b) => {
    const first = `${a.date}T${a.startTime}`;
    const second = `${b.date}T${b.startTime}`;
    return first.localeCompare(second);
  });
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
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

function getReservationEndDate(reservation) {
  if (!isValidDate(reservation.date) || !isValidTime(reservation.endTime)) {
    return null;
  }

  const [year, month, day] = reservation.date.split("-").map(Number);
  const [hours, minutes] = reservation.endTime.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function isActiveReservation(reservation, now = new Date()) {
  const reservationEnd = getReservationEndDate(reservation);
  if (!reservationEnd) {
    return false;
  }

  return reservationEnd.getTime() >= now.getTime();
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
    const spaces = await readJson(SPACES_FILE, defaultSpaces);
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

    let reservations = await readJson(RESERVATIONS_FILE, defaultReservations);

    if (filters.spaceId) {
      reservations = reservations.filter((item) => item.spaceId === filters.spaceId);
    }

    if (filters.date) {
      reservations = reservations.filter((item) => item.date === filters.date);
    }

    if (filters.roomNumber) {
      reservations = reservations.filter((item) => (
        String(item.roomNumber || "").toLowerCase() === filters.roomNumber.toLowerCase()
      ));
    }

    if (activeOnly) {
      reservations = reservations.filter((item) => isActiveReservation(item));
    }

    res.json(sortReservations(reservations).map(toPublicReservation));
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

    const spaces = await readJson(SPACES_FILE, defaultSpaces);
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

    const createdReservation = await withWriteLock(async () => {
      const reservations = await readJson(RESERVATIONS_FILE, defaultReservations);

      const hasOverlap = reservations.some((item) => {
        if (item.spaceId !== payload.spaceId || item.date !== payload.date) {
          return false;
        }

        return (
          startMinutes < toMinutes(item.endTime)
          && endMinutes > toMinutes(item.startTime)
        );
      });

      if (hasOverlap) {
        const overlapError = new Error("The selected time slot is already booked.");
        overlapError.status = 409;
        throw overlapError;
      }

      const reservation = {
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

      reservations.push(reservation);
      await writeJson(RESERVATIONS_FILE, sortReservations(reservations));

      return reservation;
    });

    return res.status(201).json({
      message: "Reservation confirmed.",
      reservation: createdReservation
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

    const deleted = await withWriteLock(async () => {
      const reservations = await readJson(RESERVATIONS_FILE, defaultReservations);
      const index = reservations.findIndex((item) => item.id === reservationId);

      if (index === -1) {
        const notFound = new Error("Reservation not found.");
        notFound.status = 404;
        throw notFound;
      }

      if (reservations[index].cancellationPinHash !== hashText(cancellationPin)) {
        const unauthorized = new Error("Wrong cancellation PIN.");
        unauthorized.status = 401;
        throw unauthorized;
      }

      if (!sameText(reservations[index].roomNumber, roomNumber) || !sameText(reservations[index].residentName, residentName)) {
        const forbidden = new Error("Only the reservation owner can cancel this booking.");
        forbidden.status = 403;
        throw forbidden;
      }

      const [removed] = reservations.splice(index, 1);
      await writeJson(RESERVATIONS_FILE, sortReservations(reservations));

      return removed;
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

ensureDataFiles()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}${APP_BASE_PATH}`);
    });
  })
  .catch((error) => {
    console.error("Unable to start server:", error);
    process.exit(1);
  });
