const bookingForm = document.getElementById("booking-form");
const spaceSelect = document.getElementById("spaceId");
const dateInput = document.getElementById("date");
const startTimeInput = document.getElementById("startTime");
const endTimeInput = document.getElementById("endTime");
const residentNameInput = document.getElementById("residentName");
const roomNumberInput = document.getElementById("roomNumber");
const cancellationPinInput = document.getElementById("cancellationPin");
const noteInput = document.getElementById("note");
const formMessage = document.getElementById("form-message");
const listMessage = document.getElementById("list-message");
const reservationsList = document.getElementById("reservations-list");
const refreshBtn = document.getElementById("refresh-btn");
const adminLoginForm = document.getElementById("admin-login-form");
const adminUsernameInput = document.getElementById("admin-username");
const adminPasswordInput = document.getElementById("admin-password");
const adminActions = document.getElementById("admin-actions");
const adminExportBtn = document.getElementById("admin-export-btn");
const adminLogoutBtn = document.getElementById("admin-logout-btn");
const adminMessage = document.getElementById("admin-message");

const BASE_PATH = "/reservation";
const MAX_RESERVATION_MINUTES = 4 * 60;
const MAX_BOOKING_DAYS_AHEAD = 30;
const PIN_PATTERN = /^\d{4,8}$/;
let spaces = [];

function setMessage(element, text, type = "info") {
  element.textContent = text;
  element.className = `message ${type}`;
}

function clearMessage(element) {
  setMessage(element, "", "info");
}

function setAdminAuthenticated(authenticated) {
  adminLoginForm.hidden = authenticated;
  adminActions.hidden = !authenticated;

  if (authenticated) {
    adminPasswordInput.value = "";
  }
}

function toMinutes(time) {
  if (!time || !time.includes(":")) {
    return NaN;
  }

  const [hours, minutes] = time.split(":").map(Number);
  return (hours * 60) + minutes;
}

function todayAsISO() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

function addDaysToISODate(dateValue, daysToAdd) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().slice(0, 10);
}

function toUTCDateMs(dateValue) {
  if (!dateValue || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return Number.NaN;
  }

  const [year, month, day] = dateValue.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function configureDateLimits() {
  const today = todayAsISO();
  const maxDate = addDaysToISODate(today, MAX_BOOKING_DAYS_AHEAD);
  dateInput.min = today;
  dateInput.max = maxDate;

  if (!dateInput.value || dateInput.value < today || dateInput.value > maxDate) {
    dateInput.value = today;
  }
}

async function apiRequest(url, options = {}) {
  const config = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };

  const response = await fetch(url, config);
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = {};
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function getDownloadFilename(contentDisposition, fallback) {
  const match = /filename="([^"]+)"/i.exec(contentDisposition || "");
  return match ? match[1] : fallback;
}

async function downloadAdminExport() {
  const response = await fetch(`${BASE_PATH}/api/admin/export`);
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    let errorMessage = "Request failed.";

    if (contentType.includes("application/json")) {
      const payload = await response.json();
      errorMessage = payload.error || errorMessage;
    } else {
      const text = await response.text();
      if (text) {
        errorMessage = text;
      }
    }

    throw new Error(errorMessage);
  }

  const blob = await response.blob();
  const downloadUrl = window.URL.createObjectURL(blob);
  const fileName = getDownloadFilename(
    response.headers.get("content-disposition"),
    `reservations-export-${todayAsISO()}.json`
  );
  const link = document.createElement("a");

  link.href = downloadUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(downloadUrl);
}

function getSpaceName(spaceId) {
  const space = spaces.find((item) => item.id === spaceId);
  return space ? space.name : spaceId;
}

function renderSpaces() {
  spaceSelect.innerHTML = "";

  spaces.forEach((space) => {
    const option = document.createElement("option");
    option.value = space.id;
    option.textContent = space.name;
    spaceSelect.append(option);
  });
}

function renderReservations(items) {
  reservationsList.innerHTML = "";

  if (items.length === 0) {
    setMessage(listMessage, "No reservations found for the selected filters.", "info");
    return;
  }

  clearMessage(listMessage);

  items.forEach((item) => {
    const listItem = document.createElement("li");
    listItem.className = "reservation-item";

    const textWrap = document.createElement("div");

    const title = document.createElement("p");
    title.className = "reservation-title";
    title.textContent = `${getSpaceName(item.spaceId)} - ${item.startTime}/${item.endTime}`;

    const meta = document.createElement("p");
    meta.className = "reservation-meta";
    meta.textContent = `${item.date} | ${item.residentName} (Room ${item.roomNumber})${item.note ? ` | Note: ${item.note}` : ""}`;

    const idLine = document.createElement("p");
    idLine.className = "reservation-meta";
    idLine.textContent = `Reservation ID: ${item.id}`;

    textWrap.append(title, meta, idLine);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "cancel-btn";
    deleteBtn.dataset.id = item.id;
    deleteBtn.textContent = "Cancel";

    listItem.append(textWrap, deleteBtn);
    reservationsList.append(listItem);
  });
}

async function loadSpaces() {
  spaces = await apiRequest(`${BASE_PATH}/api/spaces`);
  renderSpaces();
}

async function loadReservations() {
  const params = new URLSearchParams({
    activeOnly: "true"
  });

  const reservations = await apiRequest(`${BASE_PATH}/api/reservations?${params.toString()}`);
  renderReservations(reservations);
}

