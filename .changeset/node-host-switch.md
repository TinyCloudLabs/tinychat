---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

TinyCloud Home and the backend treat `https://node.tinycloud.xyz` and `https://tee.node.tinycloud.xyz` as the same TinyCloud node. Stored backend grants, bot history receipts, native delegations and agent CLI profiles on either name keep working when the default node name changes. The reviewer seed and the TinyChat retrieval skill (now 0.1.1-onboarding.26) default to `https://node.tinycloud.xyz`. Production still runs on `https://tee.node.tinycloud.xyz`; nothing changes for users.

Details: TC-2923
