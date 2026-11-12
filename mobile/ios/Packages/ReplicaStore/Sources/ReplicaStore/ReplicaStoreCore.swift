import CryptoKit
import Foundation
import SQLite3

/// TC-2862: the device's local copy of TinyCloud data (S1: key-value stores), kept outside the WebView so iOS can't
/// evict it. One SQLite file and one secret per account; every row is sealed (AES-256-GCM, HMAC-opaque keys), the
/// same at-rest design as the SDK's browser replica. The web app talks to it through `ReplicaStorePlugin`; the bridge
/// contract both platforms implement is documented in frontend/src/lib/replication/nativeReplicaStore.ts.
public struct ReplicaStoreError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code): \(message)" }

    static func notOpen() -> ReplicaStoreError { ReplicaStoreError("NOT_OPEN", "no account is open") }
    static func corrupt(_ message: String) -> ReplicaStoreError { ReplicaStoreError("CORRUPT", message) }
}

public enum ReplicaOp: Equatable {
    case put(store: String, key: String, value: String)
    case delete(store: String, key: String)
    case clear(store: String)
}

/// Keeps each account's 32-byte secret. Deleting it makes that account's file unreadable (crypto-shred).
public protocol SecretStore {
    func load(_ id: String) throws -> Data?
    func save(_ id: String, _ secret: Data) throws
    func delete(_ id: String) throws
    func deleteAll() throws
}

public final class ReplicaStoreCore {
    public static let schemaVersion = 1
    static let markerName = ".installed"

    private let directory: URL
    private let secrets: SecretStore
    private let freeBytes: () -> Int64?
    private let lock = NSLock()
    private var current: OpenAccount?
    private var markerChecked = false

    private final class OpenAccount {
        let account: String
        let id: String
        let db: SQLiteDB
        let keys: AccountKeys
        var maxBytes: Int64?

        init(account: String, id: String, db: SQLiteDB, keys: AccountKeys, maxBytes: Int64?) {
            self.account = account
            self.id = id
            self.db = db
            self.keys = keys
            self.maxBytes = maxBytes
        }
    }

    public init(directory: URL, secrets: SecretStore, freeBytes: @escaping () -> Int64? = { nil }) {
        self.directory = directory
        self.secrets = secrets
        self.freeBytes = freeBytes
    }

