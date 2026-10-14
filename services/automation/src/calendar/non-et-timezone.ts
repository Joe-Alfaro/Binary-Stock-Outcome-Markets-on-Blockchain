// Imported first by the R68 calendar tests, so every Date and Intl call in them runs in a zone
// that isn't America/New_York. Tokyo has no DST and is a calendar day ahead of ET every evening.
// A write, not a read: .env.example (R62) lists only the variables the code reads.
Object.assign(process.env, { TZ: 'Asia/Tokyo' })
