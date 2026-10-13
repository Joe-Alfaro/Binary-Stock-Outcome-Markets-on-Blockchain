/**
 * Checked-in NYSE full-day holidays and 1:00 PM ET early closes, as published by the exchange.
 * Extending coverage means adding a year here and moving `CALENDAR_LAST_YEAR` in `index.ts`.
 */
export interface CalendarYear {
  holidays: readonly string[]
  earlyCloses: readonly string[]
}

export const NYSE_CALENDAR: Readonly<Record<number, CalendarYear>> = {
  2026: {
    holidays: [
      '2026-01-01', // New Year's Day
      '2026-01-19', // Martin Luther King, Jr. Day
      '2026-02-16', // Washington's Birthday
      '2026-04-03', // Good Friday
      '2026-05-25', // Memorial Day
      '2026-06-19', // Juneteenth
      '2026-07-03', // Independence Day (observed)
      '2026-09-07', // Labor Day
      '2026-11-26', // Thanksgiving
      '2026-12-25', // Christmas
    ],
    earlyCloses: [
      '2026-11-27', // Day after Thanksgiving
      '2026-12-24', // Christmas Eve
    ],
  },
  2027: {
    holidays: [
      '2027-01-01', // New Year's Day
      '2027-01-18', // Martin Luther King, Jr. Day
      '2027-02-15', // Washington's Birthday
      '2027-03-26', // Good Friday
      '2027-05-31', // Memorial Day
      '2027-06-18', // Juneteenth (observed)
      '2027-07-05', // Independence Day (observed)
      '2027-09-06', // Labor Day
      '2027-11-25', // Thanksgiving
      '2027-12-24', // Christmas (observed)
    ],
    earlyCloses: [
      '2027-11-26', // Day after Thanksgiving
    ],
  },
}