    /// `Application Support/TinyCloudReplica`: not WebView storage, so WebKit eviction can't reach it.
    public static func defaultDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        return base.appendingPathComponent("TinyCloudReplica", isDirectory: true)
    }

    /// Lowercase hex SHA-256 of the account: the file name and the secret's id. Never the account itself.
    public static func accountId(_ account: String) -> String {
        SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public func databaseURL(account: String) -> URL {
        directory.appendingPathComponent("\(Self.accountId(account)).sqlite")
    }

    // MARK: - Binding

    @discardableResult
    public func open(account: String, maxBytes: Int64? = nil) throws -> (schemaVersion: Int, created: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard !account.isEmpty else { throw ReplicaStoreError("INVALID_ARGUMENT", "account is required") }
        if let open = current, open.account == account {
            open.maxBytes = maxBytes
            return (Self.schemaVersion, false)
        }
        closeLocked()
        try prepareDirectory()
        let id = Self.accountId(account)
        let url = directory.appendingPathComponent("\(id).sqlite")
        var secret = try secrets.load(id)
        if secret == nil {
            // A file without its secret can never be read again: start over.
            deleteFiles(id)
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                throw ReplicaStoreError("IO", "no randomness for the account secret")
            }
            secret = Data(bytes)
            try secrets.save(id, secret!)
        }
        var created = !FileManager.default.fileExists(atPath: url.path)
        var db = try SQLiteDB(path: url.path)
        if try db.userVersion() > Self.schemaVersion {
            // Written by a newer build. It is only a copy of the node's data: drop it and copy again.
            db.close()
            deleteFiles(id)
            db = try SQLiteDB(path: url.path)
            created = true
        }
        do {
            try db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            if try db.userVersion() == 0 {
                try db.exec("""
                    CREATE TABLE IF NOT EXISTS kv(store TEXT NOT NULL, kmac BLOB NOT NULL, sealed BLOB NOT NULL,
                      size INTEGER NOT NULL, PRIMARY KEY(store, kmac)) WITHOUT ROWID;
                    PRAGMA user_version=\(Self.schemaVersion);
                    """)
            }
        } catch {
            db.close()
            throw error
        }
        current = OpenAccount(account: account, id: id, db: db, keys: AccountKeys(secret: secret!), maxBytes: maxBytes)
        return (Self.schemaVersion, created)
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }
        closeLocked()
    }

    /// Closes the account if it is open, then deletes its files and its secret. Safe when nothing exists.
    public func wipe(account: String) throws {
        lock.lock()
        defer { lock.unlock() }
        try prepareDirectory()
        try wipeLocked(Self.accountId(account))
    }

    /// Every account's files and secrets. The install marker stays.
    public func wipeAll() throws {
        lock.lock()
        defer { lock.unlock() }
        closeLocked()
        try prepareDirectory()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name != Self.markerName {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
        try secrets.deleteAll()
    }

    // MARK: - Data

    public func get(store: String, key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        let open = try requireOpen()
        return try readingSealed(open) { try getLocked(open, store: store, key: key) }
    }

    public func getMany(store: String, keys: [String]) throws -> [String?] {
        lock.lock()
        defer { lock.unlock() }
        let open = try requireOpen()
        return try readingSealed(open) { try keys.map { try getLocked(open, store: store, key: $0) } }
    }

    /// Entries whose key starts with `prefix` (UTF-8 bytes), sorted by the key's UTF-8 bytes, then cut to `limit`.
    public func list(store: String, prefix: String? = nil, limit: Int? = nil) throws -> [(key: String, value: String)] {
        lock.lock()
        defer { lock.unlock() }
        let open = try requireOpen()
        return try readingSealed(open) {
            var entries: [(key: String, value: String, bytes: [UInt8])] = []
            let wanted = prefix.map { Array($0.utf8) } ?? []
            try open.db.query("SELECT kmac, sealed FROM kv WHERE store = ?", [.text(store)]) { row in
                let entry = try open.keys.open(store: store, kmac: row.blob(0), sealed: row.blob(1))
                let bytes = Array(entry.key.utf8)
                if bytes.starts(with: wanted) { entries.append((entry.key, entry.value, bytes)) }
            }
            entries.sort { $0.bytes.lexicographicallyPrecedes($1.bytes) }
            let cut = limit.map { Array(entries.prefix(max(0, $0))) } ?? entries
            return cut.map { ($0.key, $0.value) }
        }
    }

    /// All ops in one transaction: every op applies or none does.
    public func write(_ ops: [ReplicaOp]) throws {
        lock.lock()
        defer { lock.unlock() }
        let open = try requireOpen()
        try open.db.exec("BEGIN IMMEDIATE")
        do {
            for op in ops {
                switch op {
                case let .put(store, key, value):
                    try requireStore(store)
                    let kmac = open.keys.kmac(store: store, key: key)
                    let sealed = try open.keys.seal(store: store, key: key, kmac: kmac, value: value)
                    try open.db.run("INSERT OR REPLACE INTO kv(store, kmac, sealed, size) VALUES (?, ?, ?, ?)",
                                    [.text(store), .blob(kmac), .blob(sealed), .int(Int64(value.utf8.count))])
                case let .delete(store, key):
                    try requireStore(store)
                    try open.db.run("DELETE FROM kv WHERE store = ? AND kmac = ?",
                                    [.text(store), .blob(open.keys.kmac(store: store, key: key))])
                case let .clear(store):
                    try requireStore(store)
                    try open.db.run("DELETE FROM kv WHERE store = ?", [.text(store)])
                }
            }
            if let maxBytes = open.maxBytes, try usedBytesLocked(open) > maxBytes {
                throw ReplicaStoreError("STORAGE_BUDGET", "the write would exceed \(maxBytes) bytes")
            }
            try open.db.exec("COMMIT")
        } catch {
            try? open.db.exec("ROLLBACK")
            throw error
        }
    }

    public func estimate() throws -> (usedBytes: Int64, freeBytes: Int64?) {
        lock.lock()
        defer { lock.unlock() }
        let used = try current.map { try usedBytesLocked($0) } ?? 0
        return (used, freeBytes())
    }

    // MARK: - Internals

    private func requireOpen() throws -> OpenAccount {
        guard let open = current else { throw ReplicaStoreError.notOpen() }
        return open
    }

    private func requireStore(_ store: String) throws {
        if store.isEmpty { throw ReplicaStoreError("INVALID_ARGUMENT", "store is required") }
    }

    private func getLocked(_ open: OpenAccount, store: String, key: String) throws -> String? {
        let kmac = open.keys.kmac(store: store, key: key)
        var value: String?
        try open.db.query("SELECT sealed FROM kv WHERE store = ? AND kmac = ?", [.text(store), .blob(kmac)]) { row in
            let entry = try open.keys.open(store: store, kmac: kmac, sealed: row.blob(0))
            guard entry.key == key else { throw ReplicaStoreError.corrupt("row key does not match") }
            value = entry.value
        }
        return value
    }

    /// A row that fails authentication means the file was tampered with or damaged: wipe the account and report it.
    private func readingSealed<T>(_ open: OpenAccount, _ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let error as ReplicaStoreError where error.code == "CORRUPT" {
            try? wipeLocked(open.id)
            throw error
        }
    }

    private func usedBytesLocked(_ open: OpenAccount) throws -> Int64 {
        var total: Int64 = 0
        try open.db.query("SELECT COALESCE(SUM(size), 0) FROM kv", []) { row in total = row.int(0) }
        return total
    }

    private func closeLocked() {
        current?.db.close()
        current = nil
    }

    private func wipeLocked(_ id: String) throws {
        if current?.id == id { closeLocked() }
        deleteFiles(id)
        try secrets.delete(id)
    }

    private func deleteFiles(_ id: String) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(id).sqlite\(suffix)"))
        }
    }

    /// Creates the directory (excluded from backup; readable after first unlock so background sync can run while
    /// locked). Keychain items outlive an app's deletion, so a missing install marker means the secrets left in the
    /// Keychain belong to a previous install: delete them.
    private func prepareDirectory() throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: directory.path) {
            var attributes: [FileAttributeKey: Any] = [:]
            #if os(iOS)
            attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
            #endif
            try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
        }
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var url = directory
        try? url.setResourceValues(excluded)
        guard !markerChecked else { return }
        let marker = directory.appendingPathComponent(Self.markerName)
        if !manager.fileExists(atPath: marker.path) {
            try secrets.deleteAll()
            guard manager.createFile(atPath: marker.path, contents: Data()) else {
                throw ReplicaStoreError("IO", "cannot create the install marker")
            }
        }
        markerChecked = true
    }
}

