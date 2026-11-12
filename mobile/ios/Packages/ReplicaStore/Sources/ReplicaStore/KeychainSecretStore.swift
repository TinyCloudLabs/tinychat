import Foundation
import Security

/// Account secrets in the Keychain: readable after the first unlock (background sync runs while locked), never
/// backed up or moved to another device (`ThisDeviceOnly`).
public struct KeychainSecretStore: SecretStore {
    public static let service = "xyz.tinycloud.replica"

    public init() {}

    public func load(_ id: String) throws -> Data? {
        var query = baseQuery(id)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Self.error("read", status) }
        return result as? Data
    }

    public func save(_ id: String, _ secret: Data) throws {
        SecItemDelete(baseQuery(id) as CFDictionary)
        var item = baseQuery(id)
        item[kSecValueData as String] = secret
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Self.error("save", status) }
    }

    public func delete(_ id: String) throws {
        let status = SecItemDelete(baseQuery(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.error("delete", status) }
    }

    public func deleteAll() throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: Self.service]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.error("delete", status) }
    }

    /// How many account secrets exist (the simulator smoke checks a sign-out leaves none).
    public func count() -> Int {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: Self.service,
                                    kSecReturnAttributes as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return 0 }
        return (result as? [[String: Any]])?.count ?? 0
    }

    private func baseQuery(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Self.service,
         kSecAttrAccount as String: id]
    }

    private static func error(_ action: String, _ status: OSStatus) -> ReplicaStoreError {
        ReplicaStoreError("IO", "keychain \(action) failed (\(status))")
    }
}
