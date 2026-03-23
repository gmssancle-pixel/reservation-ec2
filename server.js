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
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "g14nm4rc0";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "c4st3lv3tr4n0";
const ADMIN_SESSION_COOKIE = "reservationAdminSession";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET
  || crypto.createHash("sha256").update(`admin:${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).digest("hex");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const MAX_RESERVATION_MINUTES = 4 * 60;
const MAX_BOOKING_DAYS_AHEAD = 30;
const DEFAULT_CLEANUP_TIMEZONE = "Europe/Rome";
const CLEANUP_CHECK_INTERVAL_MS = 60 * 1000;

function resolveCleanupTimeZone(candidate) {
  try {
    new Intl.DateTimeFormat("en-CA", {
      timeZone: candidate,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
    return candidate;
  } catch (_error) {
    console.warn(
      `[cleanup] Invalid APP_TIMEZONE "${candidate}". `
      + `Using ${DEFAULT_CLEANUP_TIMEZONE}.`
    );
    return DEFAULT_CLEANUP_TIMEZONE;
  }
}

const CLEANUP_TIMEZONE = resolveCleanupTimeZone(
  process.env.APP_TIMEZONE || DEFAULT_CLEANUP_TIMEZONE
);

let mutationQueue = Promise.resolve();
let lastObservedCleanupDate = null;

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

function sameSecret(first, second) {
  const firstBuffer = Buffer.from(String(first), "utf8");
  const secondBuffer = Buffer.from(String(second), "utf8");

  if (firstBuffer.length !== secondBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(";").reduce((cookies, part) => {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      return cookies;
    }

    const name = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);

    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_error) {
      cookies[name] = value;
    }

    return cookies;
  }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAgeMs !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeMs / 1000))}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join("; ");
}

function createAdminSessionToken() {
  const expiresAt = String(Date.now() + ADMIN_SESSION_TTL_MS);
  const signature = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(`${ADMIN_USERNAME}:${expiresAt}`)
    .digest("hex");

  return `${expiresAt}.${signature}`;
}

function isValidAdminSessionToken(token) {
  if (!token || typeof token !== "string") {
    return false;
  }

  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature || !/^\d+$/.test(expiresAt) || !/^[a-f0-9]+$/i.test(signature)) {
    return false;
  }

  if (Number(expiresAt) <= Date.now()) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(`${ADMIN_USERNAME}:${expiresAt}`)
    .digest("hex");

  return sameSecret(signature, expectedSignature);
}

function hasAdminSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return isValidAdminSessionToken(cookies[ADMIN_SESSION_COOKIE]);
}

function setAdminSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(ADMIN_SESSION_COOKIE, createAdminSessionToken(), {
      maxAgeMs: ADMIN_SESSION_TTL_MS,
      path: APP_BASE_PATH,
      httpOnly: true,
      sameSite: "Strict"
    })
  );
}

function clearAdminSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(ADMIN_SESSION_COOKIE, "", {
      maxAgeMs: 0,
      path: APP_BASE_PATH,
      httpOnly: true,
      sameSite: "Strict"
    })
  );
}

function requireAdminSession(req, res, next) {
  if (!hasAdminSession(req)) {
    return res.status(401).json({ error: "Admin authentication required." });
  }

  return next();
}

function getCurrentDateInTimeZone(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function addDaysToISODate(dateValue, daysToAdd) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().slice(0, 10);
}

function toUTCDateMs(dateValue) {
  if (!isValidDate(dateValue)) {
    return Number.NaN;
  }

  const [year, month, day] = dateValue.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

async function cleanupReservationsBefore(dateThreshold) {
  return withMutationLock(async () => {
    const reservations = await loadReservations();
    const thresholdMs = toUTCDateMs(dateThreshold);
    const filteredReservations = reservations.filter(
      (reservation) => {
        const reservationDateMs = toUTCDateMs(reservation.date);
        return Number.isFinite(reservationDateMs) && reservationDateMs >= thresholdMs;
      }
    );
    const removedCount = reservations.length - filteredReservations.length;

    if (removedCount > 0) {
      await saveReservations(filteredReservations);
    }

    return removedCount;
  });
}

function startDailyCleanupScheduler() {
  setInterval(async () => {
    try {
      const today = getCurrentDateInTimeZone(CLEANUP_TIMEZONE);
      if (today === lastObservedCleanupDate) {
        return;
      }

      lastObservedCleanupDate = today;
      const removedCount = await cleanupReservationsBefore(today);
      console.log(
        `[cleanup] Day rollover (${CLEANUP_TIMEZONE}). `
        + `Removed ${removedCount} reservation(s) older than ${today}.`
      );
    } catch (error) {
      console.error("[cleanup] Scheduled cleanup failed:", error);
    }
  }, CLEANUP_CHECK_INTERVAL_MS);
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

app.get(`${APP_BASE_PATH}/api/admin/session`, (req, res) => {
  res.json({ authenticated: hasAdminSession(req) });
});

app.post(`${APP_BASE_PATH}/api/admin/login`, (req, res) => {
  const username = normalizeString(req.body && req.body.username);
  const password = normalizeString(req.body && req.body.password);

  if (!sameSecret(username, ADMIN_USERNAME) || !sameSecret(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Invalid admin username or password." });
  }

  setAdminSessionCookie(res);
  return res.json({ message: "Admin authenticated." });
});

app.post(`${APP_BASE_PATH}/api/admin/logout`, (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ message: "Admin session closed." });
});

app.get(`${APP_BASE_PATH}/api/admin/export`, requireAdminSession, async (_req, res, next) => {
  try {
    const reservations = await loadReservations();
    const exportDate = getCurrentDateInTimeZone(CLEANUP_TIMEZONE);
    const payload = {
      exportedAt: new Date().toISOString(),
      timeZone: CLEANUP_TIMEZONE,
      totalReservations: reservations.length,
      reservations
    };

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="reservations-export-${exportDate}.json"`
    );
    res.type("application/json");
    res.send(JSON.stringify(payload, null, 2));
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

    const today = getCurrentDateInTimeZone(CLEANUP_TIMEZONE);
    const maxBookingDate = addDaysToISODate(today, MAX_BOOKING_DAYS_AHEAD);
    const selectedDateMs = toUTCDateMs(payload.date);
    const todayMs = toUTCDateMs(today);
    const maxBookingDateMs = toUTCDateMs(maxBookingDate);

    if (selectedDateMs < todayMs || selectedDateMs > maxBookingDateMs) {
      return res.status(400).json({
        error: `Date must be between ${today} and ${maxBookingDate}.`
      });
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
  .then(async () => {
    const today = getCurrentDateInTimeZone(CLEANUP_TIMEZONE);
    lastObservedCleanupDate = today;
    const removedCount = await cleanupReservationsBefore(today);
    console.log(
      `[cleanup] Startup cleanup (${CLEANUP_TIMEZONE}). `
      + `Removed ${removedCount} reservation(s) older than ${today}.`
    );

    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}${APP_BASE_PATH}`);
      startDailyCleanupScheduler();
    });
  })
  .catch((error) => {
    console.error("Unable to start server:", error);
    process.exit(1);
  });