// MARK: - Crypto

/// Per-account keys: `encKey`/`macKey` are HKDF-SHA256 of the account secret (empty salt).
struct AccountKeys {
    static let label = Data("tc-replica/v1".utf8)
    let enc: SymmetricKey
    let mac: SymmetricKey

    init(secret: Data) {
        let ikm = SymmetricKey(data: secret)
        enc = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Data(), info: Data("tc-replica/v1/enc".utf8),
                                     outputByteCount: 32)
        mac = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Data(), info: Data("tc-replica/v1/mac".utf8),
                                     outputByteCount: 32)
    }

    /// The lookup column: HMAC(store ‖ 0 ‖ key). The key itself is stored only inside the sealed row.
    func kmac(store: String, key: String) -> Data {
        var message = Data(store.utf8)
        message.append(0)
        message.append(contentsOf: key.utf8)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: mac))
    }

    /// nonce(12) ‖ ciphertext ‖ tag(16) of `uint32BE(len key) ‖ key ‖ value`, bound to the store and row.
    func seal(store: String, key: String, kmac: Data, value: String) throws -> Data {
        let keyBytes = Data(key.utf8)
        var plaintext = Data()
        withUnsafeBytes(of: UInt32(keyBytes.count).bigEndian) { plaintext.append(contentsOf: $0) }
        plaintext.append(keyBytes)
        plaintext.append(contentsOf: value.utf8)
        let box = try AES.GCM.seal(plaintext, using: enc, authenticating: Self.aad(store: store, kmac: kmac))
        guard let combined = box.combined else { throw ReplicaStoreError("IO", "cannot seal a row") }
        return combined
    }

    func open(store: String, kmac: Data, sealed: Data) throws -> (key: String, value: String) {
        let plaintext: Data
        do {
            let box = try AES.GCM.SealedBox(combined: sealed)
            plaintext = try AES.GCM.open(box, using: enc, authenticating: Self.aad(store: store, kmac: kmac))
        } catch {
            throw ReplicaStoreError.corrupt("a row failed authentication")
        }
        let bytes = [UInt8](plaintext)
        guard bytes.count >= 4 else { throw ReplicaStoreError.corrupt("a row is truncated") }
        let length = Int(UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3]))
        guard bytes.count >= 4 + length,
              let key = String(bytes: bytes[4..<(4 + length)], encoding: .utf8),
              let value = String(bytes: bytes[(4 + length)...], encoding: .utf8)
        else { throw ReplicaStoreError.corrupt("a row is malformed") }
        return (key, value)
    }

    static func aad(store: String, kmac: Data) -> Data {
        var aad = label
        aad.append(0)
        aad.append(contentsOf: store.utf8)
        aad.append(0)
        aad.append(kmac)
        return aad
    }
}

