import { expect, test } from "bun:test";
import { connectHeldConflictPins, registerHeldConflictPin, type ExtraPinRegistrar } from "./heldConflictPins";

test("held conflicts register as extraPins predicates and unregister with the adapter", async () => {
  let check: ((owner: string, id: string) => boolean | Promise<boolean>) | undefined;
  let active = true;
  const register: ExtraPinRegistrar = (candidate) => {
    check = candidate;
    return () => { active = false; };
  };
  const unregister = connectHeldConflictPins(register);
  await registerHeldConflictPin("did:owner", "note-a");
  expect(await check!("did:owner", "note-a")).toBe(true);
  expect(await check!("did:owner", "note-b")).toBe(false);
  unregister();
  expect(active).toBe(false);
});
