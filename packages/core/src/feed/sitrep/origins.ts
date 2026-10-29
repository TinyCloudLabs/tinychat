import type { ModelSourceOrigin } from "./import-bundle";

export const SITREP_MODEL_VERSION = 1 as const;
export const SITREP_MODEL_ORIGINS: readonly ModelSourceOrigin[] = [
  {
    "path": "shared/schema.ts",
    "sha256": "c465cba94181b311f7dc66bc18b1cf3213577d34695670dca19e2f59a8ffe126"
  },
  {
    "path": "shared/board.ts",
    "sha256": "c70c0092a2722e8a5ef882786aee216cb44a739273cc589f01e0e26b9a54fd49"
  },
  {
    "path": "shared/expiry.ts",
    "sha256": "c77a1535a101c131caaa4cedec468eb9e89d8738b7d10debe292eb9a241ed4e4"
  },
  {
    "path": "shared/holds.ts",
    "sha256": "00907a3497d9a075ce194d2c82cd85a42a6287495b2017c3b880d4258152812b"
  },
  {
    "path": "shared/card-thread.ts",
    "sha256": "7fbbe2e924e57a6e166128cf129415c02ae473543470ec58d9ac50b1fa94f037"
  },
  {
    "path": "shared/recipients.ts",
    "sha256": "9e30cac4523ffb41b80cc4abbf8724a9f2a6a233b6e610e75af4b88e94d464ad"
  },
  {
    "path": "shared/deps.ts",
    "sha256": "805ad47eecf0459f322b25398dfc61d112200c954829bee28cf972ebec3c534c"
  },
  {
    "path": "shared/priority.ts",
    "sha256": "92e42341ee900d4d3dd75f67e9ca67f8bab28dc8a99f772de637a3727a8a22e3"
  },
  {
    "path": "shared/rank.ts",
    "sha256": "085f4b88b77749fea0746c9349246bd750bf2a23200da75e40f019b461f654e1"
  },
  {
    "path": "shared/priority-flag.ts",
    "sha256": "94058d70d6cd11bbfef276f6c5d2bb2f4342dc7d411dec5e1284e47c7440d1e4"
  },
  {
    "path": "shared/guard.ts",
    "sha256": "3a0b12219d7c0cdbc91ddec416920fdcc93e1ddcb2c7fb490d7990288c665653"
  },
  {
    "path": "shared/links.ts",
    "sha256": "82f1044dddc790089b56cd159f2c6d641ad1a8ded83d54b5bfce9df1967527fb"
  },
  {
    "path": "shared/known-repos.ts",
    "sha256": "22258e1ae84008fb9138cba51fd493335dda298dd1e84a1752eb01299aa643c9"
  },
  {
    "path": "shared/repos.ts",
    "sha256": "e784adbef841c3b4b60cbb5de07a7232edde6c3b0c8b5aaf3bec14e755bb2dc2"
  },
  {
    "path": "shared/groups.ts",
    "sha256": "49131587e890c4c9529ac8c42f4735d5516c6de824cbdc79b2a442d1efbac407"
  },
  {
    "path": "shared/upsert.ts",
    "sha256": "6f64c6ee6504cdbbb58cbd5c83d78f6da5bf7cfaacd81526cf39c29b72898a44"
  },
  {
    "path": "shared/agent-text.ts",
    "sha256": "f16a1acf22bd12775fa50e867d45281ebd0bdf31f30531c098d87d88e516005f"
  },
  {
    "path": "shared/metrics.ts",
    "sha256": "05de4fd27bcaa01f30b9a0005e8e215a298a7723e238f2bbc8bf398751d81e6a"
  },
  {
    "path": "cli/watch.ts",
    "sha256": "d6f819a83200fd0ae2aae3d8aa280a13f7beb53c112354223405c385456fb70b"
  },
  {
    "path": "cli/card-thread-watch.ts",
    "sha256": "233ff729a9dc4641d518a63331db0d8c4c097277b5c023c245fe28bb3b6156f8"
  },
  {
    "path": "cli/roci-board.ts",
    "sha256": "5f696ff08220c8cfe8b9d245560f14bdcdd73e5038a7ef16a1ba6311df128dcf"
  },
  { "path": "cli/holdactions.ts", "sha256": "6c926273e87494e46fb421a2ef61f313a44a044043d5c55c6ae7056f07470532" },
  { "path": "src/lib/store.ts", "sha256": "2e931e8c16cee014f59dc480a336c9e2a38c9c3945ca19154e5ea890e416730c" },
  { "path": "src/components/Claims.tsx", "sha256": "40637e115784f83d1c0aac08dd4890258ca238f5957b799d814f4d22e7794d17" },
  { "path": "src/Board.tsx", "sha256": "4664d346c14d4f12b1bb57b62a9f980fc11dcdd46a1b44b1741824c7f5cf1bc4" }
];
