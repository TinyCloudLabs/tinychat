// Test runs only (bunfig.toml preloads this): tests that do not pass acceptLegacyOwnerHeader run with
// BOTS_ACCEPT_LEGACY_OWNER_HEADER=1.
process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER ??= "1";
