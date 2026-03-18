const fs = require("fs/promises");
const path = require("path");
const { defaultSpaces, defaultReservations } = require("./default-data");

const DATA_DIR = path.join(__dirname, "..", "data");
const SPACES_FILE = path.join(DATA_DIR, "spaces.json");
const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSpace(space) {
  return {
    id: normalizeString(space.id),
    name: normalizeString(space.name),
    description: normalizeString(space.description),
    capacity: Number(space.capacity) > 0 ? Number(space.capacity) : 1,
    openTime: normalizeString(space.openTime) || null,
    closeTime: normalizeString(space.closeTime) || null
  };
}

function normalizeReservation(reservation) {
  return {
    id: normalizeString(reservation.id),
    spaceId: normalizeString(reservation.spaceId),
    date: normalizeString(reservation.date),
    startTime: normalizeString(reservation.startTime),
    endTime: normalizeString(reservation.endTime),
    residentName: normalizeString(reservation.residentName),
    roomNumber: normalizeString(reservation.roomNumber),
    note: normalizeString(reservation.note),
    cancellationPinHash: normalizeString(reservation.cancellationPinHash),
    createdAt: normalizeString(reservation.createdAt) || new Date().toISOString()
  };
}

async function writeJson(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readJsonArray(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : clone(fallback);
  } catch (error) {
    if (error.code === "ENOENT") {
      return clone(fallback);
    }

    throw error;
  }
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const spaces = await readJsonArray(SPACES_FILE, defaultSpaces);
  if (spaces.length === 0) {
    await writeJson(SPACES_FILE, clone(defaultSpaces));
  } else {
    await writeJson(SPACES_FILE, spaces.map(normalizeSpace));
  }

  const reservations = await readJsonArray(RESERVATIONS_FILE, defaultReservations);
  await writeJson(RESERVATIONS_FILE, reservations.map(normalizeReservation));
}

async function initializeFileStore() {
  await ensureDataFiles();
}

async function loadSpaces() {
  const spaces = await readJsonArray(SPACES_FILE, defaultSpaces);
  return spaces.map(normalizeSpace);
}

async function loadReservations() {
  const reservations = await readJsonArray(RESERVATIONS_FILE, defaultReservations);
  return reservations.map(normalizeReservation);
}

async function saveReservations(reservations) {
  await writeJson(RESERVATIONS_FILE, reservations.map(normalizeReservation));
}

async function resetFileStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJson(SPACES_FILE, clone(defaultSpaces));
  await writeJson(RESERVATIONS_FILE, clone(defaultReservations));
}

module.exports = {
  initializeFileStore,
  loadSpaces,
  loadReservations,
  saveReservations,
  resetFileStore
};
