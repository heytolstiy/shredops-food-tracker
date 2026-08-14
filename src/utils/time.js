// Moscow is permanently UTC+3 with no DST (since March 2014).
// Using a fixed offset avoids any ICU/locale dependency on the host.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function todayMSK() {
  return new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

function yesterdayMSK() {
  return new Date(Date.now() + MSK_OFFSET_MS - 86_400_000).toISOString().slice(0, 10);
}

// Current wall-clock time in MSK, as a Date whose UTC getters (getUTCHours()
// etc.) read as MSK local time — mirrors the todayMSK()/yesterdayMSK() offset
// trick so callers never touch the host's local timezone.
function nowMSK() {
  return new Date(Date.now() + MSK_OFFSET_MS);
}

// YYYY-MM-DD for N days before today, MSK.
function daysAgoMSK(n) {
  return new Date(Date.now() + MSK_OFFSET_MS - n * 86_400_000).toISOString().slice(0, 10);
}

module.exports = { todayMSK, yesterdayMSK, nowMSK, daysAgoMSK };