async function handleBookingSubmit(event) {
  event.preventDefault();
  clearMessage(formMessage);

  const payload = {
    spaceId: spaceSelect.value,
    date: dateInput.value,
    startTime: startTimeInput.value,
    endTime: endTimeInput.value,
    residentName: residentNameInput.value,
    roomNumber: roomNumberInput.value,
    cancellationPin: cancellationPinInput.value,
    note: noteInput.value
  };

  const startMinutes = toMinutes(payload.startTime);
  const endMinutes = toMinutes(payload.endTime);

  if (Number.isNaN(startMinutes) || Number.isNaN(endMinutes)) {
    setMessage(formMessage, "Please select a valid start and end time.", "error");
    return;
  }

  if ((endMinutes - startMinutes) > MAX_RESERVATION_MINUTES) {
    setMessage(formMessage, "A reservation cannot be longer than 4 hours.", "error");
    return;
  }

  if (!PIN_PATTERN.test(payload.cancellationPin)) {
    setMessage(formMessage, "Cancellation PIN must be 4 to 8 digits.", "error");
    return;
  }

  const minDate = dateInput.min;
  const maxDate = dateInput.max;
  const selectedDateMs = toUTCDateMs(payload.date);
  const minDateMs = toUTCDateMs(minDate);
  const maxDateMs = toUTCDateMs(maxDate);
  if (!Number.isFinite(selectedDateMs) || selectedDateMs < minDateMs || selectedDateMs > maxDateMs) {
    setMessage(formMessage, `Date must be between ${minDate} and ${maxDate}.`, "error");
    return;
  }

  try {
    const result = await apiRequest(`${BASE_PATH}/api/reservations`, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    setMessage(
      formMessage,
      `Reservation confirmed. ID: ${result.reservation.id}. Keep your cancellation PIN safe.`,
      "success"
    );

    startTimeInput.value = "";
    endTimeInput.value = "";
    cancellationPinInput.value = "";
    noteInput.value = "";

    await loadReservations();
  } catch (error) {
    setMessage(formMessage, error.message, "error");
  }
}

async function handleReservationCancel(event) {
  const button = event.target.closest("button[data-id]");
  if (!button) {
    return;
  }

  const reservationId = button.dataset.id;
  const cancellationPin = window.prompt("Enter your cancellation PIN:");

  if (!cancellationPin) {
    return;
  }

  if (!PIN_PATTERN.test(cancellationPin)) {
    setMessage(formMessage, "Cancellation PIN must be 4 to 8 digits.", "error");
    return;
  }

  const roomNumber = window.prompt("Enter your room number:");
  if (!roomNumber) {
    return;
  }

  const residentName = window.prompt("Enter the full name used for the reservation:");
  if (!residentName) {
    return;
  }

  try {
    await apiRequest(`${BASE_PATH}/api/reservations/${reservationId}`, {
      method: "DELETE",
      body: JSON.stringify({
        cancellationPin,
        roomNumber,
        residentName
      })
    });

    setMessage(formMessage, "Reservation deleted successfully.", "success");
    await loadReservations();
  } catch (error) {
    setMessage(formMessage, error.message, "error");
  }
}

async function syncAdminSession() {
  const result = await apiRequest(`${BASE_PATH}/api/admin/session`);
  setAdminAuthenticated(Boolean(result.authenticated));
}

async function handleAdminLogin(event) {
  event.preventDefault();
  clearMessage(adminMessage);

  try {
    await apiRequest(`${BASE_PATH}/api/admin/login`, {
      method: "POST",
      body: JSON.stringify({
        username: adminUsernameInput.value,
        password: adminPasswordInput.value
      })
    });

    setAdminAuthenticated(true);
    setMessage(adminMessage, "Admin session active.", "success");
  } catch (error) {
    setAdminAuthenticated(false);
    setMessage(adminMessage, error.message, "error");
  }
}

async function handleAdminLogout() {
  clearMessage(adminMessage);

  try {
    await apiRequest(`${BASE_PATH}/api/admin/logout`, {
      method: "POST"
    });

    setAdminAuthenticated(false);
    setMessage(adminMessage, "Admin session closed.", "info");
  } catch (error) {
    setMessage(adminMessage, error.message, "error");
  }
}

async function handleAdminExport() {
  clearMessage(adminMessage);

  try {
    await downloadAdminExport();
    setMessage(adminMessage, "Export downloaded successfully.", "success");
  } catch (error) {
    if (error.message === "Admin authentication required.") {
      setAdminAuthenticated(false);
    }

    setMessage(adminMessage, error.message, "error");
  }
}

async function bootstrap() {
  configureDateLimits();
  setMessage(listMessage, "Loading reservations...", "info");

  try {
    await loadSpaces();
    await loadReservations();
    await syncAdminSession();
  } catch (error) {
    setMessage(listMessage, error.message, "error");
  }
}

bookingForm.addEventListener("submit", handleBookingSubmit);
adminLoginForm.addEventListener("submit", handleAdminLogin);
spaceSelect.addEventListener("change", loadReservations);
dateInput.addEventListener("change", loadReservations);
reservationsList.addEventListener("click", handleReservationCancel);
refreshBtn.addEventListener("click", loadReservations);
adminExportBtn.addEventListener("click", handleAdminExport);
adminLogoutBtn.addEventListener("click", handleAdminLogout);

bootstrap();
