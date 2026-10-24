import { describe, expect, it } from "bun:test";
import { shortNodeId } from "./nodeHostCopy";

const ID = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN1";

describe("shortNodeId", () => {
  it("skips the did:key:z6Mk prefix: the next 4 characters, then the last 4", () => {
    expect(shortNodeId(ID)).toBe("shLE…wXN1");
  });

  it("tells two IDs apart that share a prefix and differ only in the middle or the end", () => {
    expect(shortNodeId(ID.replace("shLE", "abcd"))).not.toBe(shortNodeId(ID));
    expect(shortNodeId(ID.replace(/N1$/, "N2"))).not.toBe(shortNodeId(ID));
  });

  it("shows an ID shorter than the prefix plus 8 characters in full", () => {
    expect(shortNodeId("did:key:z6Mk1234567")).toBe("did:key:z6Mk1234567");
    expect(shortNodeId("did:key:z6Mk")).toBe("did:key:z6Mk");
    expect(shortNodeId("")).toBe("");
    expect(shortNodeId("short")).toBe("short");
  });

  it("shortens an ID of exactly the prefix plus 8 characters", () => {
    expect(shortNodeId("did:key:z6MkABCDEFGH")).toBe("ABCD…EFGH");
  });

  it("shows an ID with another prefix in full", () => {
    expect(shortNodeId("did:web:example.com:with:a:long:name")).toBe("did:web:example.com:with:a:long:name");
  });
});