// MARK: - SQLite

enum SQLiteBind {
    case text(String)
    case blob(Data)
    case int(Int64)
}

struct SQLiteRow {
    let statement: OpaquePointer

    func blob(_ column: Int32) -> Data {
        let count = Int(sqlite3_column_bytes(statement, column))
        guard count > 0, let pointer = sqlite3_column_blob(statement, column) else { return Data() }
        return Data(bytes: pointer, count: count)
    }

    func int(_ column: Int32) -> Int64 { sqlite3_column_int64(statement, column) }
}

final class SQLiteDB {
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private var handle: OpaquePointer?

    init(path: String) throws {
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        #if os(iOS)
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION
        #endif
        let code = sqlite3_open_v2(path, &handle, flags, nil)
        guard code == SQLITE_OK else {
            let error = Self.error(handle, code)
            sqlite3_close(handle)
            handle = nil
            throw error
        }
    }

    deinit { close() }

    func close() {
        if let handle { sqlite3_close_v2(handle) }
        handle = nil
    }

    func exec(_ sql: String) throws {
        let code = sqlite3_exec(handle, sql, nil, nil, nil)
        guard code == SQLITE_OK else { throw Self.error(handle, code) }
    }

    func userVersion() throws -> Int {
        var version: Int64 = 0
        try query("PRAGMA user_version", []) { version = $0.int(0) }
        return Int(version)
    }

    func run(_ sql: String, _ binds: [SQLiteBind]) throws {
        try query(sql, binds) { _ in }
    }

    func query(_ sql: String, _ binds: [SQLiteBind], _ row: (SQLiteRow) throws -> Void) throws {
        var statement: OpaquePointer?
        var code = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard code == SQLITE_OK, let statement else { throw Self.error(handle, code) }
        defer { sqlite3_finalize(statement) }
        for (offset, bind) in binds.enumerated() {
            let index = Int32(offset + 1)
            switch bind {
            case let .text(text): code = sqlite3_bind_text(statement, index, text, -1, Self.transient)
            case let .int(value): code = sqlite3_bind_int64(statement, index, value)
            case let .blob(data):
                code = data.withUnsafeBytes {
                    sqlite3_bind_blob(statement, index, $0.baseAddress, Int32(data.count), Self.transient)
                }
            }
            guard code == SQLITE_OK else { throw Self.error(handle, code) }
        }
        while true {
            code = sqlite3_step(statement)
            if code == SQLITE_ROW { try row(SQLiteRow(statement: statement)); continue }
            if code == SQLITE_DONE { return }
            throw Self.error(handle, code)
        }
    }

    private static func error(_ handle: OpaquePointer?, _ code: Int32) -> ReplicaStoreError {
        let message = handle.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) } ?? "sqlite error \(code)"
        return ReplicaStoreError(code & 0xff == SQLITE_FULL ? "STORAGE_FULL" : "IO", message)
    }
}
