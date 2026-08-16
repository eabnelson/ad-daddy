import Foundation
import Security

private struct PublicJWK: Encodable {
    let kty = "EC"
    let crv = "P-256"
    let x: String
    let y: String
}

private struct CredentialOutput: Encodable {
    let credentialReference: String
    let publicJwk: PublicJWK
}

private struct SignatureOutput: Encodable {
    let signatureDer: String
}

private enum HelperError: Error, CustomStringConvertible {
    case usage(String)
    case security(String, OSStatus)
    case invalid(String)

    var description: String {
        switch self {
        case .usage(let message), .invalid(let message): return message
        case .security(let operation, let status):
            let detail = SecCopyErrorMessageString(status, nil) as String? ?? "unknown Security.framework error"
            return "\(operation) failed (\(status)): \(detail)"
        }
    }
}

@main
private enum AdDaddyDeviceKeyHelper {
    static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let command = arguments.first else { throw HelperError.usage("A helper command is required") }
            let options = try parseOptions(Array(arguments.dropFirst()))
            switch command {
            case "create-or-load":
                let label = try required(options, "label")
                guard label.hasPrefix("com.addaddy.device."), label.count <= 192 else {
                    throw HelperError.invalid("The application label is invalid")
                }
                let privateKey = try createOrLoad(label: label)
                let reference = try persistentReference(for: privateKey)
                let publicJwk = try exportPublicJWK(from: privateKey)
                try emit(CredentialOutput(credentialReference: reference.base64URLEncodedString(), publicJwk: publicJwk))
            case "sign-message":
                let reference = try Data(base64URL: required(options, "credential-reference"))
                let message = try Data(base64URL: required(options, "message"))
                guard !message.isEmpty, message.count <= 16_384 else { throw HelperError.invalid("The signing message is invalid") }
                let privateKey = try loadPrivateKey(reference: reference)
                var error: Unmanaged<CFError>?
                guard let signature = SecKeyCreateSignature(
                    privateKey,
                    .ecdsaSignatureMessageX962SHA256,
                    message as CFData,
                    &error
                ) as Data? else {
                    throw error?.takeRetainedValue() ?? HelperError.invalid("Security.framework could not sign the message")
                }
                try emit(SignatureOutput(signatureDer: signature.base64URLEncodedString()))
            default:
                throw HelperError.usage("Unknown helper command")
            }
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}

private func createOrLoad(label: String) throws -> SecKey {
    let tag = Data(label.utf8)
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrKeyClass: kSecAttrKeyClassPrivate,
        kSecAttrApplicationTag: tag,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
        kSecReturnRef: true,
    ]
    var existing: CFTypeRef?
    let existingStatus = SecItemCopyMatching(query as CFDictionary, &existing)
    if existingStatus == errSecSuccess, let key = existing as! SecKey? { return try requireSecureEnclavePrivateKey(key) }
    guard existingStatus == errSecItemNotFound else { throw HelperError.security("Keychain lookup", existingStatus) }

    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        [.privateKeyUsage],
        &accessError
    ) else {
        throw accessError?.takeRetainedValue() ?? HelperError.invalid("Could not create device-key access control")
    }
    let attributes: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits: 256,
        kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs: [
            kSecAttrIsPermanent: true,
            kSecAttrIsExtractable: false,
            kSecAttrApplicationTag: tag,
            kSecAttrLabel: label,
            kSecAttrAccessControl: access,
        ],
    ]
    var creationError: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &creationError) else {
        throw creationError?.takeRetainedValue() ?? HelperError.invalid("Could not create a non-exportable Secure Enclave key")
    }
    return try requireSecureEnclavePrivateKey(key)
}

private func persistentReference(for key: SecKey) throws -> Data {
    let query: [CFString: Any] = [
        kSecValueRef: key,
        kSecReturnPersistentRef: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let reference = result as? Data else {
        throw HelperError.security("Persistent Keychain reference lookup", status)
    }
    return reference
}

private func loadPrivateKey(reference: Data) throws -> SecKey {
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecValuePersistentRef: reference,
        kSecReturnRef: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let key = result as! SecKey? else {
        throw HelperError.security("Device key lookup", status)
    }
    return try requireSecureEnclavePrivateKey(key)
}

private func requireSecureEnclavePrivateKey(_ key: SecKey) throws -> SecKey {
    guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
          attributes[kSecAttrKeyClass] as? String == kSecAttrKeyClassPrivate as String,
          attributes[kSecAttrKeyType] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
          attributes[kSecAttrTokenID] as? String == kSecAttrTokenIDSecureEnclave as String,
          attributes[kSecAttrKeySizeInBits] as? Int == 256,
          attributes[kSecAttrCanSign] as? Bool == true,
          attributes[kSecAttrIsExtractable] as? Bool == false else {
        throw HelperError.invalid("The stored credential is not a non-exportable Secure Enclave P-256 signing key")
    }
    return key
}

private func exportPublicJWK(from privateKey: SecKey) throws -> PublicJWK {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else { throw HelperError.invalid("Device public key is unavailable") }
    var error: Unmanaged<CFError>?
    guard let bytes = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
        throw error?.takeRetainedValue() ?? HelperError.invalid("Device public key cannot be exported")
    }
    guard bytes.count == 65, bytes.first == 0x04 else { throw HelperError.invalid("Device public key is not P-256 X9.63") }
    return PublicJWK(
        x: bytes.subdata(in: 1..<33).base64URLEncodedString(),
        y: bytes.subdata(in: 33..<65).base64URLEncodedString()
    )
}

private func parseOptions(_ arguments: [String]) throws -> [String: String] {
    guard arguments.count.isMultiple(of: 2) else { throw HelperError.usage("Helper options require values") }
    var output: [String: String] = [:]
    for index in stride(from: 0, to: arguments.count, by: 2) {
        let name = arguments[index]
        guard name.hasPrefix("--"), output[name] == nil else { throw HelperError.usage("Helper option is invalid or duplicated") }
        output[String(name.dropFirst(2))] = arguments[index + 1]
    }
    return output
}

private func required(_ options: [String: String], _ key: String) throws -> String {
    guard let value = options[key], !value.isEmpty else { throw HelperError.usage("--\(key) is required") }
    return value
}

private func emit<T: Encodable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private extension Data {
    init(base64URL: String) throws {
        guard base64URL.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
            throw HelperError.invalid("Base64url input is invalid")
        }
        var base64 = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
        guard let decoded = Data(base64Encoded: base64) else { throw HelperError.invalid("Base64url input is invalid") }
        self = decoded
    }

    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
