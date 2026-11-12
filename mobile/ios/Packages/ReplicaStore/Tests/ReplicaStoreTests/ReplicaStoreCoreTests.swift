import CryptoKit
import Foundation
import XCTest
@testable import ReplicaStore

final class MemorySecretStore: SecretStore {
    var secrets: [String: Data] = [:]
    func load(_ id: String) throws -> Data? { secrets[id] }
    func save(_ id: String, _ secret: Data) throws { secrets[id] = secret }
    func delete(_ id: String) throws { secrets[id] = nil }
    func deleteAll() throws { secrets.removeAll() }
}

final class ReplicaStoreCoreTests: XCTestCase {
    private var directory: URL!
    private var secrets: MemorySecretStore!
    private let alice = "did:pkh:eip155:1:0x00000000000000000000000000000000000a11ce"
    private let bob = "did:pkh:eip155:1:0x0000000000000000000000000000000000000b0b"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("replica-tests-\(UUID().uuidString)", isDirectory: true)
        secrets = MemorySecretStore()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeCore() -> ReplicaStoreCore {
        ReplicaStoreCore(directory: directory, secrets: secrets, freeBytes: { 1234 })
    }

    private func assertCode(_ code: String, _ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertEqual((error as? ReplicaStoreError)?.code, code, "\(error)", file: file, line: line)
        }
    }

    private func files() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
    }

    func testPutGetRoundTrip() throws {
        let core = makeCore()
        let opened = try core.open(account: alice)
        XCTAssertEqual(opened.schemaVersion, 1)
        XCTAssertTrue(opened.created)
        try core.write([.put(store: "entries", key: "notes/a", value: "hello")])
        XCTAssertEqual(try core.get(store: "entries", key: "notes/a"), "hello")
        XCTAssertNil(try core.get(store: "entries", key: "notes/missing"))
        XCTAssertNil(try core.get(store: "meta", key: "notes/a"), "stores are separate")
        try core.write([.put(store: "entries", key: "notes/a", value: "replaced")])
        XCTAssertEqual(try core.get(store: "entries", key: "notes/a"), "replaced")
    }

    func testGetManyKeepsOrderWithMisses() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "a", value: "1"), .put(store: "s", key: "c", value: "3")])
        XCTAssertEqual(try core.getMany(store: "s", keys: ["c", "b", "a"]), ["3", nil, "1"])
    }

    func testListFiltersByPrefixSortsByUtf8BytesAndLimits() throws {
        let core = makeCore()
        try core.open(account: alice)
        // UTF-8 byte order puts "é" (0xC3 0xA9) after "z"; "notes/" excludes "notesX".
        try core.write([
            .put(store: "s", key: "notes/z", value: "z"),
            .put(store: "s", key: "notes/é", value: "e-acute"),
            .put(store: "s", key: "notes/a", value: "a"),
            .put(store: "s", key: "notesX", value: "x"),
            .put(store: "other", key: "notes/b", value: "b"),
        ])
        XCTAssertEqual(try core.list(store: "s", prefix: "notes/").map(\.key), ["notes/a", "notes/z", "notes/é"])
        XCTAssertEqual(try core.list(store: "s", prefix: "notes/", limit: 2).map(\.value), ["a", "z"])
        XCTAssertEqual(try core.list(store: "s").count, 4)
    }

    func testDeleteAndClear() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "a", value: "1"), .put(store: "s", key: "b", value: "2"),
                        .put(store: "t", key: "a", value: "3")])
        try core.write([.delete(store: "s", key: "a")])
        XCTAssertNil(try core.get(store: "s", key: "a"))
        try core.write([.clear(store: "s")])
        XCTAssertEqual(try core.list(store: "s").count, 0)
        XCTAssertEqual(try core.get(store: "t", key: "a"), "3")
    }

    func testWriteIsAtomic() throws {
        let core = makeCore()
        try core.open(account: alice)
        assertCode("INVALID_ARGUMENT") {
            try core.write([.put(store: "s", key: "a", value: "1"), .put(store: "", key: "b", value: "2")])
        }
        XCTAssertNil(try core.get(store: "s", key: "a"))
    }

    func testDataSurvivesARestart() throws {
        try makeCore().open(account: alice)
        let first = makeCore()
        try first.open(account: alice)
        try first.write([.put(store: "s", key: "k", value: "kept")])
        first.close()
        let second = makeCore()
        XCTAssertFalse(try second.open(account: alice).created)
        XCTAssertEqual(try second.get(store: "s", key: "k"), "kept")
    }

    func testAccountsAreIsolated() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "k", value: "alice")])
        try core.open(account: bob)
        XCTAssertNil(try core.get(store: "s", key: "k"))
        try core.write([.put(store: "s", key: "k", value: "bob")])
        try core.open(account: alice)
        XCTAssertEqual(try core.get(store: "s", key: "k"), "alice")
        XCTAssertNotEqual(core.databaseURL(account: alice), core.databaseURL(account: bob))
        XCTAssertEqual(secrets.secrets.count, 2)
        XCTAssertFalse(files().contains { $0.contains("a11ce") }, "file names never contain the account")
    }

    func testWipeDeletesFilesAndSecret() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "k", value: "v")])
        try core.open(account: bob)
        try core.write([.put(store: "s", key: "k", value: "v")])
        try core.wipe(account: bob)
        let aliceId = ReplicaStoreCore.accountId(alice)
        XCTAssertEqual(files().filter { !$0.hasPrefix(aliceId) }, [".installed"])
        XCTAssertNil(secrets.secrets[ReplicaStoreCore.accountId(bob)])
        XCTAssertNotNil(secrets.secrets[aliceId])
        assertCode("NOT_OPEN") { _ = try core.get(store: "s", key: "k") }
        XCTAssertTrue(try core.open(account: bob).created)
        XCTAssertNil(try core.get(store: "s", key: "k"))
        try core.wipe(account: "did:pkh:eip155:1:0xnever-opened")
    }

    func testWipeAllKeepsOnlyTheMarker() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "k", value: "v")])
        try core.open(account: bob)
        try core.wipeAll()
        XCTAssertEqual(files(), [".installed"])
        XCTAssertTrue(secrets.secrets.isEmpty)
        assertCode("NOT_OPEN") { try core.write([]) }
    }

    func testRowsAreSealedAtRest() throws {
        let core = makeCore()
        try core.open(account: alice)
        let key = "transcripts/very-secret-key-name"
        let value = "very secret transcript text"
        try core.write([.put(store: "entries", key: key, value: value)])
        core.close()
        var raw = Data()
        for name in files() where name.contains(".sqlite") {
            raw.append(try Data(contentsOf: directory.appendingPathComponent(name)))
        }
        XCTAssertFalse(raw.isEmpty)
        XCTAssertNil(raw.range(of: Data(key.utf8)), "key name is not stored in the clear")
        XCTAssertNil(raw.range(of: Data(value.utf8)), "value is not stored in the clear")
        XCTAssertNil(raw.range(of: Data(alice.utf8)), "account is not stored in the clear")
    }

    func testTamperedRowIsCorruptAndWipesTheAccount() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "k", value: "v")])
        core.close()
        let db = try SQLiteDB(path: core.databaseURL(account: alice).path)
        try db.exec("UPDATE kv SET sealed = zeroblob(64)")
        db.close()
        try core.open(account: alice)
        assertCode("CORRUPT") { _ = try core.get(store: "s", key: "k") }
        XCTAssertNil(secrets.secrets[ReplicaStoreCore.accountId(alice)])
        XCTAssertFalse(FileManager.default.fileExists(atPath: core.databaseURL(account: alice).path))
    }

    func testRowMovedToAnotherKeyIsCorrupt() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "a", value: "1"), .put(store: "s", key: "b", value: "2")])
        core.close()
        let keys = AccountKeys(secret: secrets.secrets[ReplicaStoreCore.accountId(alice)]!)
        let db = try SQLiteDB(path: core.databaseURL(account: alice).path)
        // Copy a's sealed row over b's: AAD binds the row to its kmac, so this must fail.
        try db.run("UPDATE kv SET sealed = (SELECT sealed FROM kv WHERE kmac = ?) WHERE kmac = ?",
                   [.blob(keys.kmac(store: "s", key: "a")), .blob(keys.kmac(store: "s", key: "b"))])
        db.close()
        try core.open(account: alice)
        assertCode("CORRUPT") { _ = try core.get(store: "s", key: "b") }
    }

    func testNotOpen() {
        let core = makeCore()
        assertCode("NOT_OPEN") { _ = try core.get(store: "s", key: "k") }
        assertCode("NOT_OPEN") { _ = try core.list(store: "s") }
        assertCode("NOT_OPEN") { try core.write([.clear(store: "s")]) }
        XCTAssertEqual(try core.estimate().usedBytes, 0)
    }

    func testBudgetRollsBackTheWrite() throws {
        let core = makeCore()
        try core.open(account: alice, maxBytes: 10)
        try core.write([.put(store: "s", key: "a", value: "12345")])
        assertCode("STORAGE_BUDGET") {
            try core.write([.put(store: "s", key: "b", value: "123456")])
        }
        XCTAssertNil(try core.get(store: "s", key: "b"))
        let estimate = try core.estimate()
        XCTAssertEqual(estimate.usedBytes, 5)
        XCTAssertEqual(estimate.freeBytes, 1234)
    }

    func testOverBudgetStoreCanStillShrink() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "a", value: "1234567890"), .put(store: "s", key: "b", value: "1234567890")])
        try core.open(account: alice, maxBytes: 5)
        // Still over budget afterwards, but smaller: allowed. Growing is not.
        try core.write([.delete(store: "s", key: "a")])
        XCTAssertEqual(try core.estimate().usedBytes, 10)
        assertCode("STORAGE_BUDGET") { try core.write([.put(store: "s", key: "c", value: "1")]) }
        try core.write([.clear(store: "s")])
        XCTAssertEqual(try core.estimate().usedBytes, 0)
    }

    func testInvalidArgumentsAreRejected() throws {
        let core = makeCore()
        assertCode("INVALID_ARGUMENT") { try core.open(account: alice, maxBytes: -1) }
        assertCode("INVALID_ARGUMENT") { try core.wipe(account: "") }
        try core.open(account: alice)
        assertCode("INVALID_ARGUMENT") { _ = try core.list(store: "s", limit: -1) }
    }

    func testMissingInstallMarkerClearsOrphanSecrets() throws {
        secrets.secrets["left-over-from-a-previous-install"] = Data(repeating: 1, count: 32)
        let core = makeCore()
        try core.open(account: alice)
        XCTAssertEqual(Array(secrets.secrets.keys), [ReplicaStoreCore.accountId(alice)])
        XCTAssertTrue(files().contains(".installed"))
        // With the marker present, a later process keeps existing secrets.
        let later = makeCore()
        try later.open(account: bob)
        XCTAssertEqual(secrets.secrets.count, 2)
    }

    func testFileWithoutSecretStartsOver() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "k", value: "v")])
        core.close()
        secrets.secrets[ReplicaStoreCore.accountId(alice)] = nil
        XCTAssertTrue(try core.open(account: alice).created)
        XCTAssertNil(try core.get(store: "s", key: "k"))
    }

    func testNewerSchemaIsRecreated() throws {
        let core = makeCore()
        try core.open(account: alice)
        try core.write([.put(store: "s", key: "k", value: "v")])
        core.close()
        let db = try SQLiteDB(path: core.databaseURL(account: alice).path)
        try db.exec("PRAGMA user_version=99")
        db.close()
        XCTAssertTrue(try core.open(account: alice).created)
        XCTAssertNil(try core.get(store: "s", key: "k"))
        try core.write([.put(store: "s", key: "k", value: "again")])
        XCTAssertEqual(try core.get(store: "s", key: "k"), "again")
    }

    func testDirectoryIsExcludedFromBackup() throws {
        try makeCore().open(account: alice)
        let values = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    /// The same derivation as the Android implementation: RFC 5869 test case 3 (empty salt and info).
    func testHkdfMatchesRfc5869EmptySalt() {
        let ikm = SymmetricKey(data: Data(repeating: 0x0b, count: 22))
        let okm = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Data(), info: Data(), outputByteCount: 42)
        let hex = okm.withUnsafeBytes { Data($0) }.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
    }
}
