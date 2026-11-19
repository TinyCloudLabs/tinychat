// Test runs only (bunfig.toml preloads this): the tests written before signed calls use the legacy bearer secret
// plus `x-tinycloud-owner`, so their createApp accepts it as a deploy with BOTS_ACCEPT_LEGACY_OWNER_HEADER=1 does.
// The signed-call tests set the option explicitly.
process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER ??= "1";
