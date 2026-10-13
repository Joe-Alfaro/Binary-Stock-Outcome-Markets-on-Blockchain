// Loaded with `--import` before any test file. The app has no default program IDs (Next fills
// them from the built IDLs), so tests that render the app providers get placeholder IDs.
process.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID ||= '11111111111111111111111111111111'
process.env.NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID ||= '11111111111111111111111111111111'
