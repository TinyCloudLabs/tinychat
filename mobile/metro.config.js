// Metro config for the @tinychat/mobile workspace inside the bun + turbo monorepo.
//
// bun uses a SINGLE hoisted node_modules at the workspace root (no nested
// per-package node_modules for hoisted deps). Metro must therefore:
//   1. watch the workspace root so it picks up files outside mobile/, and
//   2. know to resolve modules from the root node_modules (where react,
//      react-native, expo, @assistant-ui/* actually live after hoisting).
//
// See: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// 1. Watch the whole monorepo (so changes in sibling packages are picked up).
config.watchFolders = [workspaceRoot];

// 2. Let Metro resolve hoisted deps from the root node_modules first, then any
//    package-local node_modules bun may have created for un-hoistable deps.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
