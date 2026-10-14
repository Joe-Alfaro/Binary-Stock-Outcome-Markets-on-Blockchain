// Imported first by the R68 Markets tests, so the app renders in a zone that isn't
// America/New_York. Tokyo has no DST and is a calendar day ahead of ET every evening.
process.env.TZ = 'Asia/Tokyo'
