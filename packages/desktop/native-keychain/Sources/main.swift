import Foundation
import Security
import LocalAuthentication

let service = "local.heed.connectors.v1"
struct VaultRequest {
    let operation: String
    let reference: String
    let value: String?
    init(_ data: Data) throws {
        guard data.count <= 70000,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["service"] as? String == service,
              let operation = json["operation"] as? String, ["get", "put", "remove"].contains(operation),
              let reference = json["reference"] as? String,
              reference.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil
        else { throw VaultFailure.invalidRequest }
        let value = json["value"] as? String
        if operation == "put" {
            guard let value, value.utf8.count <= 65536, let bytes = value.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: bytes, options: .fragmentsAllowed)) != nil
            else { throw VaultFailure.invalidRequest }
        }
        self.operation = operation; self.reference = reference; self.value = value
    }
}
enum VaultFailure: Error { case invalidRequest, unavailable }
func emit(_ value: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: value) { FileHandle.standardOutput.write(bytes) }
}
func operate(_ request: VaultRequest) throws -> [String: Any] {
    let context = LAContext(); context.interactionNotAllowed = true
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: request.reference,
        kSecAttrSynchronizable as String: false, kSecUseAuthenticationContext as String: context]
    switch request.operation {
    case "get":
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecItemNotFound { return ["ok": true, "value": NSNull()] }
        guard status == errSecSuccess, let bytes = result as? Data, bytes.count <= 65536,
              let value = String(data: bytes, encoding: .utf8) else { throw VaultFailure.unavailable }
        return ["ok": true, "value": value]
    case "put":
        let bytes = Data(request.value!.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query; add[kSecValueData as String] = bytes
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw VaultFailure.unavailable }
        return ["ok": true]
    default:
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultFailure.unavailable }
        return ["ok": true]
    }
}
if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
    // Protocol tests deliberately never call Security APIs or access a user's Keychain.
    do {
        let valid: [String: Any] = ["service": service, "operation": "put", "reference": "01234567-89ab-cdef-0123-456789abcdef", "value": "{\"synthetic\":true}"]
        let parsed = try VaultRequest(JSONSerialization.data(withJSONObject: valid))
        guard parsed.operation == "put" else { throw VaultFailure.invalidRequest }
        do { _ = try VaultRequest(Data("{}".utf8)); exit(1) } catch {}
        emit(["ok": true]); exit(0)
    } catch { emit(["ok": false, "error": "self-test-failed"]); exit(1) }
}
guard CommandLine.arguments.count == 1 else { emit(["ok": false, "error": "invalid-request"]); exit(1) }
do {
    var input = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 8192), !chunk.isEmpty {
        input.append(chunk); if input.count > 70000 { throw VaultFailure.invalidRequest }
    }
    let request = try VaultRequest(input)
    emit(try operate(request))
} catch VaultFailure.invalidRequest {
    emit(["ok": false, "error": "invalid-request"]); exit(1)
} catch {
    emit(["ok": false, "error": "unavailable"]); exit(1)
}
