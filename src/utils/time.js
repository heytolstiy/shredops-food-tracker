// Moscow is permanently UTC+3 with no DST (since March 2014).
// Using a fixed offset avoids any ICU/locale dependency on the host.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function todayMSK() {
  return new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { todayMSK };
