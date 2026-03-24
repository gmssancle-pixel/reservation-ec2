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
const adminActivityRefreshBtn = document.getElementById("admin-activity-refresh-btn");
const adminLogoutBtn = document.getElementById("admin-logout-btn");
const adminMessage = document.getElementById("admin-message");
const adminActivityList = document.getElementById("admin-activity-list");
const adminActivityMessage = document.getElementById("admin-activity-message");

const BASE_PATH = "/reservation";
const MAX_RESERVATION_MINUTES = 4 * 60;
const MAX_BOOKING_DAYS_AHEAD = 30;
const PIN_PATTERN = /^\d{4,8}$/;
const APP_CONFIG = window.RESERVATION_APP_CONFIG || {};
const GA4_MEASUREMENT_ID = typeof APP_CONFIG.ga4MeasurementId === "string"
  ? APP_CONFIG.ga4MeasurementId.trim()
  : "";
let spaces = [];
let ga4InitPromise = null;

function setMessage(element, text, type = "info") {
  element.textContent = text;
  element.className = `message ${type}`;
}

function clearMessage(element) {
  setMessage(element, "", "info");
}

function isGa4Enabled() {
  return /^G-[A-Z0-9]+$/i.test(GA4_MEASUREMENT_ID);
}

function ensureGa4() {
  if (!isGa4Enabled()) {
    return Promise.resolve(false);
  }

  if (window.gtag) {
    return Promise.resolve(true);
  }

  if (ga4InitPromise) {
    return ga4InitPromise;
  }

  ga4InitPromise = new Promise((resolve, reject) => {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      window.dataLayer.push(arguments);
    };

    window.gtag("js", new Date());
    window.gtag("config", GA4_MEASUREMENT_ID, {
      anonymize_ip: true
    });

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA4_MEASUREMENT_ID)}`;
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error("Unable to load Google Analytics."));
    document.head.append(script);
  }).catch((error) => {
    console.error(error);
    return false;
  });

  return ga4InitPromise;
}

async function trackAnalyticsEvent(eventName, parameters = {}) {
  if (!isGa4Enabled()) {
    return;
  }

  const ready = await ensureGa4();
  if (!ready || !window.gtag) {
    return;
  }

  window.gtag("event", eventName, parameters);
}

function setAdminAuthenticated(authenticated) {
  adminLoginForm.hidden = authenticated;
  adminActions.hidden = !authenticated;

  if (authenticated) {
    adminPasswordInput.value = "";
    return;
  }

  adminActivityList.innerHTML = "";
  clearMessage(adminActivityMessage);
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

function getLeadDays(targetDate) {
  const diffMs = toUTCDateMs(targetDate) - toUTCDateMs(todayAsISO());
  return Number.isFinite(diffMs) ? Math.round(diffMs / (24 * 60 * 60 * 1000)) : undefined;
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

function formatDateTime(dateValue) {
  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return dateValue;
  }

  return parsedDate.toLocaleString("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatActivityAction(item) {
  if (item.action === "reservation_create") {
    return item.status === "success" ? "Reservation created" : "Reservation denied";
  }

  if (item.action === "reservation_cancel") {
    return item.status === "success" ? "Reservation cancelled" : "Cancellation denied";
  }

  if (item.action === "admin_login") {
    return item.status === "success" ? "Admin login" : "Admin login denied";
  }

  if (item.action === "admin_logout") {
    return "Admin logout";
  }

  if (item.action === "admin_export") {
    return "Admin export";
  }

  return item.action;
}

function renderActivityLog(items) {
  adminActivityList.innerHTML = "";

  if (items.length === 0) {
    setMessage(adminActivityMessage, "No activity found yet.", "info");
    return;
  }

  clearMessage(adminActivityMessage);

  items.forEach((item) => {
    const listItem = document.createElement("li");
    listItem.className = "activity-item";

    const title = document.createElement("p");
    title.className = "activity-title";
    title.textContent = `${formatActivityAction(item)} (${item.status})`;

    const actor = document.createElement("p");
    actor.className = "activity-meta";
    actor.textContent = item.actorName
      ? `${item.actorName}${item.actorRoomNumber ? ` | Room ${item.actorRoomNumber}` : ""}`
      : "No user identity captured";

    const reservation = document.createElement("p");
    reservation.className = "activity-meta";
    reservation.textContent = [
      item.spaceId ? `Space: ${getSpaceName(item.spaceId)}` : "",
      item.reservationDate ? `Date: ${item.reservationDate}` : "",
      item.startTime && item.endTime ? `Time: ${item.startTime}/${item.endTime}` : ""
    ].filter(Boolean).join(" | ");

    const details = document.createElement("p");
    details.className = "activity-meta";
    details.textContent = [
      item.details,
      item.sourceIp ? `IP: ${item.sourceIp}` : "",
      `At: ${formatDateTime(item.createdAt)}`
    ].filter(Boolean).join(" | ");

    listItem.append(title, actor, reservation, details);
    adminActivityList.append(listItem);
  });
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

async function loadAdminActivity() {
  setMessage(adminActivityMessage, "Loading activity...", "info");
  const items = await apiRequest(`${BASE_PATH}/api/admin/activity?limit=100`);
  renderActivityLog(items);
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

    void trackAnalyticsEvent("reservation_created", {
      space_id: payload.spaceId,
      lead_days: getLeadDays(payload.date),
      duration_minutes: endMinutes - startMinutes
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
    if (error.message === "The selected time slot is already booked.") {
      void trackAnalyticsEvent("reservation_conflict", {
        space_id: payload.spaceId,
        lead_days: getLeadDays(payload.date)
      });
    }

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

    void trackAnalyticsEvent("reservation_cancelled");

    setMessage(formMessage, "Reservation deleted successfully.", "success");
    await loadReservations();
  } catch (error) {
    setMessage(formMessage, error.message, "error");
  }
}

async function syncAdminSession() {
  const result = await apiRequest(`${BASE_PATH}/api/admin/session`);
  setAdminAuthenticated(Boolean(result.authenticated));

  if (result.authenticated) {
    await loadAdminActivity();
  }
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
    await loadAdminActivity();
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

async function handleAdminActivityRefresh() {
  clearMessage(adminMessage);

  try {
    await loadAdminActivity();
  } catch (error) {
    if (error.message === "Admin authentication required.") {
      setAdminAuthenticated(false);
    }

    setMessage(adminActivityMessage, error.message, "error");
  }
}

async function bootstrap() {
  configureDateLimits();
  setMessage(listMessage, "Loading reservations...", "info");
  void ensureGa4();

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
adminActivityRefreshBtn.addEventListener("click", handleAdminActivityRefresh);
adminLogoutBtn.addEventListener("click", handleAdminLogout);

bootstrap();
